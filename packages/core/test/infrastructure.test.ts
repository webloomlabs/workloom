import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Infrastructure, and the documents filed against a client.
 *
 * The renewal sweep is what this module exists for, so that is what is
 * asserted: each approaching date is announced once, a renewal arms it again,
 * and a date that has passed marks the asset expired. Documents are here
 * because they are the other half of a client's own records; the round trip
 * through storage is what their test is for.
 *
 * Generic guarantees (audit, events, cross-tenant 404s, permission refusal) are
 * covered for every procedure in procedures.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')

const ORG = '01a0ee00-0000-7000-8000-00000000000a'
let owner: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')

  owner = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone) values
        (${ORG}::uuid, 'Infra Co', 'infra-co', 'AUD', 'UTC')`)
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}::uuid, 'Owner', 'i-owner@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values (${core.newId()}::uuid, ${ORG}::uuid, ${owner}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

const actor = () => ({
  organizationId: ORG,
  actor: { type: 'user' as const, id: owner, label: 'owner' },
  role: 'owner' as const,
  permissions: core.permissionsForRole('owner'),
})

function run<T = any>(name: string, input: unknown, now?: Date): Promise<T> {
  return registry.executeProcedure(name, { ...actor(), input, ...(now ? { now } : {}) }) as Promise<T>
}

/** The worker's renewal sweep, as a job actor with no permissions of its own. */
function sweep(now: Date): Promise<number> {
  return mod.withTenant(ORG, (tx) =>
    modules.sweepExpiringAssets(
      registry.buildContext({ organizationId: ORG, actor: { type: 'job', label: 'expiring infrastructure' }, role: null, permissions: new Set(), now }, tx),
    ),
  )
}

async function eventsFor(assetId: string): Promise<string[]> {
  const { rows } = await mod.withTenant(ORG, (tx) =>
    tx.execute<{ type: string }>(sql`
      select type from events
       where data ->> 'id' = ${assetId}
       order by id`),
  )
  return rows.map((r) => r.type)
}

const unique = () => core.newId().slice(-8)
const company = async () => (await run('company.create', { name: `Client ${unique()}` })).id as string
const on = (date: string) => new Date(`${date}T09:00:00Z`)

describe('infrastructure', () => {
  it('counts the days to a renewal', async () => {
    const asset = await run('infrastructureAsset.create', { name: `a-${unique()}.test`, kind: 'domain', expiresOn: '2026-03-31' }, on('2026-03-01'))
    expect(asset.daysUntilExpiry).toBe(30)

    const past = await run('infrastructureAsset.get', { id: asset.id }, on('2026-04-10'))
    expect(past.daysUntilExpiry).toBe(-10)
  })

  it('announces an approaching renewal once', async () => {
    const asset = await run('infrastructureAsset.create', { name: `b-${unique()}.test`, kind: 'domain', expiresOn: '2026-03-20' }, on('2026-03-01'))

    await sweep(on('2026-03-01'))
    expect(await eventsFor(asset.id)).toEqual(['infrastructure_asset.created', 'infrastructure_asset.expiring'])

    // An hourly worker must not send the same warning every hour.
    await sweep(on('2026-03-02'))
    await sweep(on('2026-03-03'))
    expect((await eventsFor(asset.id)).filter((t) => t === 'infrastructure_asset.expiring')).toHaveLength(1)
  })

  it('announces again once the renewal moves', async () => {
    const asset = await run('infrastructureAsset.create', { name: `c-${unique()}.test`, kind: 'domain', expiresOn: '2026-03-20' }, on('2026-03-01'))
    await sweep(on('2026-03-01'))

    // Renewed for a year, then approaching again the following March.
    await run('infrastructureAsset.update', { id: asset.id, expiresOn: '2027-03-20' })
    await sweep(on('2026-03-02'))
    expect((await eventsFor(asset.id)).filter((t) => t === 'infrastructure_asset.expiring')).toHaveLength(1)

    await sweep(on('2027-03-01'))
    expect((await eventsFor(asset.id)).filter((t) => t === 'infrastructure_asset.expiring')).toHaveLength(2)
  })

  it('marks an asset expired once its date has passed', async () => {
    const asset = await run('infrastructureAsset.create', { name: `d-${unique()}.test`, kind: 'ssl_certificate', expiresOn: '2026-03-10' }, on('2026-03-01'))
    await sweep(on('2026-03-11'))

    const after = await run('infrastructureAsset.get', { id: asset.id }, on('2026-03-11'))
    expect(after.status).toBe('expired')
    expect(await eventsFor(asset.id)).toContain('infrastructure_asset.expired')
  })

  it('leaves what is decommissioned alone', async () => {
    const asset = await run('infrastructureAsset.create', { name: `e-${unique()}.test`, kind: 'server', expiresOn: '2026-03-10' }, on('2026-03-01'))
    await run('infrastructureAsset.update', { id: asset.id, status: 'decommissioned' })
    await sweep(on('2026-03-11'))
    expect(await eventsFor(asset.id)).not.toContain('infrastructure_asset.expiring')
  })

  it('finds what is expiring soonest first', async () => {
    const companyId = await company()
    const later = await run('infrastructureAsset.create', { companyId, name: `f-${unique()}.test`, expiresOn: '2026-05-01' }, on('2026-04-01'))
    const sooner = await run('infrastructureAsset.create', { companyId, name: `g-${unique()}.test`, expiresOn: '2026-04-10' }, on('2026-04-01'))
    await run('infrastructureAsset.create', { companyId, name: `h-${unique()}.test`, expiresOn: '2027-01-01' }, on('2026-04-01'))

    const listed = await run('infrastructureAsset.list', { companyId, expiringWithinDays: 45 }, on('2026-04-01'))
    expect(listed.data.map((a: { id: string }) => a.id)).toEqual([sooner.id, later.id])
  })

  it('insists a renewal cost names its currency', async () => {
    await expect(run('infrastructureAsset.create', { name: `i-${unique()}.test`, renewalCostMinor: 2500 })).rejects.toMatchObject({
      code: 'currency_required',
    })
  })
})

describe('documents', () => {
  const aFile = () => new File([`a signed contract ${unique()}`], 'contract.pdf', { type: 'application/pdf' })

  it('files a document, and hands back a link that downloads it', async () => {
    const companyId = await company()
    const document = await run('document.upload', { companyId, file: aFile(), title: 'Master services agreement', category: 'contract' })
    expect(document.sizeBytes).toBeGreaterThan(0)
    expect(document.filename).toBe('contract.pdf')

    const link = await run('document.download', { id: document.id })
    expect(link.filename).toBe('contract.pdf')
    expect(link.url).toBeTruthy()
  })

  it('refuses a project belonging to a different client', async () => {
    const [a, b] = [await company(), await company()]
    const project = await run('project.create', { name: `Project ${unique()}`, companyId: b })
    await expect(run('document.upload', { companyId: a, file: aFile(), projectId: project.id })).rejects.toMatchObject({
      code: 'project_company_mismatch',
    })
  })

  it('takes the filename as the title when none is given', async () => {
    const document = await run('document.upload', { companyId: await company(), file: aFile() })
    expect(document.title).toBe('contract.pdf')
  })

  it('refuses an empty file', async () => {
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' })
    await expect(run('document.upload', { companyId: await company(), file: empty })).rejects.toMatchObject({ code: 'file_empty' })
  })
})
