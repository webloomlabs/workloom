import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Projects by how they are paid for, and budgets that speak up (S17): a
 * fixed-price build measured over the whole job, a retainer measured month by
 * month, and an alert that fires once per threshold per budget period.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')
let emails: typeof import('@workloom/emails')

const ORG = '01a0dd00-0000-7000-8000-0000000017aa'
let owner: string
let developer: string

const HOUR = 3600

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')
  emails = await import('@workloom/emails')
  owner = core.newId()
  developer = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`insert into organization (id, name, slug, base_currency, timezone) values (${ORG}::uuid, 'Webloom', 'webloom-s17', 'LKR', 'Asia/Colombo')`)
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}::uuid, 'Owner', 's17-owner@example.com'), (${developer}::uuid, 'Dev', 's17-dev@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values
      (${core.newId()}::uuid, ${ORG}::uuid, ${owner}::uuid, 'owner'),
      (${core.newId()}::uuid, ${ORG}::uuid, ${developer}::uuid, 'developer')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'developer'
const as = (userId: string, role: Role) => ({ organizationId: ORG, actor: { type: 'user' as const, id: userId, label: role }, role, permissions: core.permissionsForRole(role) })
function run<T = any>(name: string, input: unknown, options: { now?: Date; actor?: ReturnType<typeof as> } = {}): Promise<T> {
  return registry.executeProcedure(name, { ...(options.actor ?? as(owner, 'owner')), input, ...(options.now ? { now: options.now } : {}) }) as Promise<T>
}
async function refused(name: string, input: unknown, code: string) {
  await expect(run(name, input)).rejects.toMatchObject({ code })
}
/** The worker's sweep: as a job, with what it leaves for after the commit run once it has committed. */
async function sweep(now: Date, projectIds?: string[]): Promise<number> {
  const hooks = { commit: [] as Array<() => Promise<void>>, rollback: [] as Array<() => Promise<void>> }
  const raised = await mod.withTenant(ORG, (tx) =>
    modules.sweepProjectBudgets(registry.buildContext({ organizationId: ORG, actor: { type: 'job', label: 'project budgets' }, role: null, permissions: new Set(), now }, tx, hooks), projectIds),
  )
  for (const task of hooks.commit) await task()
  return raised
}
const unique = () => core.newId().slice(-8)
const on = (date: string) => new Date(`${date}T06:00:00Z`)
const company = async () => (await run('company.create', { name: `Client ${unique()}` })).id as string
async function alerts(projectId: string) {
  const { rows } = await mod.withTenant(ORG, (tx) =>
    tx.execute<{ measure: string; threshold: number; period_start: string }>(
      sql`select measure, threshold, period_start::text from project_budget_alerts where project_id = ${projectId}::uuid order by period_start, measure, threshold`,
    ),
  )
  return rows.map((r) => `${r.period_start} ${r.measure} ${r.threshold}`)
}

describe('project types and billing models', () => {
  it("start with the agency's kinds of work, whose defaults a new project takes", async () => {
    const types = (await run('projectType.list', {})).data
    expect(types.map((t: any) => t.name)).toEqual(['Web development', 'Web development + maintenance', 'Digital marketing', 'Support and maintenance'])
    const marketing = types.find((t: any) => t.name === 'Digital marketing')
    expect(marketing).toMatchObject({ defaultBillingModel: 'retainer', defaultBudgetPeriod: 'month' })

    const project = await run('project.create', { companyId: await company(), name: 'Social for Kyla', projectTypeId: marketing.id })
    expect(project).toMatchObject({ billingModel: 'retainer', budgetPeriod: 'month', projectTypeName: 'Digital marketing' })

    const build = await run('project.create', { companyId: await company(), name: 'Store build', contractValueMinor: 65_000_00 })
    expect(build).toMatchObject({ billingModel: 'fixed_price', budgetPeriod: 'total' })
    const internal = await run('project.create', { name: 'Our own website' })
    expect(internal.billingModel).toBe('non_billable')
  })

  it('refuse money terms that do not fit how the project is paid', async () => {
    await refused('project.create', { companyId: await company(), name: 'Retainer with a price', billingModel: 'retainer', contractValueMinor: 1_00 }, 'retainer_contract_value')
    await refused('project.create', { companyId: await company(), name: 'Monthly build', billingModel: 'fixed_price', budgetPeriod: 'month' }, 'fixed_price_period')
    const project = await run('project.create', { companyId: await company(), name: 'Becomes a retainer', contractValueMinor: 10_00 })
    await refused('project.update', { id: project.id, billingModel: 'retainer' }, 'retainer_contract_value')
    const changed = await run('project.update', { id: project.id, billingModel: 'retainer', contractValueMinor: null, budgetPeriod: 'month' })
    expect(changed).toMatchObject({ billingModel: 'retainer', budgetPeriod: 'month', contractValueMinor: null })
  })

  it('can be archived without changing projects already running', async () => {
    const type = await run('projectType.create', { name: 'SEO', defaultBillingModel: 'retainer' })
    expect(type.defaultBudgetPeriod).toBe('month')
    const project = await run('project.create', { companyId: await company(), name: 'SEO for a client', projectTypeId: type.id })
    await run('projectType.update', { id: type.id, archived: true, defaultBillingModel: 'time_and_materials', defaultBudgetPeriod: 'total' })
    expect((await run('project.get', { id: project.id })).billingModel).toBe('retainer')
    await refused('project.create', { name: 'Another', projectTypeId: type.id }, 'project_type_archived')
  })
})

describe('budgets', () => {
  it('measure a retainer month by month, and start again each month', async () => {
    await run('rate.set', { billableRateMinor: 5_000_00, costRateMinor: 2_000_00 })
    const project = await run('project.create', { companyId: await company(), name: `Retainer ${unique()}`, billingModel: 'retainer', budgetMinor: 20_000_00, budgetHours: '10' })
    await run('timeEntry.create', { projectId: project.id, durationSeconds: 8 * HOUR, spentOn: '2026-03-10' })
    await run('timeEntry.create', { projectId: project.id, durationSeconds: 2 * HOUR, spentOn: '2026-04-02' })

    const march = await run('project.budget', { id: project.id, on: '2026-03-31' })
    expect(march).toMatchObject({ window: { from: '2026-03-01', to: '2026-03-31' }, costMinor: 16_000_00, costPercent: 80, loggedHours: 8, hoursPercent: 80, level: 'warning' })
    const april = await run('project.budget', { id: project.id, on: '2026-04-15' })
    expect(april).toMatchObject({ costMinor: 4_000_00, costPercent: 20, level: 'ok' })
  })

  it('measure a build over the whole job, its hours against the tasks’ estimates', async () => {
    const project = await run('project.create', { companyId: await company(), name: `Build ${unique()}`, contractValueMinor: 80_000_00, budgetMinor: 40_000_00 })
    await run('task.create', { projectId: project.id, title: 'Design', estimateMinutes: 600 })
    await run('task.create', { projectId: project.id, title: 'Build', estimateMinutes: 1200 })
    await run('timeEntry.create', { projectId: project.id, durationSeconds: 12 * HOUR, spentOn: '2026-01-10' })
    await run('timeEntry.create', { projectId: project.id, durationSeconds: 13 * HOUR, spentOn: '2026-01-11' })
    const expense = await run('expense.create', { description: 'Theme licence', amountMinor: 1_000_00, projectId: project.id })
    expect(expense.status).toBe('confirmed')
    // A draft is not a cost yet.
    await run('expense.create', { description: 'Unchecked', amountMinor: 50_000_00, projectId: project.id, status: 'draft' })

    const budget = await run('project.budget', { id: project.id })
    expect(budget).toMatchObject({
      window: null,
      labourCostMinor: 50_000_00,
      expenseCostMinor: 1_000_00,
      costMinor: 51_000_00,
      costPercent: 127,
      budgetHours: 30,
      hoursSource: 'estimates',
      loggedHours: 25,
      hoursPercent: 83,
      level: 'over',
    })
  })

  it('are commercial: a developer cannot read them', async () => {
    const project = await run('project.create', { companyId: await company(), name: `Private ${unique()}`, budgetMinor: 1_00 })
    await expect(run('project.budget', { id: project.id }, { actor: as(developer, 'developer') })).rejects.toBeInstanceOf(core.ForbiddenError)
    expect((await run('project.get', { id: project.id }, { actor: as(developer, 'developer') })).budgetHours).toBeNull()
  })
})

describe('budget alerts', () => {
  it('fire once per threshold per period, tell the owner, and fire again next month', async () => {
    emails.clearSentEmails()
    const project = await run('project.create', { companyId: await company(), name: `Alerted ${unique()}`, billingModel: 'retainer', budgetMinor: 10_000_00 })
    await run('timeEntry.create', { projectId: project.id, durationSeconds: 4 * HOUR, spentOn: '2026-05-05' })

    expect(await sweep(on('2026-05-06'), [project.id])).toBe(1)
    expect(await alerts(project.id)).toEqual(['2026-05-01 cost 80'])
    // The next hour says nothing new.
    expect(await sweep(on('2026-05-06'), [project.id])).toBe(0)
    const sent = emails.sentEmails().filter((e) => e.subject.includes(project.name))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('s17-owner@example.com')
    expect(sent[0]!.subject).toContain('80%')

    await run('timeEntry.create', { projectId: project.id, durationSeconds: 2 * HOUR, spentOn: '2026-05-20' })
    expect(await sweep(on('2026-05-21'), [project.id])).toBe(1)
    expect(await alerts(project.id)).toEqual(['2026-05-01 cost 80', '2026-05-01 cost 100'])

    // A new month is a new budget.
    await run('timeEntry.create', { projectId: project.id, durationSeconds: 5 * HOUR, spentOn: '2026-06-03' })
    expect(await sweep(on('2026-06-04'), [project.id])).toBe(2)
    expect(await alerts(project.id)).toEqual(['2026-05-01 cost 80', '2026-05-01 cost 100', '2026-06-01 cost 80', '2026-06-01 cost 100'])

    const { rows } = await mod.withTenant(ORG, (tx) =>
      tx.execute<{ type: string }>(sql`select type from events where type = 'project.budget_threshold_crossed' and data->'project'->>'id' = ${project.id}`),
    )
    expect(rows).toHaveLength(4)
  })

  it('leave finished and archived projects alone', async () => {
    const project = await run('project.create', { companyId: await company(), name: `Finished ${unique()}`, billingModel: 'retainer', budgetMinor: 1_00 })
    await run('timeEntry.create', { projectId: project.id, durationSeconds: HOUR, spentOn: '2026-07-01' })
    await run('project.changeStatus', { id: project.id, status: 'completed' })
    await sweep(on('2026-07-02'))
    expect(await alerts(project.id)).toEqual([])
  })

  it('rank the projects at risk first', async () => {
    const report = await run('report.projectBudgets', { atRisk: true })
    expect(report.data.length).toBeGreaterThan(0)
    expect(report.data.every((b: any) => b.level === 'warning' || b.level === 'over')).toBe(true)
    expect(report.data[0].level).toBe('over')
  })
})
