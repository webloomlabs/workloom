import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Recurring billing.
 *
 * The invariants here are the ones an agency would notice in its own bank
 * account: a period is billed once, the calendar does not drift, nothing is
 * issued without a person, and a schedule that has run its course stops.
 *
 * Generic guarantees (audit, events, cross-tenant 404s, permission refusal) are
 * covered for every procedure in procedures.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')

const ORG = '01a0dd00-0000-7000-8000-00000000000a'
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
      insert into organization (id, name, slug, base_currency, timezone, payment_terms_days) values
        (${ORG}::uuid, 'Retainer Co', 'retainer-co', 'AUD', 'UTC', 14)`)
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}::uuid, 'Owner', 'r-owner@example.com')`)
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

/** The worker's sweep, as a job actor with no permissions of its own. */
function sweep(now: Date): Promise<number> {
  return mod.withTenant(ORG, (tx) =>
    modules.generateDueInvoices(
      registry.buildContext({ organizationId: ORG, actor: { type: 'job', label: 'recurring billing' }, role: null, permissions: new Set(), now }, tx),
    ),
  )
}

const unique = () => core.newId().slice(-8)
const company = async () => (await run('company.create', { name: `Client ${unique()}` })).id as string

const on = (date: string) => new Date(`${date}T09:00:00Z`)

async function schedule(input: Record<string, unknown> = {}) {
  return run('billingSchedule.create', {
    companyId: await company(),
    name: `Retainer ${unique()}`,
    startOn: '2026-01-31',
    lines: [{ description: 'Care plan', unitAmountMinor: 500_00 }],
    ...input,
  })
}

describe('generating invoices', () => {
  it('raises a draft, never an issued invoice', async () => {
    const s = await schedule({ startOn: '2026-01-01' })
    await sweep(on('2026-01-01'))

    const invoices = await run('billingSchedule.invoices', { id: s.id })
    expect(invoices.data).toHaveLength(1)
    const invoice = await run('invoice.get', { id: invoices.data[0]!.invoiceId })
    // A draft has no number: numbering happens when a person issues it.
    expect(invoice.status).toBe('draft')
    expect(invoice.number).toBeNull()
    expect(invoice.totalMinor).toBe(500_00)
  })

  it('bills the period it is for, and says so from both ends', async () => {
    const s = await schedule({ startOn: '2026-01-01' })
    await sweep(on('2026-01-15'))
    const [period] = (await run('billingSchedule.invoices', { id: s.id })).data
    expect(period.periodStart).toBe('2026-01-01')
    expect(period.periodEnd).toBe('2026-01-31')

    // And the invoice knows where it came from, which is the question someone
    // asks when a client queries a charge.
    const invoice = await run('invoice.get', { id: period.invoiceId })
    expect(invoice.recurring).toMatchObject({ scheduleId: s.id, periodStart: '2026-01-01', periodEnd: '2026-01-31' })
  })

  it('bills nothing before the period arrives', async () => {
    const s = await schedule({ startOn: '2026-06-01' })
    await sweep(on('2026-05-31'))
    expect((await run('billingSchedule.get', { id: s.id })).generatedCount).toBe(0)
  })

  it('bills a period exactly once, however often the sweep runs', async () => {
    const s = await schedule({ startOn: '2026-01-01' })
    await sweep(on('2026-01-10'))
    await sweep(on('2026-01-11'))
    await sweep(on('2026-01-20'))
    expect((await run('billingSchedule.get', { id: s.id })).generatedCount).toBe(1)
  })

  it('does not drift when a month is short', async () => {
    // Starting on the 31st: February is clamped, March is not. Stepping from
    // the clamped date would leave every later period on the 28th.
    const s = await schedule({ startOn: '2026-01-31' })
    await sweep(on('2026-01-31'))
    await sweep(on('2026-02-28'))
    await sweep(on('2026-03-31'))

    const periods = (await run('billingSchedule.invoices', { id: s.id })).data.map((p: { periodStart: string }) => p.periodStart)
    expect(periods.sort()).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })

  it('catches up a schedule that starts in the past, and stops at the present', async () => {
    const s = await schedule({ startOn: '2026-01-01' })
    await sweep(on('2026-03-15'))
    // January, February, and March are owed; April is not.
    const periods = (await run('billingSchedule.invoices', { id: s.id })).data.map((p: { periodStart: string }) => p.periodStart)
    expect(periods.sort()).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
    expect((await run('billingSchedule.get', { id: s.id })).nextRunOn).toBe('2026-04-01')
  })

  it('ends a schedule after the agreed number of invoices', async () => {
    const s = await schedule({ startOn: '2026-01-01', maxOccurrences: 2 })
    await sweep(on('2026-06-01'))
    const after = await run('billingSchedule.get', { id: s.id })
    expect(after.generatedCount).toBe(2)
    expect(after.status).toBe('ended')
    expect(after.nextRunOn).toBeNull()
  })

  it('ends a schedule once its last period is past', async () => {
    const s = await schedule({ startOn: '2026-01-01', endOn: '2026-02-15' })
    await sweep(on('2026-06-01'))
    const after = await run('billingSchedule.get', { id: s.id })
    // January and February are within the window; March starts after it.
    expect(after.generatedCount).toBe(2)
    expect(after.status).toBe('ended')
  })

  it('bills nothing while paused, and resumes where it left off', async () => {
    const s = await schedule({ startOn: '2026-01-01' })
    await sweep(on('2026-01-05'))
    await run('billingSchedule.changeStatus', { id: s.id, status: 'paused' })
    expect(await sweep(on('2026-02-05'))).toBe(0)

    await run('billingSchedule.changeStatus', { id: s.id, status: 'active' })
    expect((await run('billingSchedule.get', { id: s.id })).nextRunOn).toBe('2026-02-01')
    await sweep(on('2026-02-05'))
    expect((await run('billingSchedule.get', { id: s.id })).generatedCount).toBe(2)
  })

  it('refuses to bill a schedule with nothing on it, and says so on the schedule', async () => {
    const s = await run('billingSchedule.create', { companyId: await company(), name: 'Empty', startOn: '2026-01-01', lines: [] })
    expect(s.blocker).toBe('no_lines')
    expect(s.blockerMessage).toContain('nothing to bill')
    await expect(run('billingSchedule.generate', { id: s.id })).rejects.toMatchObject({ code: 'schedule_no_lines' })
  })

  it('leaves a blocked schedule out of the sweep without stopping the others', async () => {
    // One transaction bills every due schedule: a broken one that threw would
    // take the rest of the agency's billing down with it for that hour.
    await run('billingSchedule.create', { companyId: await company(), name: 'Empty', startOn: '2026-01-01', lines: [] })
    const archivedClient = await company()
    await run('billingSchedule.create', {
      companyId: archivedClient,
      name: 'For an archived client',
      startOn: '2026-01-01',
      lines: [{ description: 'Care', unitAmountMinor: 100_00 }],
    })
    await run('company.archive', { id: archivedClient })
    const empty = await run('billingSchedule.create', { companyId: await company(), name: 'Also empty', startOn: '2026-01-01', lines: [] })
    const healthy = await schedule({ startOn: '2026-01-02' })

    await sweep(on('2026-01-02'))
    expect((await run('billingSchedule.get', { id: healthy.id })).generatedCount).toBe(1)
    expect((await run('billingSchedule.get', { id: empty.id })).generatedCount).toBe(0)
  })

  it('prices a period through the same calculator as a hand-written invoice', async () => {
    const taxRate = await run('taxRate.create', { name: `GST ${unique()}`, rate: '10' })
    const s = await schedule({
      startOn: '2026-01-01',
      taxMode: 'exclusive',
      lines: [
        { description: 'Care plan', unitAmountMinor: 500_00, taxRateId: taxRate.id },
        { description: 'Hosting', unitAmountMinor: 50_00, quantity: '2', taxRateId: taxRate.id },
      ],
    })
    expect(s.periodSubtotalMinor).toBe(600_00)

    await sweep(on('2026-01-02'))
    const invoice = await run('invoice.get', { id: (await run('billingSchedule.invoices', { id: s.id })).data[0]!.invoiceId })
    expect(invoice.subtotalMinor).toBe(600_00)
    expect(invoice.taxMinor).toBe(60_00)
    expect(invoice.totalMinor).toBe(660_00)
  })

  it('records the period against the invoice, and refuses a second one for it', async () => {
    const s = await schedule({ startOn: '2026-01-01' })
    await sweep(on('2026-01-02'))

    // The database is what guarantees it, not the service: inserting the same
    // period by hand has to fail on the unique key.
    await expect(
      mod.withTenant(ORG, (tx) =>
        tx.execute(sql`
          insert into billing_schedule_invoices (id, organization_id, schedule_id, invoice_id, period_start, period_end)
          values (${core.newId()}::uuid, ${ORG}::uuid, ${s.id}::uuid, ${core.newId()}::uuid, '2026-01-01', '2026-01-31')`),
      ),
    ).rejects.toThrow()
  })

  it('will bill the next period early when a person asks it to', async () => {
    const s = await schedule({ startOn: '2026-06-01' })
    const result = await run('billingSchedule.generate', { id: s.id, force: true }, on('2026-05-01'))
    expect(result.invoiceId).not.toBeNull()
    expect(result.schedule.generatedCount).toBe(1)
  })
})

describe('changing a schedule', () => {
  it('refuses to change the currency once it has billed', async () => {
    const s = await schedule({ startOn: '2026-01-01' })
    await sweep(on('2026-01-02'))
    await expect(run('billingSchedule.update', { id: s.id, currency: 'USD' })).rejects.toMatchObject({ code: 'currency_locked' })
  })

  it('re-anchors the calendar when the start date moves', async () => {
    const s = await schedule({ startOn: '2026-01-01' })
    const moved = await run('billingSchedule.update', { id: s.id, startOn: '2026-01-15' })
    expect(moved.nextRunOn).toBe('2026-01-15')
    expect(moved.nextPeriodEndsOn).toBe('2026-02-14')
  })

  it('leaves invoices already raised alone', async () => {
    const s = await schedule({ startOn: '2026-01-01' })
    await sweep(on('2026-01-02'))
    const before = await run('invoice.get', { id: (await run('billingSchedule.invoices', { id: s.id })).data[0]!.invoiceId })

    await run('billingScheduleLine.add', { scheduleId: s.id, description: 'Extra hours', unitAmountMinor: 200_00 })
    const after = await run('invoice.get', { id: before.id })
    // An invoice is a statement that was already made; editing the agreement
    // changes what happens next, not what was said.
    expect(after.totalMinor).toBe(before.totalMinor)
  })
})
