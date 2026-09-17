import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * The dashboard.
 *
 * Every figure is asserted against a fixture whose every input is known, and
 * the same page is read as three roles: what a card shows matters, and so does
 * a card being absent rather than showing zero.
 *
 * "Today" is pinned, because a dashboard is entirely about which side of a date
 * boundary something falls on.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')

const ORG = '01a0dd00-0000-7000-8000-00000000000a'
let ownerId: string
let financeId: string
let developerId: string

/** Noon on 16 September 2026 in Sydney, which is the previous evening in UTC. */
const NOW = new Date('2026-09-16T02:00:00Z')

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  await import('../src/modules/index.ts')

  ownerId = core.newId()
  financeId = core.newId()
  developerId = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone) values
        (${ORG}::uuid, 'Org', 'dash', 'AUD', 'Australia/Sydney')`)
    await db.execute(sql`
      insert into "user" (id, name, email) values
        (${ownerId}::uuid, 'Owner', 'd-owner@example.com'),
        (${financeId}::uuid, 'Finance', 'd-finance@example.com'),
        (${developerId}::uuid, 'Developer', 'd-dev@example.com')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role) values
        (${core.newId()}::uuid, ${ORG}::uuid, ${ownerId}::uuid, 'owner'),
        (${core.newId()}::uuid, ${ORG}::uuid, ${financeId}::uuid, 'finance'),
        (${core.newId()}::uuid, ${ORG}::uuid, ${developerId}::uuid, 'developer')`)
  })
  await seed()
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'finance' | 'developer'
const actors: Record<Role, string> = { owner: '', finance: '', developer: '' }

const as = (role: Role) => ({
  organizationId: ORG,
  actor: { type: 'user' as const, id: actors[role], label: role },
  role,
  permissions: core.permissionsForRole(role),
})

function run<T = any>(name: string, input: unknown, role: Role = 'owner', now: Date = NOW): Promise<T> {
  return registry.executeProcedure(name, { ...as(role), input, now }) as Promise<T>
}

const dashboard = (input: Record<string, unknown> = {}, role: Role = 'owner', now: Date = NOW) => run('dashboard.get', input, role, now)

const HOUR = 3600
let companyId: string
let projectId: string

/**
 * A month with known numbers, and the month before it for comparison.
 *
 * September: 1,000.00 invoiced plus tax, 200.00 spent, ten hours worked at
 * 60.00 an hour. August: 400.00 invoiced and 100.00 spent, and that invoice
 * was paid, so only September's is outstanding.
 */
async function seed() {
  actors.owner = ownerId
  actors.finance = financeId
  actors.developer = developerId

  companyId = (await run('company.create', { name: 'Harbour' })).id
  projectId = (await run('project.create', { name: 'Harbour site', companyId, dueDate: '2026-09-30', budgetMinor: 5000_00 })).id
  const gst = (await run('taxRate.create', { name: 'GST', rate: '10' })).id

  await run('rate.set', { billableRateMinor: 150_00, costRateMinor: 60_00 })
  await run('timeEntry.create', { projectId, durationSeconds: 10 * HOUR, billable: true, spentOn: '2026-09-11' })

  await run('expense.create', { description: 'Hosting', projectId, amountMinor: 200_00, incurredOn: '2026-09-12' })
  await run('expense.create', { description: 'Licence', projectId, amountMinor: 100_00, incurredOn: '2026-08-03' })

  const september = await run('invoice.create', {
    companyId,
    projectId,
    title: 'September',
    lines: [{ description: 'Design', unitAmountMinor: 1000_00, taxRateId: gst }],
  })
  await run('invoice.send', { id: september.id, issueDate: '2026-09-10' })

  const august = await run('invoice.create', { companyId, projectId, title: 'August', lines: [{ description: 'Design', unitAmountMinor: 400_00 }] })
  await run('invoice.send', { id: august.id, issueDate: '2026-08-05' })
  await run('payment.record', { companyId, amountMinor: 400_00, receivedOn: '2026-08-20', allocations: [{ invoiceId: august.id }] })

  // Delivery: a task due inside the fortnight, one already late, one done.
  await run('task.create', { projectId, title: 'Wireframes', dueDate: '2026-09-20' })
  await run('task.create', { projectId, title: 'Overdue copy', dueDate: '2026-09-01' })
  const done = await run('task.create', { projectId, title: 'Kickoff' })
  await run('task.changeStatus', { id: done.id, status: 'done' })
  await run('milestone.create', { id: projectId, name: 'Design signed off', dueDate: '2026-09-18' })

  // Pipeline and leads.
  await run('deal.create', { companyId, name: 'Retainer', valueMinor: 12_000_00, stage: 'proposal_sent' })
  await run('deal.create', { companyId, name: 'Rebuild', valueMinor: 30_000_00, stage: 'negotiation' })
  await run('lead.create', { contactName: 'Grace Hopper', companyName: 'Navy', email: 'grace@example.com' })
  await run('lead.create', { contactName: 'Ada Lovelace', companyName: 'Analytical', email: 'ada@example.com' })
  // A lead's created_at is a database default, not the pinned clock, so it is
  // dated here: otherwise this suite quietly depends on what time it is run.
  await mod.withTenant(ORG, (tx) => tx.execute(sql`update leads set created_at = '2026-09-08T02:00:00Z'`))
  await run('lead.create', { contactName: 'Last month', companyName: 'Earlier', email: 'earlier@example.com' })
  await mod.withTenant(ORG, (tx) =>
    tx.execute(sql`update leads set created_at = '2026-08-08T02:00:00Z' where company_name = 'Earlier'`),
  )
}

describe('the money cards', () => {
  it('count revenue excluding tax, against the same days last month', async () => {
    const { money } = await dashboard()
    // 1,000.00 this September against 400.00 to the same point in August.
    expect(money.revenue).toEqual({ minor: 1000_00, previousMinor: 400_00, changePercent: '150' })
  })

  it('count what is owed as things stand, not over a period', async () => {
    const { money } = await dashboard()
    // September's 1,000.00 plus its GST. August's was paid.
    expect(money.outstanding).toEqual({ minor: 1100_00, count: 1, overdueMinor: 0, overdueCount: 0 })
  })

  it('count expenses by the day they were incurred', async () => {
    const { money } = await dashboard()
    expect(money.expenses).toEqual({ minor: 200_00, previousMinor: 100_00, changePercent: '100' })
  })

  it('take the time it took off the profit', async () => {
    const { money } = await dashboard()
    // 1,000.00 less 200.00 of expenses and ten hours at 60.00.
    expect(money.profit).toMatchObject({ minor: 200_00, labourCostMinor: 600_00, uncountedSeconds: 0, uncountedCurrencies: [] })
    // August billed 400.00 and spent 100.00 with no time logged.
    expect(money.profit.previousMinor).toBe(300_00)
  })
})

describe('the delivery cards', () => {
  it('count what is live, what is late, and what got finished', async () => {
    const { projects, tasks } = await dashboard()
    expect(projects).toMatchObject({ active: 1, onHold: 0, overdue: 0 })
    expect(tasks).toMatchObject({ open: 2, overdue: 1 })
    expect(tasks.completed).toMatchObject({ count: 1 })
    // Nothing is assigned to anybody yet, so nothing is anybody's.
    expect(tasks.mine).toBe(0)
  })

  it('counts a task as mine once it is assigned to me', async () => {
    const mine = await run('task.create', { projectId, title: 'Assigned to the owner', assigneeId: ownerId })
    expect((await dashboard()).tasks.mine).toBe(1)
    expect((await dashboard({}, 'developer')).tasks.mine).toBe(0)
    await run('task.delete', { id: mine.id })
  })

  it('list what falls due next, late things first', async () => {
    const { deadlines } = await dashboard()
    expect(deadlines.map((d: { title: string; overdue: boolean }) => [d.title, d.overdue])).toEqual([
      ['Overdue copy', true],
      ['Design signed off', false],
      ['Wireframes', false],
    ])
    expect(deadlines[0]).toMatchObject({ kind: 'task', projectName: 'Harbour site' })
    expect(deadlines[1]).toMatchObject({ kind: 'milestone' })
  })

  it('leave out anything further away than a fortnight', async () => {
    await run('task.create', { projectId, title: 'Next month', dueDate: '2026-10-20' })
    const { deadlines } = await dashboard()
    expect(deadlines.map((d: { title: string }) => d.title)).not.toContain('Next month')
  })
})

describe('the sales cards', () => {
  it('count open leads, and how many arrived against last month', async () => {
    const { leads } = await dashboard()
    expect(leads.open).toBe(3)
    // Two came in this month, one in the same days of the month before.
    expect(leads.created).toEqual({ count: 2, previousCount: 1, changePercent: '100' })
    expect(leads.converted.count).toBe(0)
  })

  it('add up open deals per currency, base currency first', async () => {
    const { pipeline } = await dashboard()
    expect(pipeline).toEqual([{ currency: 'AUD', openMinor: 42_000_00, openCount: 2, wonMinor: 0, wonCount: 0 }])
  })

  it('count a deal as won in the period it closed', async () => {
    const deal = await run('deal.create', { companyId, name: 'Won this month', valueMinor: 5_000_00, stage: 'negotiation' })
    await run('deal.changeStage', { id: deal.id, stage: 'won' })
    const { pipeline } = await dashboard()
    expect(pipeline[0]).toMatchObject({ wonMinor: 5_000_00, wonCount: 1 })
  })
})

describe('what happened lately', () => {
  it('reads from the audit log, newest first', async () => {
    const { activity } = await dashboard()
    expect(activity.length).toBeGreaterThan(0)
    expect(activity[0]).toMatchObject({ entityType: expect.any(String), action: expect.any(String) })
    const ids = activity.map((a: { id: string }) => a.id)
    expect([...ids].sort().reverse()).toEqual(ids)
  })
})

describe('the same page, read by different roles', () => {
  it('shows an owner everything', async () => {
    const board = await dashboard()
    for (const card of ['money', 'projects', 'tasks', 'deadlines', 'leads', 'pipeline', 'activity'] as const) {
      expect(board[card], `an owner should see ${card}`).not.toBeNull()
    }
  })

  it('shows finance the money and not the pipeline', async () => {
    const board = await dashboard({}, 'finance')
    expect(board.money.revenue.minor).toBe(1000_00)
    expect(board.activity).not.toBeNull()
    // Finance reads invoices, not the sales pipeline or the lead list.
    expect(board.pipeline).toBeNull()
    expect(board.leads).toBeNull()
  })

  it('shows a developer their work and not one money figure', async () => {
    const board = await dashboard({}, 'developer')
    expect(board.tasks).not.toBeNull()
    expect(board.deadlines).not.toBeNull()
    expect(board.projects).not.toBeNull()
    // Absent, not zero: "you may not see this" is not "this is empty".
    expect(board.money).toBeNull()
    expect(board.leads).toBeNull()
    expect(board.pipeline).toBeNull()
    expect(board.activity).toBeNull()
    expect(JSON.stringify(board)).not.toContain('revenue')
  })

  it('counts as "mine" only what is assigned to the reader', async () => {
    expect((await dashboard({}, 'developer')).tasks.mine).toBe(0)
  })
})

describe('the period', () => {
  it('covers the month so far, against the same days before', async () => {
    const board = await dashboard({ period: 'month' })
    expect(board).toMatchObject({ from: '2026-09-01', to: '2026-09-16', previousFrom: '2026-08-01', previousTo: '2026-08-16' })
  })

  it('covers the quarter, which takes in both invoices', async () => {
    const board = await dashboard({ period: 'quarter' })
    expect(board).toMatchObject({ from: '2026-07-01', to: '2026-09-16' })
    // July to September holds both: 1,000.00 and 400.00.
    expect(board.money.revenue.minor).toBe(1400_00)
  })

  it('covers the year', async () => {
    const board = await dashboard({ period: 'year' })
    expect(board).toMatchObject({ from: '2026-01-01', to: '2026-09-16', previousFrom: '2025-01-01', previousTo: '2025-09-16' })
    expect(board.money.revenue.previousMinor).toBe(0)
    expect(board.money.revenue.changePercent).toBeNull()
  })

  it('reads the date in the organization time zone', async () => {
    // 13:59 UTC on the 30th is still the 30th in Sydney; a minute later it is
    // October there, and the month card moves with it.
    expect((await dashboard({}, 'owner', new Date('2026-09-30T13:59:00Z'))).to).toBe('2026-09-30')
    expect((await dashboard({}, 'owner', new Date('2026-09-30T14:01:00Z'))).from).toBe('2026-10-01')
  })
})

describe('money in another currency', () => {
  it('counts it at the rate recorded when the document was issued', async () => {
    const before = (await dashboard()).money.revenue.minor
    const yen = await run('invoice.create', {
      companyId,
      projectId,
      title: 'Tokyo',
      currency: 'JPY',
      lines: [{ description: 'Design', unitAmountMinor: 100_000 }],
    })
    // 100,000 yen at 0.0105 to the dollar: 1,050.00.
    await run('invoice.send', { id: yen.id, issueDate: '2026-09-14', exchangeRate: '0.0105' })
    expect((await dashboard()).money.revenue.minor).toBe(before + 1050_00)
  })

  it('leaves time it cannot cost out of the profit, and says so', async () => {
    const tokyo = (await run('project.create', { name: 'Tokyo build', companyId, currency: 'JPY' })).id
    await run('rate.set', { currency: 'JPY', billableRateMinor: 20_000, costRateMinor: 8_000 })
    await run('timeEntry.create', { projectId: tokyo, durationSeconds: 5 * HOUR, billable: true, spentOn: '2026-09-15' })

    const { money } = await dashboard()
    // The hours are named, not silently dropped, and not converted at a rate
    // nobody wrote down.
    expect(money.profit.uncountedSeconds).toBe(5 * HOUR)
    expect(money.profit.uncountedCurrencies).toEqual(['JPY'])
    expect(money.profit.labourCostMinor).toBe(600_00)
  })
})
