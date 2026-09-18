import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'
import { captureError } from '@workloom/db/testing/errors'

/**
 * Time tracking: one running timer per person, rates resolved and copied onto
 * entries so later changes leave history alone, whose time each role may see
 * or change, and the per-project rollup.
 *
 * Generic guarantees (audit, events, cross-tenant 404s, permission refusal) are
 * covered for every procedure in procedures.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')

const ORG_A = '01a0a700-0000-7000-8000-00000000000a'
const ORG_B = '01a0a700-0000-7000-8000-00000000000b'
let ownerA: string
let ownerB: string
let managerA: string
let financeA: string
let developerA: string
let secondDeveloperA: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  await import('../src/modules/index.ts')

  ownerA = core.newId()
  ownerB = core.newId()
  managerA = core.newId()
  financeA = core.newId()
  developerA = core.newId()
  secondDeveloperA = core.newId()

  await mod.withoutTenant('test setup', async (db) => {
    // Sydney is UTC+10 in September: the time zone decides which day a timer counts towards.
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone) values
        (${ORG_A}::uuid, 'Org A', 'time-a', 'AUD', 'Australia/Sydney'), (${ORG_B}::uuid, 'Org B', 'time-b', 'USD', 'UTC')`)
    await db.execute(sql`
      insert into "user" (id, name, email) values
        (${ownerA}::uuid, 'Owner A', 't-a@example.com'),
        (${ownerB}::uuid, 'Owner B', 't-b@example.com'),
        (${managerA}::uuid, 'Manager A', 't-manager@example.com'),
        (${financeA}::uuid, 'Finance A', 't-finance@example.com'),
        (${developerA}::uuid, 'Dev A', 't-dev@example.com'),
        (${secondDeveloperA}::uuid, 'Dev Two', 't-dev2@example.com')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role) values
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, 'owner'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${managerA}::uuid, 'manager'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${financeA}::uuid, 'finance'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${developerA}::uuid, 'developer'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${secondDeveloperA}::uuid, 'developer'),
        (${core.newId()}::uuid, ${ORG_B}::uuid, ${ownerB}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'manager' | 'finance' | 'developer'
const as = (organizationId: string, userId: string, role: Role) => ({
  organizationId,
  actor: { type: 'user' as const, id: userId, label: role },
  role,
  permissions: core.permissionsForRole(role) as ReadonlySet<string>,
})
const owner = () => as(ORG_A, ownerA, 'owner')
const manager = () => as(ORG_A, managerA, 'manager')
const finance = () => as(ORG_A, financeA, 'finance')
const developer = () => as(ORG_A, developerA, 'developer')
const otherDeveloper = () => as(ORG_A, secondDeveloperA, 'developer')

function run<T = any>(name: string, actor: ReturnType<typeof as>, input: unknown, now?: Date): Promise<T> {
  return registry.executeProcedure(name, { ...actor, permissions: actor.permissions as never, input, ...(now ? { now } : {}) }) as Promise<T>
}

const unique = () => core.newId().slice(-8)
const project = (input: Record<string, unknown> = {}) => run('project.create', owner(), { name: `P ${unique()}`, ...input })
const clientProject = async (input: Record<string, unknown> = {}) => {
  const company = await run('company.create', owner(), { name: `Client ${unique()}` })
  return project({ companyId: company.id, ...input })
}
const task = (projectId: string, input: Record<string, unknown> = {}) => run('task.create', owner(), { projectId, title: `T ${unique()}`, ...input })
const log = (actor: ReturnType<typeof as>, input: Record<string, unknown>) => run('timeEntry.create', actor, { durationSeconds: 3600, ...input })
const stopAll = async () => {
  for (const actor of [owner(), manager(), developer(), otherDeveloper()]) await run('timer.stop', actor, {}).catch(() => undefined)
}

async function runningTimers(userId: string): Promise<number> {
  const { rows } = await mod.withTenant(ORG_A, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from time_entries where user_id = ${userId}::uuid and ended_at is null and started_at is not null`),
  )
  return rows[0]!.n
}

describe('running timers', () => {
  it('are one per person, enforced by the database itself', async () => {
    await stopAll()
    const p = await project()
    const insertRunning = (userId: string) =>
      mod.withTenant(ORG_A, (tx) =>
        tx.execute(sql`insert into time_entries (id, organization_id, user_id, project_id, spent_on, started_at, billable, currency)
          values (${core.newId()}::uuid, ${ORG_A}::uuid, ${userId}::uuid, ${p.id}::uuid, '2026-09-14', now(), false, 'AUD')`),
      )

    await insertRunning(developerA)
    expect(await captureError(() => insertRunning(developerA))).toMatch(/time_entries_one_running_timer_key/)
    // Someone else's clock is their own.
    await expect(insertRunning(secondDeveloperA)).resolves.toBeDefined()
    // A stopped timer is not running.
    await mod.withTenant(ORG_A, (tx) =>
      tx.execute(sql`update time_entries set ended_at = now(), duration_seconds = 0 where user_id = ${developerA}::uuid and ended_at is null`),
    )
    await expect(insertRunning(developerA)).resolves.toBeDefined()
    await stopAll()
  })

  it('stay one per person when starts race each other', async () => {
    const p = await project()
    for (let attempt = 0; attempt < 5; attempt++) {
      await stopAll()
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => run('timer.start', developer(), { projectId: p.id })))
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
      for (const r of results) {
        // A start that loses the race is refused, never allowed to make a second clock.
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(core.ConflictError)
      }
      expect(await runningTimers(developerA)).toBe(1)
    }
    await stopAll()
  })

  it('stop the running one when another starts', async () => {
    await stopAll()
    const [p, q] = [await project(), await project()]
    const first = await run('timer.start', developer(), { projectId: p.id })
    expect(first).toMatchObject({ stopped: null, entry: { running: true, durationSeconds: null } })

    const second = await run('timer.start', developer(), { projectId: q.id })
    expect(second.stopped).toMatchObject({ id: first.entry.id, running: false })
    expect(second.stopped.durationSeconds).toBeGreaterThanOrEqual(0)
    expect(second.entry).toMatchObject({ projectId: q.id, running: true })
    expect((await run('timer.get', developer(), {})).entry.id).toBe(second.entry.id)
    await stopAll()
  })

  it('record their duration, counted towards the day they started in the organization\'s time zone', async () => {
    await stopAll()
    const p = await project()
    // 00:30 on the 15th in Sydney, though still the 14th in UTC.
    const started = await run('timer.start', developer(), { projectId: p.id }, new Date('2026-09-14T14:30:00Z'))
    expect(started.entry.spentOn).toBe('2026-09-15')

    const stopped = await run('timer.stop', developer(), {}, new Date('2026-09-14T16:00:00Z'))
    expect(stopped).toMatchObject({ durationSeconds: 5400, running: false, spentOn: '2026-09-15' })
    expect(stopped.endedAt).toEqual(new Date('2026-09-14T16:00:00Z'))
    await expect(run('timer.stop', developer(), {})).rejects.toMatchObject({ code: 'no_running_timer' })
  })

  it('can have their start corrected, but not a duration, and never start in the future', async () => {
    await stopAll()
    const p = await project()
    const now = new Date('2026-09-15T01:00:00Z')
    const { entry } = await run('timer.start', developer(), { projectId: p.id }, now)
    await expect(run('timeEntry.update', developer(), { id: entry.id, durationSeconds: 600 }, now)).rejects.toMatchObject({ code: 'timer_running' })
    await expect(run('timeEntry.update', developer(), { id: entry.id, startedAt: '2026-09-15T02:00:00Z' }, now)).rejects.toMatchObject({
      code: 'started_in_future',
    })
    const moved = await run('timeEntry.update', developer(), { id: entry.id, startedAt: '2026-09-15T00:15:00Z' }, now)
    expect(moved.startedAt).toEqual(new Date('2026-09-15T00:15:00Z'))
    const stopped = await run('timer.stop', developer(), {}, now)
    expect(stopped.durationSeconds).toBe(45 * 60)
    await expect(run('timeEntry.update', developer(), { id: entry.id, startedAt: '2026-09-15T00:00:00Z' })).rejects.toMatchObject({
      code: 'timer_not_running',
    })
  })
})

describe('rates', () => {
  it('resolve from the project, then the person, then the organization -- each rate on its own', async () => {
    await run('rate.set', owner(), { billableRateMinor: 100_00, costRateMinor: 50_00 })
    await run('rate.set', owner(), { userId: developerA, billableRateMinor: 150_00, costRateMinor: null })
    const p = await project()
    await run('projectMember.add', owner(), { id: p.id, userId: developerA, costRateMinor: 70_00 })

    const mine = await log(developer(), { projectId: p.id })
    const asSeenByOwner = await run('timeEntry.get', owner(), { id: mine.id })
    expect(asSeenByOwner).toMatchObject({
      currency: 'AUD',
      billableRateMinor: 150_00,
      billableRateSource: 'member',
      costRateMinor: 70_00,
      costRateSource: 'project_member',
    })

    const theirs = await log(otherDeveloper(), { projectId: p.id })
    expect(await run('timeEntry.get', owner(), { id: theirs.id })).toMatchObject({
      billableRateMinor: 100_00,
      billableRateSource: 'organization',
      costRateMinor: 50_00,
      costRateSource: 'organization',
    })
  })

  it('apply only to projects in their own currency', async () => {
    const usd = await project({ currency: 'USD' })
    const before = await log(developer(), { projectId: usd.id })
    expect(await run('timeEntry.get', owner(), { id: before.id })).toMatchObject({
      currency: 'USD',
      billableRateMinor: null,
      billableRateSource: null,
      costRateMinor: null,
    })

    await run('rate.set', owner(), { currency: 'USD', billableRateMinor: 90_00, costRateMinor: 40_00 })
    const after = await log(developer(), { projectId: usd.id })
    expect(await run('timeEntry.get', owner(), { id: after.id })).toMatchObject({ billableRateMinor: 90_00, costRateMinor: 40_00 })
    expect((await run('rate.list', owner(), { currency: 'USD' })).organization).toMatchObject({ billableRateMinor: 90_00 })
  })

  it('are copied onto entries, so changing any of them leaves logged time alone', async () => {
    await run('rate.set', owner(), { billableRateMinor: 100_00, costRateMinor: 50_00 })
    await run('rate.set', owner(), { userId: secondDeveloperA, billableRateMinor: 120_00, costRateMinor: 60_00 })
    const p = await clientProject()
    const member = await run('projectMember.add', owner(), { id: p.id, userId: secondDeveloperA, billableRateMinor: 140_00 })

    const logged = await log(otherDeveloper(), { projectId: p.id, durationSeconds: 7200 })
    const summaryBefore = await run('timeEntry.summary', owner(), { id: p.id })
    expect(summaryBefore.totals).toMatchObject({ billableValueMinor: 280_00, costMinor: 120_00 })

    // A raise, a new override, and a new organization default.
    await run('projectMember.update', owner(), { id: member.id, billableRateMinor: 200_00, costRateMinor: 90_00 })
    await run('rate.set', owner(), { userId: secondDeveloperA, billableRateMinor: 180_00, costRateMinor: 95_00 })
    await run('rate.set', owner(), { billableRateMinor: 130_00, costRateMinor: 65_00 })

    expect(await run('timeEntry.get', owner(), { id: logged.id })).toMatchObject({ billableRateMinor: 140_00, costRateMinor: 60_00 })
    expect((await run('timeEntry.summary', owner(), { id: p.id })).totals).toEqual(summaryBefore.totals)

    // Time logged from now on takes the new rates.
    const later = await log(otherDeveloper(), { projectId: p.id })
    expect(await run('timeEntry.get', owner(), { id: later.id })).toMatchObject({ billableRateMinor: 200_00, costRateMinor: 90_00 })
  })

  it('cost nothing per hour for a member on a fixed engagement fee', async () => {
    await run('rate.set', owner(), { billableRateMinor: 100_00, costRateMinor: 50_00 })
    const p = await clientProject()
    await run('projectMember.add', owner(), { id: p.id, userId: developerA, billableRateMinor: 200_00, fixedFeeMinor: 4_000_00, fixedFeeOn: '2026-09-01' })

    const entry = await log(developer(), { projectId: p.id, durationSeconds: 7200 })
    expect(await run('timeEntry.get', owner(), { id: entry.id })).toMatchObject({
      // The fee is the cost, so the hours cost nothing -- and say why.
      costRateMinor: 0,
      costRateSource: 'project_member_fixed',
      // What the client is charged is untouched by what the person costs us.
      billableRateMinor: 200_00,
      billableRateSource: 'project_member',
    })

    const financials = await run('project.financials', owner(), { id: p.id })
    expect(financials.currencies[0]).toMatchObject({
      labourCostMinor: 0,
      fixedCostMinor: 4_000_00,
      membersWithFixedFee: 1,
      costMinor: 4_000_00,
      // Nothing billed yet, so the fee is the whole of the loss so far.
      marginMinor: -4_000_00,
      // Zero is a rate. These entries are not missing one.
      entriesWithoutCostRate: 0,
      billableSeconds: 7200,
    })
  })

  it('refuse a fixed fee over time already logged at an hourly cost, until it is confirmed', async () => {
    await run('rate.set', owner(), { billableRateMinor: 100_00, costRateMinor: 50_00 })
    const p = await clientProject()
    const member = await run('projectMember.add', owner(), { id: p.id, userId: developerA, costRateMinor: 70_00 })
    await log(developer(), { projectId: p.id, durationSeconds: 3600 })
    await log(developer(), { projectId: p.id, durationSeconds: 3600 })
    expect((await run('project.financials', owner(), { id: p.id })).currencies[0]).toMatchObject({ labourCostMinor: 140_00 })

    await expect(run('projectMember.update', owner(), { id: member.id, fixedFeeMinor: 4_000_00 })).rejects.toThrow(
      /already has 2 time entries .* logged at an hourly cost/s,
    )
    // Refused means refused: nothing moved.
    expect((await run('project.financials', owner(), { id: p.id })).currencies[0]).toMatchObject({ labourCostMinor: 140_00, fixedCostMinor: 0 })

    await run('projectMember.update', owner(), { id: member.id, fixedFeeMinor: 4_000_00, rebaseLoggedCost: true })
    expect((await run('project.financials', owner(), { id: p.id })).currencies[0]).toMatchObject({
      labourCostMinor: 0,
      fixedCostMinor: 4_000_00,
      costMinor: 4_000_00,
    })

    // Changing the amount afterwards needs no confirmation: the entries already cost nothing.
    await run('projectMember.update', owner(), { id: member.id, fixedFeeMinor: 5_000_00 })
    expect((await run('project.financials', owner(), { id: p.id })).currencies[0]).toMatchObject({ fixedCostMinor: 5_000_00 })
  })

  it('keep a fixed fee out of events and away from anyone who cannot see money', async () => {
    const p = await clientProject()
    const member = await run('projectMember.add', owner(), { id: p.id, userId: developerA, fixedFeeMinor: 4_000_00 })
    expect(member).toMatchObject({ fixedFeeMinor: 4_000_00 })

    const asDeveloper = await run('projectMember.list', developer(), { id: p.id })
    expect(asDeveloper.data.find((m: { userId: string }) => m.userId === developerA)).toMatchObject({
      fixedFeeMinor: null,
      costRateMinor: null,
    })
  })

  it('resolve again when an entry moves to another project', async () => {
    await run('rate.set', owner(), { billableRateMinor: 100_00, costRateMinor: 50_00 })
    const [p, q] = [await project(), await project({ currency: 'NZD' })]
    const entry = await log(developer(), { projectId: p.id })
    const moved = await run('timeEntry.update', owner(), { id: entry.id, projectId: q.id })
    expect(moved).toMatchObject({ projectId: q.id, currency: 'NZD', billableRateMinor: null, costRateMinor: null })
  })

  it('are shown only with financial access and never sent in events', async () => {
    await run('rate.set', owner(), { billableRateMinor: 100_00, costRateMinor: 50_00 })
    const p = await project()
    const entry = await log(developer(), { projectId: p.id })
    expect(entry).toMatchObject({ billableRateMinor: null, costRateMinor: null, billableRateSource: null })
    expect(await run('timeEntry.get', finance(), { id: entry.id })).toMatchObject({ billableRateMinor: expect.any(Number) })

    await expect(run('rate.list', developer(), {})).rejects.toBeInstanceOf(core.ForbiddenError)
    await expect(run('rate.set', developer(), { billableRateMinor: 1, costRateMinor: 1 })).rejects.toBeInstanceOf(core.ForbiddenError)
    // Setting a rate is reading it: rate:update alone is not enough.
    const rateOnly = { ...owner(), permissions: new Set(['rate:update']) as ReadonlySet<string> }
    await expect(run('rate.set', rateOnly, { billableRateMinor: 1, costRateMinor: 1 })).rejects.toBeInstanceOf(core.ForbiddenError)
    await expect(run('rate.set', finance(), { userId: developerA, billableRateMinor: 110_00, costRateMinor: 55_00 })).resolves.toBeDefined()

    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ data: unknown }>(sql`select data from events where type like 'time_entry.%'`),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows.map((r) => r.data))).not.toMatch(/rate/i)
  })

  it('belong only to members of the organization', async () => {
    await expect(run('rate.set', owner(), { userId: ownerB, billableRateMinor: 1, costRateMinor: 1 })).rejects.toMatchObject({ code: 'not_member' })
  })

  it('can be cleared', async () => {
    await run('rate.set', owner(), { userId: developerA, currency: 'EUR', billableRateMinor: 1_00, costRateMinor: null })
    await run('rate.set', owner(), { userId: developerA, currency: 'EUR', billableRateMinor: null, costRateMinor: null })
    const { members } = await run('rate.list', owner(), { currency: 'EUR' })
    expect(members.find((m: { userId: string }) => m.userId === developerA)).toMatchObject({ billableRateMinor: null, updatedAt: null })
  })
})

describe('whose time', () => {
  it('developers see and change only their own', async () => {
    const p = await project()
    const mine = await log(developer(), { projectId: p.id, description: 'mine' })

    await expect(run('timeEntry.get', otherDeveloper(), { id: mine.id })).rejects.toBeInstanceOf(core.NotFoundError)
    await expect(run('timeEntry.update', otherDeveloper(), { id: mine.id, description: 'hijacked' })).rejects.toBeInstanceOf(core.NotFoundError)
    await expect(run('timeEntry.delete', otherDeveloper(), { id: mine.id })).rejects.toBeInstanceOf(core.NotFoundError)
    await expect(run('timeEntry.list', otherDeveloper(), { userId: developerA })).rejects.toBeInstanceOf(core.ForbiddenError)
    const listed = await run('timeEntry.list', otherDeveloper(), { projectId: p.id })
    expect(listed.data).toEqual([])
    await expect(log(developer(), { projectId: p.id, userId: secondDeveloperA })).rejects.toBeInstanceOf(core.ForbiddenError)
  })

  it('managers can correct anyone\'s, and finance can read but not change it', async () => {
    const p = await project()
    const entry = await log(developer(), { projectId: p.id })

    expect(await run('timeEntry.update', manager(), { id: entry.id, durationSeconds: 1800 })).toMatchObject({ durationSeconds: 1800 })
    expect((await run('timeEntry.list', manager(), { projectId: p.id })).data).toHaveLength(1)
    expect(await run('timeEntry.get', finance(), { id: entry.id })).toMatchObject({ id: entry.id })
    await expect(run('timeEntry.update', finance(), { id: entry.id, durationSeconds: 60 })).rejects.toBeInstanceOf(core.ForbiddenError)

    const onBehalf = await log(manager(), { projectId: p.id, userId: secondDeveloperA })
    expect(onBehalf.userId).toBe(secondDeveloperA)
    await expect(log(manager(), { projectId: p.id, userId: ownerB })).rejects.toMatchObject({ code: 'not_member' })
  })

  it('a manager can stop a timer someone forgot', async () => {
    await stopAll()
    const p = await project()
    const { entry } = await run('timer.start', developer(), { projectId: p.id })
    await expect(run('timer.stop', otherDeveloper(), { id: entry.id })).rejects.toBeInstanceOf(core.NotFoundError)
    expect(await run('timer.stop', manager(), { id: entry.id })).toMatchObject({ running: false, userId: developerA })
  })
})

describe('where time goes', () => {
  it('a task must belong to the entry\'s project, even written directly', async () => {
    const [p, q] = [await project(), await project()]
    const other = await task(q.id)
    await expect(log(developer(), { projectId: p.id, taskId: other.id })).rejects.toMatchObject({ code: 'task_project_mismatch' })
    // A task alone implies its project.
    expect(await log(developer(), { taskId: other.id })).toMatchObject({ projectId: q.id, taskId: other.id })
    await expect(log(developer(), {})).rejects.toMatchObject({ code: 'project_required' })

    const message = await captureError(() =>
      mod.withTenant(ORG_A, (tx) =>
        tx.execute(sql`insert into time_entries (id, organization_id, user_id, project_id, task_id, spent_on, duration_seconds, billable, currency)
          values (${core.newId()}::uuid, ${ORG_A}::uuid, ${developerA}::uuid, ${p.id}::uuid, ${other.id}::uuid, '2026-09-14', 60, false, 'AUD')`),
      ),
    )
    expect(message).toMatch(/time_entries_task_fk/)
  })

  it('a task with time logged cannot be deleted, only cancelled', async () => {
    const p = await project()
    const t = await task(p.id)
    await log(developer(), { taskId: t.id })
    await expect(run('task.delete', owner(), { id: t.id })).rejects.toMatchObject({ code: 'task_has_time' })
    const message = await captureError(() => mod.withTenant(ORG_A, (tx) => tx.execute(sql`delete from tasks where id = ${t.id}::uuid`)))
    expect(message).toMatch(/time_entries_task_fk/)
    await expect(run('task.changeStatus', owner(), { id: t.id, status: 'cancelled' })).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('a project with time logged keeps its currency', async () => {
    const p = await project()
    await expect(run('project.update', owner(), { id: p.id, currency: 'USD' })).resolves.toMatchObject({ currency: 'USD' })
    await log(developer(), { projectId: p.id })
    await expect(run('project.update', owner(), { id: p.id, currency: 'AUD' })).rejects.toMatchObject({ code: 'currency_locked' })
  })

  it('an archived project takes no new time, but its running timer can still be stopped', async () => {
    await stopAll()
    const p = await project()
    const entry = await log(developer(), { projectId: p.id })
    const { entry: timer } = await run('timer.start', developer(), { projectId: p.id })
    await run('project.archive', owner(), { id: p.id })

    await expect(log(developer(), { projectId: p.id })).rejects.toMatchObject({ code: 'archived' })
    await expect(run('timer.start', otherDeveloper(), { projectId: p.id })).rejects.toMatchObject({ code: 'archived' })
    await expect(run('timeEntry.update', developer(), { id: entry.id, description: 'late edit' })).rejects.toMatchObject({ code: 'archived' })
    expect(await run('timer.stop', developer(), {})).toMatchObject({ id: timer.id, running: false })
  })

  it('is billable by default only for client work', async () => {
    const [internal, client] = [await project(), await clientProject()]
    expect(await log(developer(), { projectId: internal.id })).toMatchObject({ billable: false })
    expect(await log(developer(), { projectId: client.id })).toMatchObject({ billable: true })
    expect(await log(developer(), { projectId: client.id, billable: false })).toMatchObject({ billable: false })
  })

  it('is listed whether billable, not, or running, unless a filter says otherwise', async () => {
    await stopAll()
    const p = await clientProject()
    const billable = await log(developer(), { projectId: p.id })
    const internal = await log(developer(), { projectId: p.id, billable: false })
    const { entry: running } = await run('timer.start', developer(), { projectId: p.id })
    const ids = async (filters: Record<string, unknown>) =>
      (await run('timeEntry.list', developer(), { projectId: p.id, ...filters })).data.map((e: { id: string }) => e.id).sort()

    expect(await ids({})).toEqual([billable.id, internal.id, running.id].sort())
    expect(await ids({ billable: 'true' })).toEqual([billable.id, running.id].sort())
    expect(await ids({ billable: 'false' })).toEqual([internal.id])
    expect(await ids({ running: 'true' })).toEqual([running.id])
    await stopAll()
  })

  it('is logged by hand in whole seconds, between a minute and a day', async () => {
    const p = await project()
    await expect(log(developer(), { projectId: p.id, durationSeconds: 59 })).rejects.toBeInstanceOf(ZodError)
    await expect(log(developer(), { projectId: p.id, durationSeconds: 24 * 3600 + 1 })).rejects.toBeInstanceOf(ZodError)
    await expect(log(developer(), { projectId: p.id, durationSeconds: 90.5 })).rejects.toBeInstanceOf(ZodError)
    // Today, where the organization is.
    const entry = await run('timeEntry.create', developer(), { projectId: p.id, durationSeconds: 60 }, new Date('2026-09-14T15:00:00Z'))
    expect(entry.spentOn).toBe('2026-09-15')
  })
})

describe('the project summary', () => {
  it('adds up time by person and task, valued at each entry\'s own rates', async () => {
    await stopAll()
    await run('rate.set', owner(), { billableRateMinor: 100_00, costRateMinor: 50_00 })
    await run('rate.set', owner(), { userId: developerA, billableRateMinor: 150_00, costRateMinor: 70_00 })
    await run('rate.set', owner(), { userId: secondDeveloperA, billableRateMinor: null, costRateMinor: null })
    await run('rate.set', owner(), { userId: ownerA, billableRateMinor: null, costRateMinor: null })
    const p = await clientProject()
    const design = await task(p.id, { estimateMinutes: 120 })

    await log(developer(), { taskId: design.id, durationSeconds: 5400 }) // 225.00 billed, 105.00 cost
    await log(otherDeveloper(), { taskId: design.id, durationSeconds: 1200 }) // 33.33 billed, 16.67 cost
    await log(owner(), { projectId: p.id, durationSeconds: 3600, billable: false }) // 50.00 cost
    await run('timer.start', developer(), { projectId: p.id }) // running: not counted

    const summary = await run('timeEntry.summary', manager(), { id: p.id })
    expect(summary).toMatchObject({ currency: 'AUD', runningTimers: 1 })
    expect(summary.totals).toEqual({
      seconds: 10_200,
      billableSeconds: 6600,
      billableValueMinor: 258_33,
      costMinor: 171_67,
      unratedBillableSeconds: 0,
      unratedCostSeconds: 0,
    })
    expect(summary.byPerson.map((r: { name: string; seconds: number }) => [r.name, r.seconds])).toEqual([
      ['Dev A', 5400],
      ['Owner A', 3600],
      ['Dev Two', 1200],
    ])
    expect(summary.byTask).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: design.id, seconds: 6600, estimateMinutes: 120, billableValueMinor: 258_33 }),
        expect.objectContaining({ taskId: null, title: null, seconds: 3600, billableSeconds: 0, costMinor: 50_00 }),
      ]),
    )
    await stopAll()
  })

  it('counts time it cannot value, and hides money from those who cannot see it', async () => {
    const p = await clientProject({ currency: 'JPY' })
    await log(developer(), { projectId: p.id, durationSeconds: 3600 })
    expect((await run('timeEntry.summary', owner(), { id: p.id })).totals).toMatchObject({
      billableValueMinor: 0,
      unratedBillableSeconds: 3600,
      unratedCostSeconds: 3600,
    })

    await expect(run('timeEntry.summary', developer(), { id: p.id })).rejects.toBeInstanceOf(core.ForbiddenError)
    const noMoney = { ...manager(), permissions: new Set([...core.permissionsForRole('manager')].filter((x) => x !== 'report:readFinancial')) as ReadonlySet<string> }
    expect((await run('timeEntry.summary', noMoney, { id: p.id })).totals).toMatchObject({ seconds: 3600, billableValueMinor: null, costMinor: null })
  })
})
