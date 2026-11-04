import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Recurring billing, several periods at a time (S16): a client who pays a
 * quarter ahead gets one invoice for three months, every one of them still
 * billed exactly once; and a deleted draft puts its periods back to be billed
 * again -- or, if the agency says so, leaves them unbilled on the record.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')

const ORG = '01a0dd00-0000-7000-8000-0000000016aa'
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
    await db.execute(sql`insert into organization (id, name, slug, base_currency, timezone) values (${ORG}::uuid, 'Marketing', 'marketing-s16', 'LKR', 'Asia/Colombo')`)
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}::uuid, 'Owner', 's16-owner@example.com')`)
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
function sweep(now: Date): Promise<number> {
  return mod.withTenant(ORG, (tx) =>
    modules.generateDueInvoices(registry.buildContext({ organizationId: ORG, actor: { type: 'job', label: 'recurring billing' }, role: null, permissions: new Set(), now }, tx)),
  )
}
const unique = () => core.newId().slice(-8)
const on = (date: string) => new Date(`${date}T09:00:00Z`)

async function retainer(input: Record<string, unknown> = {}) {
  const companyId = (await run('company.create', { name: `Client ${unique()}` })).id
  return run('billingSchedule.create', {
    companyId,
    name: `Social media retainer ${unique()}`,
    startOn: '2026-01-01',
    lines: [{ description: 'Social media management', detail: '12 posts and boosting', unitAmountMinor: 40_000_00 }],
    ...input,
  })
}
const periodsOf = async (id: string) =>
  (await run('billingSchedule.invoices', { id, limit: 100 })).data.map((p: any) => `${p.periodStart}..${p.periodEnd}`).sort()

describe('a client paying a quarter ahead', () => {
  it('gets one invoice for three months, each month still billed once', async () => {
    const s = await retainer()
    const generated = await run('billingSchedule.generate', { id: s.id, periods: 3 }, on('2026-01-05'))
    expect(generated.schedule).toMatchObject({ generatedCount: 3, nextRunOn: '2026-04-01' })

    const invoice = await run('invoice.get', { id: generated.invoiceId })
    expect(invoice.lines).toHaveLength(1)
    expect(invoice.lines[0]).toMatchObject({ quantity: '3', billingType: 'recurring', periodStart: '2026-01-01', periodEnd: '2026-03-31', detail: '12 posts and boosting' })
    expect(invoice.totalMinor).toBe(120_000_00)
    expect(invoice.recurring).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-03-31', periods: 3 })
    expect(await periodsOf(s.id)).toEqual(['2026-01-01..2026-01-31', '2026-02-01..2026-02-28', '2026-03-01..2026-03-31'])

    // The sweep in February finds nothing due: February is paid for.
    expect(await sweep(on('2026-02-15'))).toBe(0)
    expect(await sweep(on('2026-04-01'))).toBe(1)
    expect((await run('billingSchedule.get', { id: s.id })).generatedCount).toBe(4)

    // On the printed invoice: "Quarterly" in the Billing column, the months under the line.
    const rendered = await modules.renderInvoicePdf(ORG, generated.invoiceId)
    expect(rendered).not.toBeNull()
  })

  it('can be a standing arrangement, with a prepay discount and a line per month on request', async () => {
    const s = await retainer({ periodsPerInvoice: 3 })
    await sweep(on('2026-01-01'))
    const [first] = (await run('billingSchedule.invoices', { id: s.id })).data
    expect((await run('billingSchedule.get', { id: s.id })).nextRunOn).toBe('2026-04-01')
    expect((await run('invoice.get', { id: first.invoiceId })).lines[0].quantity).toBe('3')

    const t = await retainer()
    const split = await run('billingSchedule.generate', { id: t.id, periods: 2, layout: 'per_period', discountPercent: '5' }, on('2026-01-02'))
    const invoice = await run('invoice.get', { id: split.invoiceId })
    expect(invoice.lines.map((l: any) => [l.periodStart, l.quantity])).toEqual([
      ['2026-01-01', '1'],
      ['2026-02-01', '1'],
    ])
    expect(invoice.totalMinor).toBe(76_000_00)
  })

  it('refuses more periods than the agreement has left, and bills only what is left by default', async () => {
    const s = await retainer({ maxOccurrences: 2 })
    await expect(run('billingSchedule.generate', { id: s.id, periods: 3 }, on('2026-01-02'))).rejects.toMatchObject({ code: 'periods_exceed_remaining' })

    const t = await retainer({ maxOccurrences: 2, periodsPerInvoice: 3 })
    await sweep(on('2026-01-02'))
    const after = await run('billingSchedule.get', { id: t.id })
    expect(after).toMatchObject({ generatedCount: 2, status: 'ended', nextRunOn: null })

    const u = await retainer({ endOn: '2026-02-10' })
    await expect(run('billingSchedule.generate', { id: u.id, periods: 3 }, on('2026-01-02'))).rejects.toMatchObject({ code: 'periods_exceed_remaining' })
  })
})

describe('a deleted draft', () => {
  it('is billed again by default', async () => {
    const s = await retainer()
    await sweep(on('2026-01-02'))
    const [jan] = (await run('billingSchedule.invoices', { id: s.id })).data
    expect((await run('billingSchedule.get', { id: s.id })).nextRunOn).toBe('2026-02-01')

    await run('invoice.delete', { id: jan.invoiceId })
    expect((await run('billingSchedule.get', { id: s.id })).nextRunOn).toBe('2026-01-01')
    expect(await sweep(on('2026-01-03'))).toBe(1)
    expect(await periodsOf(s.id)).toEqual(['2026-01-01..2026-01-31'])
  })

  it('is left unbilled when the agency says so, and the log says it was', async () => {
    const s = await retainer()
    await sweep(on('2026-01-02'))
    const [jan] = (await run('billingSchedule.invoices', { id: s.id })).data
    await run('invoice.delete', { id: jan.invoiceId, schedulePeriods: 'skip' })
    expect((await run('billingSchedule.get', { id: s.id })).nextRunOn).toBe('2026-02-01')
    expect(await sweep(on('2026-01-20'))).toBe(0)
    const { rows } = await mod.withTenant(ORG, (tx) =>
      tx.execute<{ action: string }>(sql`select action from audit_logs where entity_id = ${s.id}::uuid order by created_at`),
    )
    expect(rows.map((r) => r.action)).toContain('billing_schedule.period_skipped')
  })

  it('goes back to January while February stays billed, then skips over February', async () => {
    const s = await retainer()
    await sweep(on('2026-02-02'))
    const periods = (await run('billingSchedule.invoices', { id: s.id })).data
    expect(periods).toHaveLength(2)
    const jan = periods.find((p: any) => p.periodStart === '2026-01-01')
    await run('invoice.delete', { id: jan.invoiceId })
    expect((await run('billingSchedule.get', { id: s.id })).nextRunOn).toBe('2026-01-01')

    expect(await sweep(on('2026-02-03'))).toBe(1)
    expect((await run('billingSchedule.get', { id: s.id })).nextRunOn).toBe('2026-03-01')
    expect(await periodsOf(s.id)).toEqual(['2026-01-01..2026-01-31', '2026-02-01..2026-02-28'])
  })

  it('reopens an agreement that its periods had finished', async () => {
    const s = await retainer({ maxOccurrences: 1 })
    await sweep(on('2026-01-02'))
    expect((await run('billingSchedule.get', { id: s.id })).status).toBe('ended')
    const [only] = (await run('billingSchedule.invoices', { id: s.id })).data
    await run('invoice.delete', { id: only.invoiceId })
    expect((await run('billingSchedule.get', { id: s.id })).status).toBe('active')
    expect(await sweep(on('2026-01-03'))).toBe(1)
    expect((await run('billingSchedule.get', { id: s.id })).status).toBe('ended')
  })
})

describe('schedule lines', () => {
  it('can be corrected, and invoices already raised keep what they said', async () => {
    const s = await retainer()
    const raised = await run('billingSchedule.generate', { id: s.id }, on('2026-01-02'))
    const lineId = s.lines[0].id
    const updated = await run('billingScheduleLine.update', { scheduleId: s.id, lineId, unitAmountMinor: 45_000_00, detail: '15 posts' })
    expect(updated.lines[0]).toMatchObject({ unitAmountMinor: 45_000_00, detail: '15 posts' })
    expect((await run('invoice.get', { id: raised.invoiceId })).totalMinor).toBe(40_000_00)
  })
})

describe('the period rows, at the database', () => {
  it('let one invoice cover several periods but never one period twice', async () => {
    const s = await retainer()
    const generated = await run('billingSchedule.generate', { id: s.id, periods: 2 }, on('2026-01-02'))
    const duplicate = await mod
      .withTenant(ORG, (tx) =>
        tx.execute(sql`insert into billing_schedule_invoices (id, organization_id, schedule_id, invoice_id, period_start, period_end)
          values (${core.newId()}::uuid, ${ORG}::uuid, ${s.id}::uuid, ${generated.invoiceId}::uuid, '2026-02-01', '2026-02-28')`),
      )
      .then(
        () => null,
        (e: any) => `${e.message} ${e.cause?.message ?? ''}`,
      )
    expect(duplicate).toMatch(/billing_schedule_invoices_period_key/)
  })
})
