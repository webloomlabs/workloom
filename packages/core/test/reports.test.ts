import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Profitability.
 *
 * The figures are asserted to the cent against a fixture whose every input is
 * known, because a report that is nearly right is worse than none: someone
 * drops a client over it.
 *
 * The test this slice exists for is "a rate change leaves history alone". Rates
 * are copied onto a time entry when it is logged (S6) precisely so that giving
 * someone a raise cannot rewrite last quarter's margin, and nothing enforces
 * that except a test that raises a rate and looks again.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')

const ORG_A = '01a0cc00-0000-7000-8000-00000000000a'
let ownerA: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  await import('../src/modules/index.ts')

  ownerA = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone) values
        (${ORG_A}::uuid, 'Org A', 'rep-a', 'AUD', 'Australia/Sydney')`)
    await db.execute(sql`insert into "user" (id, name, email) values (${ownerA}::uuid, 'Owner A', 'r-a@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

const owner = () => ({
  organizationId: ORG_A,
  actor: { type: 'user' as const, id: ownerA, label: 'owner' },
  role: 'owner' as const,
  permissions: core.permissionsForRole('owner'),
})

function run<T = any>(name: string, input: unknown): Promise<T> {
  return registry.executeProcedure(name, { ...owner(), input }) as Promise<T>
}

const unique = () => core.newId().slice(-8)
const HOUR = 3600

async function company() {
  return (await run('company.create', { name: `Client ${unique()}` })).id as string
}

async function project(companyId: string, input: Record<string, unknown> = {}) {
  return (await run('project.create', { name: `Project ${unique()}`, companyId, ...input })).id as string
}

/** The figures for a project in one currency, which is the usual case. */
async function financials(projectId: string, currency = 'AUD') {
  const report = await run('project.financials', { id: projectId })
  return report.currencies.find((c: { currency: string }) => c.currency === currency)
}

/**
 * A project whose every number is known: 10 billable hours at 150.00 and 2
 * unbillable at the same cost rate, a 200.00 expense rebilled at a 25% markup,
 * all of it invoiced and 1,000.00 of it paid.
 */
async function knownProject() {
  const companyId = await company()
  const projectId = await project(companyId, { budgetMinor: 5000_00 })
  await run('rate.set', { billableRateMinor: 150_00, costRateMinor: 60_00 })
  await run('timeEntry.create', { projectId, durationSeconds: 10 * HOUR, billable: true, spentOn: '2026-03-10' })
  await run('timeEntry.create', { projectId, durationSeconds: 2 * HOUR, billable: false, spentOn: '2026-03-11' })
  await run('expense.create', {
    description: 'Stock photography',
    projectId,
    amountMinor: 200_00,
    billable: true,
    markupPercent: '25',
    incurredOn: '2026-03-12',
  })

  const invoice = await run('invoice.create', { companyId, projectId, title: `March ${unique()}` })
  await run('invoice.billTime', { id: invoice.id, projectId })
  await run('invoice.billExpenses', { id: invoice.id, projectId })
  await run('invoice.send', { id: invoice.id, issueDate: '2026-03-31' })
  await run('payment.record', {
    companyId,
    amountMinor: 1000_00,
    receivedOn: '2026-04-05',
    allocations: [{ invoiceId: invoice.id, amountMinor: 1000_00 }],
  })
  return { companyId, projectId, invoiceId: invoice.id }
}

describe("a project's profit and loss", () => {
  it('adds up to the cent', async () => {
    const { projectId } = await knownProject()
    const figures = await financials(projectId)

    // 10h at 150.00 billed, plus the expense rebilled at 200.00 + 25%.
    expect(figures).toMatchObject({
      currency: 'AUD',
      billedMinor: 1750_00,
      collectedMinor: 1000_00,
      outstandingMinor: 750_00,
      // 12 hours at 60.00, billable or not: unbillable time still costs.
      labourCostMinor: 720_00,
      expenseCostMinor: 200_00,
      rebilledCostMinor: 200_00,
      costMinor: 920_00,
      uninvoicedMinor: 0,
      marginMinor: 830_00,
      billableSeconds: 10 * HOUR,
      nonBillableSeconds: 2 * HOUR,
      entriesWithoutCostRate: 0,
    })
    // 830.00 of 1,750.00, exact to two places.
    expect(figures.marginPercent).toBe('47.43')
    // Ten billable hours of twelve tracked.
    expect(figures.utilisationPercent).toBe('83.33')
    // 1,750.00 over twelve hours, whether or not they were billable.
    expect(figures.effectiveHourlyMinor).toBe(145_83)
  })

  it('counts a rebilled expense once as cost and once as revenue', async () => {
    // Which means the markup, and only the markup, is the margin it adds.
    const { projectId } = await knownProject()
    const { marginMinor, expenseCostMinor, rebilledCostMinor } = await financials(projectId)
    const labourMargin = 1500_00 - 720_00
    expect(marginMinor - labourMargin).toBe(50_00)
    expect(expenseCostMinor).toBe(rebilledCostMinor)
  })

  it('measures the budget against what has been spent', async () => {
    const { projectId } = await knownProject()
    const report = await run('project.financials', { id: projectId })
    expect(report.budgetMinor).toBe(5000_00)
    // 920.00 of 5,000.00.
    expect(report.budgetUsedPercent).toBe('18.4')
  })

  it('shows work still to invoice, and stops showing it once billed', async () => {
    const companyId = await company()
    const projectId = await project(companyId)
    await run('rate.set', { billableRateMinor: 150_00, costRateMinor: 60_00 })
    await run('timeEntry.create', { projectId, durationSeconds: 4 * HOUR, billable: true })
    expect(await financials(projectId)).toMatchObject({ billedMinor: 0, uninvoicedMinor: 600_00, marginMinor: -240_00 })
    // Nothing billed yet, so a margin percentage would be a share of nothing.
    expect((await financials(projectId)).marginPercent).toBeNull()

    const invoice = await run('invoice.create', { companyId, projectId, title: `Bill ${unique()}` })
    await run('invoice.billTime', { id: invoice.id, projectId })
    await run('invoice.send', { id: invoice.id })
    expect(await financials(projectId)).toMatchObject({ billedMinor: 600_00, uninvoicedMinor: 0, marginMinor: 360_00 })
  })

  it('gives a project with nothing recorded a row of zeros in its own currency', async () => {
    const projectId = await project(await company())
    const report = await run('project.financials', { id: projectId })
    expect(report.currencies).toHaveLength(1)
    expect(report.currencies[0]).toMatchObject({ currency: 'AUD', billedMinor: 0, marginMinor: 0, marginPercent: null })
  })

  it('does not count a draft invoice, and stops counting a cancelled one', async () => {
    const companyId = await company()
    const projectId = await project(companyId)
    const invoice = await run('invoice.create', {
      companyId,
      projectId,
      title: `Draft ${unique()}`,
      lines: [{ description: 'Design', unitAmountMinor: 900_00 }],
    })
    expect(await financials(projectId)).toMatchObject({ billedMinor: 0 })

    await run('invoice.send', { id: invoice.id })
    expect(await financials(projectId)).toMatchObject({ billedMinor: 900_00 })

    await run('invoice.cancel', { id: invoice.id, reason: 'Raised in error' })
    expect(await financials(projectId)).toMatchObject({ billedMinor: 0 })
  })

  it('counts revenue without the tax charged on it', async () => {
    const companyId = await company()
    const projectId = await project(companyId)
    const gst = (await run('taxRate.create', { name: `GST ${unique()}`, rate: '10' })).id
    const invoice = await run('invoice.create', {
      companyId,
      projectId,
      title: `Taxed ${unique()}`,
      lines: [{ description: 'Design', unitAmountMinor: 1000_00, taxRateId: gst }],
    })
    await run('invoice.send', { id: invoice.id })
    // The client pays 1,100.00; 100.00 of it was never the agency's.
    expect((await run('invoice.get', { id: invoice.id })).totalMinor).toBe(1100_00)
    expect(await financials(projectId)).toMatchObject({ billedMinor: 1000_00 })
  })
})

describe('history does not move', () => {
  it('leaves the margin alone when a rate changes', async () => {
    // The reason rates are copied onto each entry. Without this, giving someone
    // a raise silently rewrites every project they have ever worked on.
    const { projectId } = await knownProject()
    const before = await financials(projectId)

    await run('rate.set', { billableRateMinor: 300_00, costRateMinor: 120_00 })
    expect(await financials(projectId)).toEqual(before)

    // And new time is costed at the new rate, so the change did take.
    await run('timeEntry.create', { projectId, durationSeconds: HOUR, billable: false })
    expect((await financials(projectId)).labourCostMinor).toBe(720_00 + 120_00)
  })

  it('leaves the margin alone when the catalogue and the tax rate change', async () => {
    const companyId = await company()
    const projectId = await project(companyId)
    const gst = (await run('taxRate.create', { name: `GST ${unique()}`, rate: '10' })).id
    const service = (await run('service.create', {
      name: `Retainer ${unique()}`,
      defaultPriceMinor: 500_00,
      defaultTaxRateId: gst,
    })).id
    const invoice = await run('invoice.create', { companyId, projectId, title: `Retainer ${unique()}`, lines: [{ serviceId: service, quantity: '2' }] })
    await run('invoice.send', { id: invoice.id })
    const before = await financials(projectId)
    expect(before).toMatchObject({ billedMinor: 1000_00 })

    await run('service.update', { id: service, defaultPriceMinor: 9999_00 })
    await run('taxRate.archive', { id: gst })
    expect(await financials(projectId)).toEqual(before)
  })
})

describe('an invoice that bills two projects', () => {
  it('gives each its own lines, and its share of the payment', async () => {
    const companyId = await company()
    const first = await project(companyId)
    const second = await project(companyId)
    await run('rate.set', { billableRateMinor: 100_00, costRateMinor: 40_00 })
    await run('timeEntry.create', { projectId: first, durationSeconds: 3 * HOUR, billable: true })
    await run('timeEntry.create', { projectId: second, durationSeconds: HOUR, billable: true })

    // One invoice for the client, covering both projects.
    const invoice = await run('invoice.create', { companyId, title: `Both ${unique()}` })
    const billed = await run('invoice.billTime', { id: invoice.id })
    expect(billed.billed.linesAdded).toBe(2)
    await run('invoice.send', { id: invoice.id })
    await run('payment.record', { companyId, amountMinor: 200_00, allocations: [{ invoiceId: invoice.id, amountMinor: 200_00 }] })

    const a = await financials(first)
    const b = await financials(second)
    expect(a.billedMinor).toBe(300_00)
    expect(b.billedMinor).toBe(100_00)
    // 200.00 against 400.00 billed, shared three to one.
    expect(a.collectedMinor).toBe(150_00)
    expect(b.collectedMinor).toBe(50_00)
    expect(a.collectedMinor + b.collectedMinor).toBe(200_00)
  })
})

describe('more than one currency', () => {
  it('reports each separately and converts nothing', async () => {
    const companyId = await company()
    const projectId = await project(companyId)
    await run('rate.set', { billableRateMinor: 100_00, costRateMinor: 40_00 })
    await run('timeEntry.create', { projectId, durationSeconds: 2 * HOUR, billable: true })
    // A supplier billed in yen. There is no rate to restate the hours at.
    await run('expense.create', { description: 'Font licence', projectId, amountMinor: 30_000, currency: 'JPY', exchangeRate: '0.0105' })

    const report = await run('project.financials', { id: projectId })
    expect(report.currencies.map((c: { currency: string }) => c.currency)).toEqual(['AUD', 'JPY'])
    expect(report.currencies[0]).toMatchObject({ currency: 'AUD', labourCostMinor: 80_00, expenseCostMinor: 0 })
    expect(report.currencies[1]).toMatchObject({ currency: 'JPY', expenseCostMinor: 30_000, marginMinor: -30_000 })
  })
})

describe('the portfolio', () => {
  it('puts the worst margin first', async () => {
    const companyId = await company()
    const losing = await project(companyId, { name: `Losing ${unique()}` })
    await run('rate.set', { billableRateMinor: 100_00, costRateMinor: 90_00 })
    await run('timeEntry.create', { projectId: losing, durationSeconds: 10 * HOUR, billable: false })

    const report = await run('report.projects', { companyId, sort: 'margin' })
    expect(report.data[0]).toMatchObject({ projectId: losing, marginMinor: -900_00 })
  })

  it('leaves archived projects out unless asked', async () => {
    const companyId = await company()
    const projectId = await project(companyId)
    await run('rate.set', { billableRateMinor: 100_00, costRateMinor: 50_00 })
    await run('timeEntry.create', { projectId, durationSeconds: HOUR, billable: true })
    await run('project.archive', { id: projectId })

    expect((await run('report.projects', { companyId })).data).toHaveLength(0)
    expect((await run('report.projects', { companyId, includeArchived: true })).data).toHaveLength(1)
  })
})

describe('the revenue report', () => {
  it('adds up the period, and says what is owed now', async () => {
    const { companyId } = await knownProject()
    const report = await run('report.revenue', { companyId, from: '2026-01-01', to: '2026-12-31' })
    const aud = report.currencies.find((c: { currency: string }) => c.currency === 'AUD')

    expect(aud).toMatchObject({
      billedMinor: 1750_00,
      taxMinor: 0,
      collectedMinor: 1000_00,
      outstandingMinor: 750_00,
      expenseCostMinor: 200_00,
      labourCostMinor: 720_00,
      profitMinor: 830_00,
    })
    expect(aud.profitPercent).toBe('47.43')
    // Every line was billed from this project's time or its expense.
    expect(aud.unattributedBilledMinor).toBe(0)
  })

  it('dates each figure the way that thing is dated', async () => {
    const { companyId } = await knownProject()
    const report = await run('report.revenue', { companyId, from: '2026-03-01', to: '2026-04-30' })
    const byMonth = report.currencies[0].byMonth as Array<Record<string, number | string>>
    expect(byMonth.map((m) => m.month)).toEqual(['2026-03', '2026-04'])

    // The invoice was issued in March; the payment arrived in April; the work
    // and the expense were both March.
    expect(byMonth[0]).toMatchObject({ month: '2026-03', billedMinor: 1750_00, collectedMinor: 0, labourCostMinor: 720_00, expenseCostMinor: 200_00 })
    expect(byMonth[1]).toMatchObject({ month: '2026-04', billedMinor: 0, collectedMinor: 1000_00 })
  })

  it('names revenue that no project claims', async () => {
    const companyId = await company()
    const invoice = await run('invoice.create', {
      companyId,
      title: `No project ${unique()}`,
      lines: [{ description: 'Consulting', unitAmountMinor: 400_00 }],
    })
    await run('invoice.send', { id: invoice.id, issueDate: '2026-05-01' })
    const report = await run('report.revenue', { companyId, from: '2026-05-01', to: '2026-05-31' })
    expect(report.currencies[0]).toMatchObject({ billedMinor: 400_00, unattributedBilledMinor: 400_00 })
  })

  it('counts a refund as money going back out', async () => {
    const { companyId } = await knownProject()
    await run('payment.record', { companyId, kind: 'refund', amountMinor: 400_00, receivedOn: '2026-04-20' })
    const report = await run('report.revenue', { companyId, from: '2026-04-01', to: '2026-04-30' })
    expect(report.currencies[0].collectedMinor).toBe(600_00)
  })

  it('lists who the money came from', async () => {
    const { companyId } = await knownProject()
    const report = await run('report.revenue', { from: '2026-01-01', to: '2026-12-31' })
    const client = report.byClient.find((c: { companyId: string }) => c.companyId === companyId)
    expect(client).toMatchObject({ currency: 'AUD', billedMinor: 1750_00, collectedMinor: 1000_00 })
  })

  it('defaults to the last twelve months, ending today', async () => {
    // Asserted from the dates it chose, not from the data: a fixture dated to a
    // fixed year would fall out of the window as the real clock moves on.
    const report = await run('report.revenue', {})
    expect(report.from).toMatch(/^\d{4}-\d{2}-01$/)
    const [fromYear, fromMonth] = report.from.split('-').map(Number)
    const [toYear, toMonth] = report.to.split('-').map(Number)
    expect(toYear * 12 + toMonth - (fromYear * 12 + fromMonth)).toBe(11)
  })
})
