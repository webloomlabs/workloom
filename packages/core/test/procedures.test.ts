import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Procedure-level guarantees, run against every registered procedure.
 *
 *   1. Every mutation writes at least one audit entry.
 *   2. No procedure lets one organization reach another's records.
 *   3. Every procedure refuses an actor lacking its permission.
 *
 * Coverage is enforced, not hoped for: the fixture table below must name every
 * mutation in the registry, so adding one without deciding how to exercise it
 * fails this file.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')

const ORG_A = '01a0a400-0000-7000-8000-00000000000a'
const ORG_B = '01a0a400-0000-7000-8000-00000000000b'
let ownerA: string
let ownerB: string
let developerA: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  await import('../src/modules/index.ts')

  ownerA = core.newId()
  ownerB = core.newId()
  developerA = core.newId()

  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug) values
        (${ORG_A}::uuid, 'Org A', 'org-a'), (${ORG_B}::uuid, 'Org B', 'org-b')`)
    await db.execute(sql`
      insert into "user" (id, name, email) values
        (${ownerA}::uuid, 'Owner A', 'a@example.com'),
        (${ownerB}::uuid, 'Owner B', 'b@example.com'),
        (${developerA}::uuid, 'Dev A', 'dev-a@example.com')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role) values
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, 'owner'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${developerA}::uuid, 'developer'),
        (${core.newId()}::uuid, ${ORG_B}::uuid, ${ownerB}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

function asOwner(organizationId: string, userId: string) {
  return {
    organizationId,
    actor: { type: 'user' as const, id: userId, label: 'owner' },
    role: 'owner' as const,
    permissions: core.permissionsForRole('owner'),
  }
}

function run(name: string, actor: ReturnType<typeof asOwner>, input: unknown) {
  return registry.executeProcedure(name, { ...actor, input })
}

async function auditCount(organizationId: string): Promise<number> {
  const { rows } = await mod.withTenant(organizationId, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_logs`),
  )
  return rows[0]!.n
}

/**
 * How to exercise each mutation against org A. Returning the input lets one
 * fixture create what the next one acts on.
 */
const MUTATIONS: Record<string, () => Promise<unknown>> = {
  'organization.update': async () => ({ name: 'Org A (renamed)' }),
  'apiKey.create': async () => ({ name: 'fixture key' }),
  'apiKey.revoke': async () => {
    const created = (await run('apiKey.create', asOwner(ORG_A, ownerA), {
      name: 'to revoke',
    })) as { key: { id: string } }
    return { id: created.key.id }
  },
  'member.remove': async () => ({ userId: developerA }),
}

describe('audit coverage', () => {
  it('has a fixture for every mutation in the registry', () => {
    const mutations = registry
      .allProcedures()
      .filter((p) => !p.readOnly)
      .map((p) => p.name)
      .sort()
    expect(Object.keys(MUTATIONS).sort()).toEqual(mutations)
  })

  it.each(Object.keys(MUTATIONS))('%s writes an audit entry', async (name) => {
    const input = await MUTATIONS[name]!()
    const before = await auditCount(ORG_A)
    await run(name, asOwner(ORG_A, ownerA), input)
    expect(await auditCount(ORG_A)).toBeGreaterThan(before)
  })
})

describe('cross-tenant access through procedures', () => {
  it('cannot revoke another organization\'s API key', async () => {
    const created = (await run('apiKey.create', asOwner(ORG_A, ownerA), {
      name: 'belongs to A',
    })) as { key: { id: string } }

    // Owner of B, full permissions in B, targeting A's key by id. The answer
    // must be "not found" -- not "forbidden", which would confirm it exists.
    await expect(
      run('apiKey.revoke', asOwner(ORG_B, ownerB), { id: created.key.id }),
    ).rejects.toBeInstanceOf(core.NotFoundError)

    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ revoked_at: string | null }>(
        sql`select revoked_at from api_keys where id = ${created.key.id}::uuid`,
      ),
    )
    expect(rows[0]?.revoked_at).toBeNull()
  })

  it('lists only the acting organization\'s API keys', async () => {
    await run('apiKey.create', asOwner(ORG_B, ownerB), { name: 'belongs to B' })
    const listed = (await run('apiKey.list', asOwner(ORG_A, ownerA), {})) as {
      data: Array<{ name: string }>
    }
    expect(listed.data.map((k) => k.name)).not.toContain('belongs to B')
  })

  it('cannot remove a member of another organization', async () => {
    const result = await run('member.remove', asOwner(ORG_B, ownerB), { userId: ownerA })
    expect(result).toEqual({ removed: false })

    const { rows } = await mod.withoutTenant('test: check membership', (db) =>
      db.execute(sql`select 1 from member where user_id = ${ownerA}::uuid and organization_id = ${ORG_A}::uuid`),
    )
    expect(rows).toHaveLength(1)
  })

  it('shows only the acting organization\'s audit log', async () => {
    const listed = (await run('auditLog.list', asOwner(ORG_B, ownerB), {})) as {
      data: Array<{ entityLabel: string | null }>
    }
    expect(listed.data.map((e) => e.entityLabel)).not.toContain('belongs to A')
  })
})

describe('authorisation', () => {
  it('refuses every permission-gated procedure to an actor without the permission', async () => {
    const nobody = {
      organizationId: ORG_A,
      actor: { type: 'user' as const, id: ownerA, label: 'no permissions' },
      role: null,
      permissions: new Set<never>(),
    }
    for (const procedure of registry.allProcedures()) {
      if (procedure.permission === 'authenticated') continue
      await expect(
        registry.executeProcedure(procedure.name, { ...nobody, input: {} }),
        procedure.name,
      ).rejects.toBeInstanceOf(core.ForbiddenError)
    }
  })
})

describe('member.remove', () => {
  it('refuses to remove the last owner', async () => {
    await expect(
      run('member.remove', asOwner(ORG_B, ownerB), { userId: ownerB }),
    ).rejects.toMatchObject({ name: 'DomainError', code: 'last_owner' })
  })
})
