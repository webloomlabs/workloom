import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Support and maintenance.
 *
 * What is asserted here is the part a client would argue about: which service
 * level a ticket was given, when its clocks stopped, and that a plan
 * renegotiated later cannot move a target a past ticket was measured against.
 *
 * Generic guarantees (audit, events, cross-tenant 404s, permission refusal) are
 * covered for every procedure in procedures.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')

const ORG = '01a0cc00-0000-7000-8000-00000000000a'
let owner: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  await import('../src/modules/index.ts')

  owner = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone) values
        (${ORG}::uuid, 'Support Co', 'support-co', 'AUD', 'Australia/Sydney')`)
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}::uuid, 'Owner', 's-owner@example.com')`)
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

const unique = () => core.newId().slice(-8)
const company = async () => (await run('company.create', { name: `Client ${unique()}` })).id as string

const NOON = new Date('2026-03-02T12:00:00Z')
const hoursAfter = (from: Date, hours: number) => new Date(from.getTime() + hours * 3_600_000)

describe('tickets', () => {
  it('numbers tickets from a gapless per-organization sequence', async () => {
    const first = await run('ticket.create', { companyId: await company(), title: 'First', body: 'Body' })
    const second = await run('ticket.create', { companyId: await company(), title: 'Second', body: 'Body' })
    expect(first.number).toMatch(/^T-\d{4}$/)
    expect(Number(second.number.slice(2))).toBe(Number(first.number.slice(2)) + 1)
  })

  it('sets both targets from the priority when the client has no plan', async () => {
    const ticket = await run('ticket.create', { companyId: await company(), title: 'Down', body: 'Site is down', priority: 'urgent' }, NOON)
    // The urgent defaults: two hours to answer, eight to fix.
    expect(ticket.firstResponseDueAt).toEqual(hoursAfter(NOON, 2))
    expect(ticket.resolutionDueAt).toEqual(hoursAfter(NOON, 8))
    expect(ticket.responseState).toBe('due')
    expect(ticket.resolutionState).toBe('due')
  })

  it("takes the client's maintenance plan over the default", async () => {
    const companyId = await company()
    await run('maintenancePlan.create', { companyId, name: 'Premium care', responseHours: 1, resolutionHours: 4 })
    const ticket = await run('ticket.create', { companyId, title: 'Slow', body: 'Checkout is slow', priority: 'normal' }, NOON)
    expect(ticket.firstResponseDueAt).toEqual(hoursAfter(NOON, 1))
    expect(ticket.resolutionDueAt).toEqual(hoursAfter(NOON, 4))
  })

  it('leaves a promise already made alone when the plan changes', async () => {
    const companyId = await company()
    const plan = await run('maintenancePlan.create', { companyId, name: 'Care', responseHours: 1 })
    const ticket = await run('ticket.create', { companyId, title: 'Bug', body: 'A bug' }, NOON)
    await run('maintenancePlan.update', { id: plan.id, responseHours: 24 })

    // The target is what was promised when the ticket arrived, not what the
    // plan says today -- otherwise renegotiating a contract would rewrite
    // whether last month's tickets were answered in time.
    const after = await run('ticket.get', { id: ticket.id })
    expect(after.firstResponseDueAt).toEqual(hoursAfter(NOON, 1))
  })

  it('stops the response clock on the first reply the client can see', async () => {
    const ticket = await run('ticket.create', { companyId: await company(), title: 'Question', body: 'How do I?' }, NOON)

    await run('ticketMessage.create', { ticketId: ticket.id, body: 'Ask the developer', internal: true }, hoursAfter(NOON, 1))
    expect((await run('ticket.get', { id: ticket.id })).firstRespondedAt).toBeNull()

    await run('ticketMessage.create', { ticketId: ticket.id, body: 'Here is how' }, hoursAfter(NOON, 2))
    const replied = await run('ticket.get', { id: ticket.id })
    expect(replied.firstRespondedAt).not.toBeNull()
    expect(replied.responseState).toBe('met')

    // Only the first one counts: a later reply cannot re-open the clock.
    const stamp = replied.firstRespondedAt
    await run('ticketMessage.create', { ticketId: ticket.id, body: 'And another thing' }, hoursAfter(NOON, 5))
    expect((await run('ticket.get', { id: ticket.id })).firstRespondedAt).toEqual(stamp)
  })

  it('reports a missed target as breached, before and after the fact', async () => {
    const ticket = await run('ticket.create', { companyId: await company(), title: 'Ignored', body: 'Nobody looked', priority: 'urgent' }, NOON)

    // Nothing has happened, and the two hours are up.
    const late = await run('ticket.get', { id: ticket.id }, hoursAfter(NOON, 3))
    expect(late.responseState).toBe('breached')

    // Answering late does not turn it into a pass.
    await run('ticketMessage.create', { ticketId: ticket.id, body: 'Sorry' }, hoursAfter(NOON, 4))
    expect((await run('ticket.get', { id: ticket.id }, hoursAfter(NOON, 5))).responseState).toBe('breached')
  })

  it('finds what is late without paging through what is not', async () => {
    const companyId = await company()
    const late = await run('ticket.create', { companyId, title: 'Late one', body: 'x', priority: 'urgent' }, NOON)
    await run('ticket.create', { companyId, title: 'Fine one', body: 'x', priority: 'low' }, NOON)

    const breached = await run('ticket.list', { companyId, breached: true }, hoursAfter(NOON, 3))
    expect(breached.data.map((t: { id: string }) => t.id)).toEqual([late.id])
  })

  it('stamps resolution and closure, and clears them when reopened', async () => {
    const ticket = await run('ticket.create', { companyId: await company(), title: 'Fix', body: 'x' }, NOON)

    const resolved = await run('ticket.changeStatus', { id: ticket.id, status: 'resolved' }, hoursAfter(NOON, 4))
    expect(resolved.resolvedAt).toEqual(hoursAfter(NOON, 4))
    expect(resolved.closedAt).toBeNull()
    expect(resolved.open).toBe(false)
    expect(resolved.resolutionState).toBe('met')

    const closed = await run('ticket.changeStatus', { id: ticket.id, status: 'closed' }, hoursAfter(NOON, 6))
    // Resolution stays when it happened; closing is a separate moment.
    expect(closed.resolvedAt).toEqual(hoursAfter(NOON, 4))
    expect(closed.closedAt).toEqual(hoursAfter(NOON, 6))

    const reopened = await run('ticket.changeStatus', { id: ticket.id, status: 'open' }, hoursAfter(NOON, 8))
    expect(reopened.resolvedAt).toBeNull()
    expect(reopened.closedAt).toBeNull()
    // The ticket is not done after all, and its original target is running again.
    expect(reopened.resolutionState).toBe('due')
  })

  it('refuses a contact who works somewhere else', async () => {
    const [a, b] = [await company(), await company()]
    const contact = await run('contact.create', { firstName: 'Mia', companyId: b, email: `mia-${unique()}@example.com` })
    await expect(run('ticket.create', { companyId: a, title: 'Wrong', body: 'x', contactId: contact.id })).rejects.toMatchObject({
      code: 'contact_company_mismatch',
    })
  })
})

describe('maintenance plans', () => {
  it('records what the plan covers, in order', async () => {
    const plan = await run('maintenancePlan.create', {
      companyId: await company(),
      name: 'Care',
      items: ['Security updates', 'Backups', 'Uptime monitoring'],
    })
    expect(plan.items.map((i: { label: string }) => i.label)).toEqual(['Security updates', 'Backups', 'Uptime monitoring'])

    const updated = await run('maintenancePlan.update', { id: plan.id, items: ['Security updates', 'Backups'] })
    expect(updated.items.map((i: { label: string }) => i.label)).toEqual(['Security updates', 'Backups'])
  })

  it('keeps the history when a plan ends', async () => {
    const companyId = await company()
    const plan = await run('maintenancePlan.create', { companyId, name: 'Care', startedOn: '2026-01-01' })
    await run('maintenanceVisit.create', { planId: plan.id, summary: 'Applied updates', kind: 'security_update', performedOn: '2026-02-01' })
    await run('maintenancePlan.changeStatus', { id: plan.id, status: 'ended', endedOn: '2026-03-01' })

    const ended = await run('maintenancePlan.get', { id: plan.id })
    expect(ended.status).toBe('ended')
    expect(ended.endedOn).toBe('2026-03-01')
    expect(ended.visitCount).toBe(1)
    expect((await run('maintenanceVisit.list', { planId: plan.id })).data).toHaveLength(1)
  })

  it('refuses to end a plan before it began', async () => {
    const plan = await run('maintenancePlan.create', { companyId: await company(), name: 'Care', startedOn: '2026-02-01' })
    await expect(run('maintenancePlan.changeStatus', { id: plan.id, status: 'ended', endedOn: '2026-01-01' })).rejects.toMatchObject({
      code: 'ended_before_started',
    })
  })

  it('refuses a billing schedule belonging to another client', async () => {
    const [a, b] = [await company(), await company()]
    const schedule = await run('billingSchedule.create', {
      companyId: b,
      name: 'Retainer',
      lines: [{ description: 'Care', unitAmountMinor: 100_00 }],
    })
    await expect(run('maintenancePlan.create', { companyId: a, name: 'Care', billingScheduleId: schedule.id })).rejects.toMatchObject({
      code: 'schedule_company_mismatch',
    })
  })

  it('shows the plan against the schedule that pays for it', async () => {
    const companyId = await company()
    const schedule = await run('billingSchedule.create', {
      companyId,
      name: 'Care retainer',
      startOn: '2026-04-01',
      lines: [{ description: 'Care plan', unitAmountMinor: 500_00 }],
    })
    const plan = await run('maintenancePlan.create', { companyId, name: 'Care', billingScheduleId: schedule.id })
    expect(plan.billingScheduleName).toBe('Care retainer')
    expect(plan.nextInvoiceOn).toBe('2026-04-01')
  })
})

describe('the client view', () => {
  it('opens the four sections the specification promised, and counts them', async () => {
    const companyId = await company()
    await run('ticket.create', { companyId, title: 'Open one', body: 'x' })
    const resolved = await run('ticket.create', { companyId, title: 'Done one', body: 'x' })
    await run('ticket.changeStatus', { id: resolved.id, status: 'resolved' })
    await run('maintenancePlan.create', { companyId, name: 'Care' })
    await run('infrastructureAsset.create', { companyId, name: `example-${unique()}.test`, kind: 'domain' })

    const summary = await run('company.summary', { id: companyId })
    const section = (key: string) => summary.sections.find((s: { key: string }) => s.key === key)

    for (const key of ['support', 'maintenance', 'infrastructure', 'documents']) {
      expect(section(key)?.status, key).toBe('available')
    }
    // Support counts what is outstanding, not everything ever raised.
    expect(section('support')?.count).toBe(1)
    expect(section('maintenance')?.count).toBe(1)
    expect(section('infrastructure')?.count).toBe(1)
    expect(section('documents')?.count).toBe(0)
  })
})
