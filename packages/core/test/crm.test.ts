import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * CRM behaviour: the lead-to-client lifecycle and the rules around it.
 *
 * The generic guarantees -- audit, events, cross-tenant 404s, permission
 * refusal -- are covered for every procedure in procedures.test.ts. This file
 * is about what the CRM does.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')

const ORG_A = '01a0a500-0000-7000-8000-00000000000a'
const ORG_B = '01a0a500-0000-7000-8000-00000000000b'
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
      insert into organization (id, name, slug, base_currency) values
        (${ORG_A}::uuid, 'Org A', 'crm-a', 'AUD'), (${ORG_B}::uuid, 'Org B', 'crm-b', 'USD')`)
    await db.execute(sql`
      insert into "user" (id, name, email) values
        (${ownerA}::uuid, 'Owner A', 'crm-a@example.com'),
        (${ownerB}::uuid, 'Owner B', 'crm-b@example.com'),
        (${developerA}::uuid, 'Dev A', 'crm-dev@example.com')`)
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

type Actor = {
  organizationId: string
  actor: { type: 'user'; id: string; label: string }
  role: 'owner' | 'developer' | null
  permissions: ReadonlySet<import('../src/index.ts').Permission>
}

const asA = (): Actor => ({
  organizationId: ORG_A,
  actor: { type: 'user', id: ownerA, label: 'Owner A' },
  role: 'owner',
  permissions: core.permissionsForRole('owner'),
})
const asB = (): Actor => ({
  organizationId: ORG_B,
  actor: { type: 'user', id: ownerB, label: 'Owner B' },
  role: 'owner',
  permissions: core.permissionsForRole('owner'),
})
const asDeveloper = (): Actor => ({
  organizationId: ORG_A,
  actor: { type: 'user', id: developerA, label: 'Dev A' },
  role: 'developer',
  permissions: core.permissionsForRole('developer'),
})

function run<T = any>(name: string, actor: Actor, input: unknown): Promise<T> {
  return registry.executeProcedure(name, { ...actor, input }) as Promise<T>
}

const unique = () => core.newId().slice(-8)

async function count(table: string, where = sql`true`, organizationId = ORG_A): Promise<number> {
  const { rows } = await mod.withTenant(organizationId, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${where}`),
  )
  return rows[0]!.n
}

async function eventsSince(marker: number, organizationId = ORG_A): Promise<string[]> {
  const { rows } = await mod.withTenant(organizationId, (tx) =>
    tx.execute<{ type: string }>(sql`select type from events order by occurred_at, id offset ${marker}`),
  )
  return rows.map((r) => r.type)
}

describe('lead conversion', () => {
  it('turns a lead into a client company and contact, carrying its history along', async () => {
    const email = `jane-${unique()}@acme.example`
    const lead = await run('lead.create', asA(), {
      contactName: 'Jane van Doe',
      companyName: `Acme ${unique()}`,
      email,
      phone: '+61 400 000 000',
      website: 'acme.example',
      source: 'website',
    })
    const note = await run('activity.create', asA(), { leadId: lead.id, type: 'call', body: 'Wants a new site' })
    const marker = await count('events')

    const result = await run('lead.convert', asA(), { id: lead.id })

    expect(result.company).toMatchObject({
      name: lead.companyName,
      website: 'https://acme.example',
      lifecycleStage: 'client',
      ownerId: ownerA,
    })
    expect(result.company.becameClientAt).toBeInstanceOf(Date)
    expect(result.company.lastActivityAt).toBeInstanceOf(Date)
    expect(result.contact).toMatchObject({
      firstName: 'Jane',
      lastName: 'van Doe',
      email,
      companyId: result.company.id,
    })
    expect(result.deal).toBeNull()
    expect(result.lead).toMatchObject({
      status: 'converted',
      convertedCompanyId: result.company.id,
      convertedContactId: result.contact.id,
      convertedDealId: null,
    })

    // The call logged against the lead now appears on the company and contact.
    const companyTimeline = await run('activity.list', asA(), { companyId: result.company.id })
    expect(companyTimeline.data.map((a: { id: string }) => a.id)).toEqual([note.id])
    const contactTimeline = await run('activity.list', asA(), { contactId: result.contact.id })
    expect(contactTimeline.data).toHaveLength(1)

    expect(await eventsSince(marker)).toEqual([
      'company.created',
      'company.became_client',
      'contact.created',
      'lead.converted',
    ])
  })

  it('with a deal, leaves the company a prospect until the deal is won', async () => {
    const lead = await run('lead.create', asA(), { companyName: `Beta ${unique()}`, contactName: 'Bo' })
    const result = await run('lead.convert', asA(), {
      id: lead.id,
      deal: { name: 'Website rebuild', valueMinor: 1_250_050, expectedCloseDate: '2026-12-01' },
    })

    expect(result.company.lifecycleStage).toBe('prospect')
    expect(result.deal).toMatchObject({
      name: 'Website rebuild',
      stage: 'qualified',
      valueMinor: 1_250_050,
      currency: 'AUD',
      companyId: result.company.id,
      contactId: result.contact.id,
      contactName: 'Bo',
    })

    const won = await run('deal.changeStage', asA(), { id: result.deal.id, stage: 'won' })
    expect(won).toMatchObject({ stage: 'won', previousStage: 'qualified' })
    expect(won.closedAt).toBeInstanceOf(Date)

    const company = await run('company.get', asA(), { id: result.company.id })
    expect(company.lifecycleStage).toBe('client')
    expect(company.becameClientAt).toBeInstanceOf(Date)
  })

  it('reuses an existing contact with the same email instead of duplicating them', async () => {
    const email = `repeat-${unique()}@example.com`
    const existing = await run('contact.create', asA(), { firstName: 'Repeat', email })
    const lead = await run('lead.create', asA(), { contactName: 'Repeat Customer', email: email.toUpperCase() })

    const result = await run('lead.convert', asA(), { id: lead.id })

    expect(result.contact.id).toBe(existing.id)
    // The contact had no company, so it joins the new one.
    expect(result.contact.companyId).toBe(result.company.id)
    expect(await count('contacts', sql`lower(email) = ${email}`)).toBe(1)
  })

  it('attaches to an existing company, making it a client', async () => {
    const company = await run('company.create', asA(), { name: `Existing ${unique()}` })
    const lead = await run('lead.create', asA(), { contactName: 'New Person' })
    const before = await count('companies')

    const result = await run('lead.convert', asA(), { id: lead.id, companyId: company.id })

    expect(result.company).toMatchObject({ id: company.id, lifecycleStage: 'client' })
    expect(await count('companies')).toBe(before)
  })

  it('refuses to convert a lead twice', async () => {
    const lead = await run('lead.create', asA(), { companyName: `Twice ${unique()}` })
    await run('lead.convert', asA(), { id: lead.id })
    await expect(run('lead.convert', asA(), { id: lead.id })).rejects.toMatchObject({ code: 'lead_converted' })
    await expect(run('lead.update', asA(), { id: lead.id, phone: '1' })).rejects.toMatchObject({
      code: 'lead_converted',
    })
  })

  it('converts once when two requests race', async () => {
    const companyName = `Race ${unique()}`
    const lead = await run('lead.create', asA(), { companyName })

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => run('lead.convert', asA(), { id: lead.id })),
    )

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'lead_converted' })
    }
    expect(await count('companies', sql`name = ${companyName}`)).toBe(1)
  })

  it('rolls back everything when a later step fails', async () => {
    const companyName = `Rollback ${unique()}`
    const lead = await run('lead.create', asA(), { companyName })
    const otherOrgsContact = await run('contact.create', asB(), { firstName: 'Not yours' })
    const marker = await count('events')

    // The company is created before the contact is looked up; the lookup fails.
    await expect(
      run('lead.convert', asA(), { id: lead.id, contactId: otherOrgsContact.id }),
    ).rejects.toBeInstanceOf(core.NotFoundError)

    expect(await count('companies', sql`name = ${companyName}`)).toBe(0)
    expect((await run('lead.get', asA(), { id: lead.id })).status).toBe('new')
    expect(await eventsSince(marker)).toEqual([])
  })

  it('does not let a key scoped to lead:convert create records it has no permission for', async () => {
    const lead = await run('lead.create', asA(), { companyName: `Scoped ${unique()}` })
    const narrow: Actor = { ...asA(), permissions: new Set(['lead:convert', 'lead:read']) }

    await expect(run('lead.convert', narrow, { id: lead.id })).rejects.toBeInstanceOf(core.ForbiddenError)
    expect((await run('lead.get', asA(), { id: lead.id })).status).toBe('new')
  })

  it('refuses a disqualified lead until it is reopened', async () => {
    const lead = await run('lead.create', asA(), { companyName: `Dq ${unique()}` })
    const dq = await run('lead.changeStatus', asA(), { id: lead.id, status: 'disqualified', reason: 'No budget' })
    expect(dq).toMatchObject({ status: 'disqualified', disqualifiedReason: 'No budget', previousStatus: 'new' })

    await expect(run('lead.convert', asA(), { id: lead.id })).rejects.toMatchObject({ code: 'lead_disqualified' })

    const reopened = await run('lead.changeStatus', asA(), { id: lead.id, status: 'qualified' })
    expect(reopened.disqualifiedReason).toBeNull()
    await expect(run('lead.convert', asA(), { id: lead.id })).resolves.toBeDefined()
  })
})

describe('leads', () => {
  it('must identify someone', async () => {
    await expect(run('lead.create', asA(), { phone: '123', source: 'phone' })).rejects.toBeInstanceOf(ZodError)
  })

  it('cannot be set to converted except by converting', async () => {
    const lead = await run('lead.create', asA(), { contactName: 'Status' })
    await expect(run('lead.changeStatus', asA(), { id: lead.id, status: 'converted' })).rejects.toBeInstanceOf(
      ZodError,
    )
  })
})

describe('contacts', () => {
  it('allows one live contact per email address, ignoring case', async () => {
    const email = `dup-${unique()}@example.com`
    await run('contact.create', asA(), { firstName: 'One', email })
    await expect(
      run('contact.create', asA(), { firstName: 'Two', email: email.toUpperCase() }),
    ).rejects.toMatchObject({ code: 'duplicate_email', field: 'email' })

    // A different organization may have the same person.
    await expect(run('contact.create', asB(), { firstName: 'Same', email })).resolves.toBeDefined()
  })

  it('frees an archived contact\'s email, and refuses to restore it over a new one', async () => {
    const email = `archived-${unique()}@example.com`
    const first = await run('contact.create', asA(), { firstName: 'First', email })
    await run('contact.archive', asA(), { id: first.id })
    await run('contact.create', asA(), { firstName: 'Second', email })

    await expect(run('contact.restore', asA(), { id: first.id })).rejects.toMatchObject({ code: 'duplicate_email' })
  })

  it('cannot belong to another organization\'s company, even written directly', async () => {
    // The composite foreign key refuses it below the application: org B's row
    // pointing at org A's company id matches no (organization_id, id) pair.
    const company = await run('company.create', asA(), { name: `FK ${unique()}` })
    const error = await mod
      .withTenant(ORG_B, (tx) =>
        tx.execute(sql`insert into contacts (id, organization_id, company_id, first_name)
          values (${core.newId()}::uuid, ${ORG_B}::uuid, ${company.id}::uuid, 'Sneaky')`),
      )
      .catch((e: unknown) => e)
    expect(String((error as { cause?: unknown }).cause ?? error)).toMatch(/foreign key/i)
  })

  it('refuses an owner from outside the organization', async () => {
    await expect(run('contact.create', asA(), { firstName: 'Owned', ownerId: ownerB })).rejects.toMatchObject({
      code: 'owner_not_member',
    })
  })
})

describe('companies', () => {
  it('stores only http(s) websites, since they are rendered as links', async () => {
    for (const website of ['javascript:alert(1)', 'data:text/html,hi', 'not a site']) {
      await expect(run('company.create', asA(), { name: 'Bad site', website }), website).rejects.toBeInstanceOf(
        ZodError,
      )
    }
    const ok = await run('company.create', asA(), { name: 'Good site', website: 'www.example.com/about' })
    expect(ok.website).toBe('https://www.example.com/about')
  })

  it('cannot be archived with open deals, and archived ones drop out of lists', async () => {
    const name = `Archivable ${unique()}`
    const company = await run('company.create', asA(), { name })
    const deal = await run('deal.create', asA(), { companyId: company.id, name: 'Open' })

    await expect(run('company.archive', asA(), { id: company.id })).rejects.toMatchObject({ code: 'has_open_deals' })

    await run('deal.changeStage', asA(), { id: deal.id, stage: 'lost' })
    await run('company.archive', asA(), { id: company.id })

    expect((await run('company.list', asA(), { q: name })).data).toHaveLength(0)
    expect((await run('company.list', asA(), { q: name, includeArchived: 'true' })).data).toHaveLength(1)
    await expect(run('deal.create', asA(), { companyId: company.id, name: 'Late' })).rejects.toMatchObject({
      code: 'archived',
    })
  })

  it('treats search wildcards literally', async () => {
    const tag = unique()
    await run('company.create', asA(), { name: `100% Pure ${tag}` })
    await run('company.create', asA(), { name: `Plain ${tag}` })
    const found = await run('company.list', asA(), { q: `% Pure ${tag}` })
    expect(found.data.map((c: { name: string }) => c.name)).toEqual([`100% Pure ${tag}`])
    expect((await run('company.list', asA(), { q: '%%%%' })).data).toHaveLength(0)
  })

  it('pages with a cursor, newest first', async () => {
    const tag = unique()
    for (const n of [1, 2, 3]) await run('company.create', asA(), { name: `Paged ${tag} ${n}` })
    const first = await run('company.list', asA(), { q: `Paged ${tag}`, limit: '2' })
    expect(first.data.map((c: { name: string }) => c.name)).toEqual([`Paged ${tag} 3`, `Paged ${tag} 2`])
    const second = await run('company.list', asA(), { q: `Paged ${tag}`, limit: '2', cursor: first.nextCursor })
    expect(second.data.map((c: { name: string }) => c.name)).toEqual([`Paged ${tag} 1`])
    expect(second.nextCursor).toBeNull()
  })
})

describe('deals', () => {
  it('reopens cleanly and keeps a lost reason only while lost', async () => {
    const company = await run('company.create', asA(), { name: `Stages ${unique()}` })
    const deal = await run('deal.create', asA(), { companyId: company.id, name: 'Stages' })

    const lost = await run('deal.changeStage', asA(), { id: deal.id, stage: 'lost', lostReason: 'Price' })
    expect(lost).toMatchObject({ stage: 'lost', lostReason: 'Price' })

    const reopened = await run('deal.changeStage', asA(), { id: deal.id, stage: 'negotiation' })
    expect(reopened).toMatchObject({ stage: 'negotiation', closedAt: null, lostReason: null })

    await expect(
      run('deal.changeStage', asA(), { id: deal.id, stage: 'won', lostReason: 'nonsense' }),
    ).rejects.toBeInstanceOf(ZodError)
    // Losing a deal does not demote anyone: the company never became a client.
    expect((await run('company.get', asA(), { id: company.id })).lifecycleStage).toBe('prospect')
  })

  it('totals the pipeline per currency, without converting', async () => {
    const company = await run('company.create', asB(), { name: 'Pipeline' })
    await run('deal.create', asB(), { companyId: company.id, name: 'USD 1', valueMinor: 100_00 })
    await run('deal.create', asB(), { companyId: company.id, name: 'USD 2', valueMinor: 250_50 })
    await run('deal.create', asB(), { companyId: company.id, name: 'JPY', valueMinor: 500_000, currency: 'jpy' })
    const archived = await run('deal.create', asB(), { companyId: company.id, name: 'Gone', valueMinor: 1 })
    await run('deal.archive', asB(), { id: archived.id })

    const { stages } = await run('deal.pipeline', asB(), {})
    const qualified = stages.find((s: { stage: string }) => s.stage === 'qualified')
    expect(qualified).toEqual({
      stage: 'qualified',
      count: 3,
      totals: [
        { currency: 'JPY', valueMinor: 500_000 },
        { currency: 'USD', valueMinor: 350_50 },
      ],
    })
    expect(stages.map((s: { stage: string }) => s.stage)).toEqual([
      'qualified',
      'proposal_sent',
      'negotiation',
      'won',
      'lost',
    ])
  })

  it('refuses a fractional or unknown-currency value', async () => {
    const company = await run('company.create', asA(), { name: `Money ${unique()}` })
    await expect(
      run('deal.create', asA(), { companyId: company.id, name: 'x', valueMinor: 10.5 }),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      run('deal.create', asA(), { companyId: company.id, name: 'x', currency: 'XYZ' }),
    ).rejects.toBeInstanceOf(ZodError)
  })
})

describe('activities', () => {
  it('hide deal notes from people who cannot see deals, even on a company they can see', async () => {
    const company = await run('company.create', asA(), { name: `Visible ${unique()}` })
    const deal = await run('deal.create', asA(), { companyId: company.id, name: 'Secret terms' })
    await run('activity.create', asA(), { companyId: company.id, body: 'Kick-off booked' })
    const dealNote = await run('activity.create', asA(), { dealId: deal.id, body: 'They will pay 20% more' })

    // Logged on the deal, it carries the company too.
    expect(dealNote.companyId).toBe(company.id)
    expect((await run('activity.list', asA(), { companyId: company.id })).data).toHaveLength(2)

    const seenByDeveloper = await run('activity.list', asDeveloper(), { companyId: company.id })
    expect(seenByDeveloper.data.map((a: { body: string }) => a.body)).toEqual(['Kick-off booked'])
    await expect(run('activity.list', asDeveloper(), { dealId: deal.id })).rejects.toBeInstanceOf(
      core.ForbiddenError,
    )
  })

  it('orders the timeline by when things happened, and pages through it', async () => {
    const company = await run('company.create', asA(), { name: `Timeline ${unique()}` })
    await run('activity.create', asA(), { companyId: company.id, body: 'middle', occurredAt: '2026-03-01T10:00:00Z' })
    await run('activity.create', asA(), { companyId: company.id, body: 'latest', occurredAt: '2026-04-01T10:00:00Z' })
    await run('activity.create', asA(), { companyId: company.id, body: 'earliest', occurredAt: '2026-02-01T10:00:00Z' })

    const first = await run('activity.list', asA(), { companyId: company.id, limit: '2' })
    expect(first.data.map((a: { body: string }) => a.body)).toEqual(['latest', 'middle'])
    const second = await run('activity.list', asA(), { companyId: company.id, limit: '2', cursor: first.nextCursor })
    expect(second.data.map((a: { body: string }) => a.body)).toEqual(['earliest'])

    await expect(
      run('activity.list', asA(), { companyId: company.id, cursor: 'garbage' }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it('must be attached to something', async () => {
    await expect(run('activity.create', asA(), { body: 'floating' })).rejects.toBeInstanceOf(ZodError)
  })
})

describe('the client view', () => {
  type Summary = {
    sections: Array<{ key: string; status: string; count: number | null }>
    deals: { openCount: number; openValue: unknown[]; wonCount: number; wonValue: unknown[] } | null
  }
  const section = (summary: Summary, key: string) => summary.sections.find((s) => s.key === key)

  it('counts what each section holds', async () => {
    const company = await run('company.create', asA(), { name: `Summary ${unique()}`, lifecycleStage: 'client' })
    await run('contact.create', asA(), { firstName: 'One', companyId: company.id })
    const archived = await run('contact.create', asA(), { firstName: 'Gone', companyId: company.id })
    await run('contact.archive', asA(), { id: archived.id })
    const open = await run('deal.create', asA(), { companyId: company.id, name: 'Open', valueMinor: 100_00 })
    await run('deal.create', asA(), { companyId: company.id, name: 'Open USD', valueMinor: 50_00, currency: 'USD' })
    const won = await run('deal.create', asA(), { companyId: company.id, name: 'Won', valueMinor: 999_00 })
    await run('deal.changeStage', asA(), { id: won.id, stage: 'won' })
    const lost = await run('deal.create', asA(), { companyId: company.id, name: 'Lost', valueMinor: 1 })
    await run('deal.changeStage', asA(), { id: lost.id, stage: 'lost' })
    await run('activity.create', asA(), { dealId: open.id, body: 'On the deal' })
    await run('activity.create', asA(), { companyId: company.id, body: 'On the company' })

    const summary = await run<Summary>('company.summary', asA(), { id: company.id })

    expect(section(summary, 'overview')).toEqual({ key: 'overview', label: 'Overview', status: 'available', count: null })
    expect(section(summary, 'contacts')).toMatchObject({ status: 'available', count: 1 })
    expect(section(summary, 'deals')).toMatchObject({ status: 'available', count: 4 })
    expect(section(summary, 'activity')).toMatchObject({ status: 'available', count: 2 })
    expect(section(summary, 'projects')).toMatchObject({ status: 'available', count: 0 })
    expect(section(summary, 'quotes')).toMatchObject({ status: 'available', count: 0 })
    expect(section(summary, 'invoices')).toMatchObject({ status: 'available', count: 0 })
    // Every section the specification puts on a client is now built; the
    // "upcoming" and "planned" states remain for whatever is declared next.
    expect(section(summary, 'support')).toMatchObject({ status: 'available', count: 0 })
    expect(section(summary, 'maintenance')).toMatchObject({ status: 'available', count: 0 })
    expect(section(summary, 'infrastructure')).toMatchObject({ status: 'available', count: 0 })
    expect(section(summary, 'documents')).toMatchObject({ status: 'available', count: 0 })

    expect(summary.deals).toEqual({
      openCount: 2,
      openValue: [
        { currency: 'AUD', valueMinor: 100_00 },
        { currency: 'USD', valueMinor: 50_00 },
      ],
      wonCount: 1,
      wonValue: [{ currency: 'AUD', valueMinor: 999_00 }],
    })
  })

  it('shows a developer only the sections and figures their role allows', async () => {
    const company = await run('company.create', asA(), { name: `Dev view ${unique()}`, lifecycleStage: 'client' })
    const deal = await run('deal.create', asA(), { companyId: company.id, name: 'Terms' })
    await run('activity.create', asA(), { dealId: deal.id, body: 'Pricing discussion' })
    await run('activity.create', asA(), { companyId: company.id, body: 'Kick-off' })

    const summary = await run<Summary>('company.summary', asDeveloper(), { id: company.id })

    const keys = summary.sections.map((s) => s.key)
    for (const hidden of ['deals', 'quotes', 'invoices', 'payments', 'expenses']) expect(keys).not.toContain(hidden)
    expect(keys).toEqual(expect.arrayContaining(['overview', 'contacts', 'projects', 'activity', 'support']))
    expect(summary.deals).toBeNull()
    // The deal note is not counted, just as it is not listed.
    expect(section(summary, 'activity')).toMatchObject({ count: 1 })
  })

  it('lists clients and former clients with their figures, and never prospects', async () => {
    const tag = unique()
    const client = await run('company.create', asA(), { name: `Listed ${tag} client`, lifecycleStage: 'client' })
    await run('company.create', asA(), { name: `Listed ${tag} former`, lifecycleStage: 'former_client' })
    await run('company.create', asA(), { name: `Listed ${tag} prospect` })
    await run('contact.create', asA(), { firstName: 'C', companyId: client.id })
    await run('deal.create', asA(), { companyId: client.id, name: 'More work', valueMinor: 12_00 })

    const all = await run('client.list', asA(), { q: `Listed ${tag}` })
    expect(all.data.map((c: { name: string }) => c.name).sort()).toEqual([`Listed ${tag} client`, `Listed ${tag} former`])
    expect(all.data.find((c: { id: string }) => c.id === client.id)).toMatchObject({
      contactCount: 1,
      openDeals: { count: 1, value: [{ currency: 'AUD', valueMinor: 12_00 }] },
    })

    const former = await run('client.list', asA(), { q: `Listed ${tag}`, lifecycleStage: 'former_client' })
    expect(former.data).toHaveLength(1)

    const asDev = await run('client.list', asDeveloper(), { q: `Listed ${tag}` })
    expect(asDev.data.find((c: { id: string }) => c.id === client.id)).toMatchObject({ contactCount: 1, openDeals: null })

    expect((await run('client.list', asB(), { q: `Listed ${tag}` })).data).toEqual([])
  })
})
