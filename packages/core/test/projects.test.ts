import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Projects, milestones, and tasks: dependencies and their cycles, derived
 * progress, who sees money, comments, and files that round-trip through storage.
 *
 * Generic guarantees (audit, events, cross-tenant 404s, permission refusal) are
 * covered for every procedure in procedures.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let storage: typeof import('@workloom/storage')

const ORG_A = '01a0a600-0000-7000-8000-00000000000a'
const ORG_B = '01a0a600-0000-7000-8000-00000000000b'
let ownerA: string
let ownerB: string
let developerA: string
let secondDeveloperA: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  storage = await import('@workloom/storage')
  await import('../src/modules/index.ts')

  ownerA = core.newId()
  ownerB = core.newId()
  developerA = core.newId()
  secondDeveloperA = core.newId()

  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency) values
        (${ORG_A}::uuid, 'Org A', 'projects-a', 'AUD'), (${ORG_B}::uuid, 'Org B', 'projects-b', 'USD')`)
    await db.execute(sql`
      insert into "user" (id, name, email) values
        (${ownerA}::uuid, 'Owner A', 'p-a@example.com'),
        (${ownerB}::uuid, 'Owner B', 'p-b@example.com'),
        (${developerA}::uuid, 'Dev A', 'p-dev@example.com'),
        (${secondDeveloperA}::uuid, 'Dev Two', 'p-dev2@example.com')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role) values
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${ownerA}::uuid, 'owner'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${developerA}::uuid, 'developer'),
        (${core.newId()}::uuid, ${ORG_A}::uuid, ${secondDeveloperA}::uuid, 'developer'),
        (${core.newId()}::uuid, ${ORG_B}::uuid, ${ownerB}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'developer'
const as = (organizationId: string, userId: string, role: Role) => ({
  organizationId,
  actor: { type: 'user' as const, id: userId, label: role },
  role,
  permissions: core.permissionsForRole(role),
})
const owner = () => as(ORG_A, ownerA, 'owner')
const developer = () => as(ORG_A, developerA, 'developer')
const otherDeveloper = () => as(ORG_A, secondDeveloperA, 'developer')

function run<T = any>(name: string, actor: ReturnType<typeof as>, input: unknown): Promise<T> {
  return registry.executeProcedure(name, { ...actor, input }) as Promise<T>
}

const unique = () => core.newId().slice(-8)
const project = (input: Record<string, unknown> = {}) => run('project.create', owner(), { name: `P ${unique()}`, ...input })
const task = (projectId: string, input: Record<string, unknown> = {}) =>
  run('task.create', owner(), { projectId, title: `T ${unique()}`, ...input })
const dependOn = (id: string, dependsOnTaskId: string) => run('taskDependency.add', owner(), { id, dependsOnTaskId })

describe('task dependencies', () => {
  it('refuse a task depending on itself', async () => {
    const p = await project()
    const a = await task(p.id)
    await expect(dependOn(a.id, a.id)).rejects.toMatchObject({ code: 'dependency_cycle' })
  })

  it('refuse a direct cycle', async () => {
    const p = await project()
    const [a, b] = [await task(p.id), await task(p.id)]
    await dependOn(b.id, a.id)
    await expect(dependOn(a.id, b.id)).rejects.toMatchObject({ code: 'dependency_cycle' })
  })

  it('refuse a cycle through several tasks', async () => {
    const p = await project()
    const [a, b, c, d] = [await task(p.id), await task(p.id), await task(p.id), await task(p.id)]
    await dependOn(b.id, a.id)
    await dependOn(c.id, b.id)
    await dependOn(d.id, c.id)
    await expect(dependOn(a.id, d.id)).rejects.toMatchObject({ code: 'dependency_cycle' })
    // A diamond is not a cycle.
    await expect(dependOn(d.id, a.id)).resolves.toMatchObject({ dependencies: expect.arrayContaining([expect.objectContaining({ id: a.id })]) })
  })

  it('refuse a cycle created by two requests at once', async () => {
    // Each request alone sees no cycle. Without the project lock both would commit.
    for (let attempt = 0; attempt < 5; attempt++) {
      const p = await project()
      const [a, b] = [await task(p.id), await task(p.id)]
      const results = await Promise.allSettled([dependOn(a.id, b.id), dependOn(b.id, a.id)])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const { rows } = await mod.withTenant(ORG_A, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from task_dependencies where project_id = ${p.id}::uuid`),
      )
      expect(rows[0]!.n).toBe(1)
    }
  })

  it('stay within one project, even written directly', async () => {
    const [p, q] = [await project(), await project()]
    const [a, b] = [await task(p.id), await task(q.id)]
    await expect(dependOn(a.id, b.id)).rejects.toMatchObject({ code: 'dependency_project_mismatch' })

    const error = await mod
      .withTenant(ORG_A, (tx) =>
        tx.execute(sql`insert into task_dependencies (organization_id, project_id, task_id, depends_on_task_id)
          values (${ORG_A}::uuid, ${p.id}::uuid, ${a.id}::uuid, ${b.id}::uuid)`),
      )
      .catch((e: unknown) => e)
    expect(String((error as { cause?: unknown }).cause ?? error)).toMatch(/foreign key/i)
  })

  it('hold a task open until what it waits on is done or cancelled', async () => {
    const p = await project()
    const [design, build, copy] = [await task(p.id), await task(p.id), await task(p.id)]
    await dependOn(build.id, design.id)
    await dependOn(build.id, copy.id)

    await expect(run('task.changeStatus', owner(), { id: build.id, status: 'done' })).rejects.toMatchObject({
      code: 'blocked_by_dependencies',
    })
    expect((await run('task.get', owner(), { id: build.id })).openDependencies).toBe(2)

    await run('task.changeStatus', owner(), { id: design.id, status: 'done' })
    await run('task.changeStatus', owner(), { id: copy.id, status: 'cancelled' })
    const done = await run('task.changeStatus', owner(), { id: build.id, status: 'done' })
    expect(done).toMatchObject({ status: 'done', openDependencies: 0 })
    expect(done.completedAt).toBeInstanceOf(Date)
  })
})

describe('milestones', () => {
  it('can only hold tasks from their own project', async () => {
    const [p, q] = [await project(), await project()]
    const milestone = await run('milestone.create', owner(), { id: q.id, name: 'Elsewhere' })
    await expect(task(p.id, { milestoneId: milestone.id })).rejects.toMatchObject({ code: 'milestone_project_mismatch' })

    const error = await mod
      .withTenant(ORG_A, (tx) =>
        tx.execute(sql`insert into tasks (id, organization_id, project_id, milestone_id, title)
          values (${core.newId()}::uuid, ${ORG_A}::uuid, ${p.id}::uuid, ${milestone.id}::uuid, 'sneaky')`),
      )
      .catch((e: unknown) => e)
    expect(String((error as { cause?: unknown }).cause ?? error)).toMatch(/foreign key/i)
  })

  it('leave their tasks in the project when deleted', async () => {
    const p = await project()
    const milestone = await run('milestone.create', owner(), { id: p.id, name: 'Phase 1' })
    const t = await task(p.id, { milestoneId: milestone.id })
    await run('milestone.delete', owner(), { id: milestone.id })
    expect(await run('task.get', owner(), { id: t.id })).toMatchObject({ milestoneId: null, projectId: p.id })
  })
})

describe('progress', () => {
  it('is null for an unplanned project, then follows milestones, then tasks', async () => {
    const p = await project()
    expect(p.progress).toEqual({ tasksTotal: 0, tasksDone: 0, milestonesTotal: 0, milestonesDone: 0, percent: null })

    const [m1] = [await run('milestone.create', owner(), { id: p.id, name: 'One' }), await run('milestone.create', owner(), { id: p.id, name: 'Two' })]
    await run('milestone.update', owner(), { id: m1.id, completed: true })
    expect((await run('project.get', owner(), { id: p.id })).progress.percent).toBe(50)

    const tasks = [await task(p.id), await task(p.id), await task(p.id), await task(p.id)]
    await run('task.changeStatus', owner(), { id: tasks[0].id, status: 'done' })
    // Cancelled work is not work left to do.
    await run('task.changeStatus', owner(), { id: tasks[1].id, status: 'cancelled' })
    expect((await run('project.get', owner(), { id: p.id })).progress).toEqual({
      tasksTotal: 3,
      tasksDone: 1,
      milestonesTotal: 2,
      milestonesDone: 1,
      percent: 33,
    })
  })

  it('reaches 100% only when everything counted is done', async () => {
    const p = await project()
    const tasks = await Promise.all(Array.from({ length: 3 }, () => task(p.id)))
    for (const t of tasks.slice(0, 2)) await run('task.changeStatus', owner(), { id: t.id, status: 'done' })
    expect((await run('project.get', owner(), { id: p.id })).progress.percent).toBe(66)
  })
})

describe('money on projects', () => {
  it('shows budgets and rates only to people who can read financials', async () => {
    const p = await project({ budgetMinor: 25_000_00 })
    await run('projectMember.add', owner(), { id: p.id, userId: developerA, billableRateMinor: 180_00, costRateMinor: 90_00 })

    expect((await run('project.get', owner(), { id: p.id })).budgetMinor).toBe(25_000_00)
    expect((await run('project.get', developer(), { id: p.id })).budgetMinor).toBeNull()

    const asOwner = await run('projectMember.list', owner(), { id: p.id })
    expect(asOwner.data.find((m: { userId: string }) => m.userId === developerA)).toMatchObject({ billableRateMinor: 180_00, costRateMinor: 90_00 })
    const asDeveloper = await run('projectMember.list', developer(), { id: p.id })
    expect(asDeveloper.data.find((m: { userId: string }) => m.userId === developerA)).toMatchObject({ billableRateMinor: null, costRateMinor: null })
  })

  it('refuses setting a budget or a rate without financial access', async () => {
    const manager = { ...owner(), permissions: new Set([...core.permissionsForRole('owner')].filter((p) => p !== 'report:readFinancial')) }
    await expect(run('project.create', manager, { name: 'No money', budgetMinor: 1 })).rejects.toBeInstanceOf(core.ForbiddenError)
    const p = await project()
    await expect(run('projectMember.add', manager, { id: p.id, userId: developerA, costRateMinor: 1 })).rejects.toBeInstanceOf(core.ForbiddenError)
  })

  it('keeps rates out of events', async () => {
    const p = await project()
    await run('projectMember.add', owner(), { id: p.id, userId: developerA, billableRateMinor: 999_00 })
    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ data: unknown }>(sql`select data from events where type = 'project_member.added' order by id desc limit 1`),
    )
    expect(JSON.stringify(rows[0]!.data)).not.toMatch(/rate/i)
  })
})

describe('projects', () => {
  it('take their client from the deal they deliver', async () => {
    const company = await run('company.create', owner(), { name: `Client ${unique()}` })
    const deal = await run('deal.create', owner(), { companyId: company.id, name: 'Rebuild' })
    const p = await project({ dealId: deal.id })
    expect(p).toMatchObject({ companyId: company.id, companyName: company.name, dealId: deal.id, currency: 'AUD' })

    const other = await run('company.create', owner(), { name: `Other ${unique()}` })
    await expect(project({ dealId: deal.id, companyId: other.id })).rejects.toMatchObject({ code: 'deal_company_mismatch' })

    const summary = await run('company.summary', owner(), { id: company.id })
    expect(summary.sections.find((s: { key: string }) => s.key === 'projects')).toMatchObject({ status: 'available', count: 1 })
  })

  it('put their owner on the team', async () => {
    const p = await project()
    const members = await run('projectMember.list', owner(), { id: p.id })
    expect(members.data).toEqual([expect.objectContaining({ userId: ownerA, role: 'manager' })])
    await expect(run('projectMember.add', owner(), { id: p.id, userId: ownerA })).rejects.toMatchObject({ code: 'already_member' })
    await expect(run('projectMember.add', owner(), { id: p.id, userId: ownerB })).rejects.toMatchObject({ code: 'owner_not_member' })
  })

  it('take no new work once archived, and drop out of task lists', async () => {
    const p = await project()
    const t = await task(p.id, { assigneeId: developerA })
    await run('project.archive', owner(), { id: p.id })
    await expect(task(p.id)).rejects.toMatchObject({ code: 'archived' })
    const mine = await run('task.list', developer(), { mine: 'true' })
    expect(mine.data.map((x: { id: string }) => x.id)).not.toContain(t.id)
  })

  it('refuse a due date before the start', async () => {
    await expect(project({ startDate: '2026-10-01', dueDate: '2026-09-01' })).rejects.toMatchObject({ code: 'due_before_start' })
  })
})

describe('comments', () => {
  it('let developers discuss, but not publish to the client or edit others', async () => {
    const p = await project()
    const t = await task(p.id)
    const comment = await run('comment.create', developer(), { projectId: p.id, taskId: t.id, body: 'Blocked on copy' })
    expect(comment).toMatchObject({ authorId: developerA, editable: true, clientVisible: false })

    await expect(
      run('comment.create', developer(), { projectId: p.id, body: 'Launch next week', clientVisible: true }),
    ).rejects.toBeInstanceOf(core.ForbiddenError)
    await expect(run('comment.update', otherDeveloper(), { id: comment.id, body: 'rewritten' })).rejects.toBeInstanceOf(core.ForbiddenError)
    await expect(run('comment.delete', otherDeveloper(), { id: comment.id })).rejects.toBeInstanceOf(core.ForbiddenError)

    // The owner moderates.
    await expect(run('comment.update', owner(), { id: comment.id, body: 'Blocked on final copy' })).resolves.toMatchObject({ body: 'Blocked on final copy' })
    const listed = await run('comment.list', otherDeveloper(), { projectId: p.id, taskId: t.id })
    expect(listed.data).toEqual([expect.objectContaining({ id: comment.id, editable: false })])
  })

  it('keep task discussion and project updates apart', async () => {
    const p = await project()
    const t = await task(p.id)
    await run('comment.create', owner(), { projectId: p.id, taskId: t.id, body: 'on the task' })
    await run('comment.create', owner(), { projectId: p.id, body: 'on the project', clientVisible: true })
    expect((await run('comment.list', owner(), { projectId: p.id })).data.map((c: { body: string }) => c.body)).toEqual(['on the project'])
    expect((await run('comment.list', owner(), { projectId: p.id, taskId: t.id })).data.map((c: { body: string }) => c.body)).toEqual(['on the task'])
  })

  it('do not copy comment text into the audit log', async () => {
    const p = await project()
    const comment = await run('comment.create', owner(), { projectId: p.id, body: 'private thought' })
    await run('comment.update', owner(), { id: comment.id, body: 'another private thought' })
    const { rows } = await mod.withTenant(ORG_A, (tx) =>
      tx.execute<{ changes: unknown }>(sql`select changes from audit_logs where action like 'comment.%' order by id desc limit 2`),
    )
    expect(JSON.stringify(rows)).not.toContain('private thought')
  })
})

describe('attachments', () => {
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x0d, 0x7f])

  it('round-trip through storage, byte for byte', async () => {
    const p = await project()
    const t = await task(p.id)
    const uploaded = await run('attachment.upload', owner(), {
      projectId: p.id,
      taskId: t.id,
      file: new File([bytes], '../../etc/Brief v2.pdf', { type: 'application/pdf' }),
    })
    expect(uploaded).toMatchObject({ filename: 'Brief v2.pdf', contentType: 'application/pdf', sizeBytes: bytes.length, taskId: t.id })

    const { url, filename } = await run('attachment.download', developer(), { id: uploaded.id })
    expect(filename).toBe('Brief v2.pdf')
    const verified = storage.LocalStorage.verify(new URL(url).searchParams)
    expect(verified).toMatchObject({ name: 'Brief v2.pdf', type: 'application/pdf' })
    // The key is made of ids: nothing from the filename reaches the path.
    expect(verified!.key).toBe(`${ORG_A}/attachments/${uploaded.id}`)
    expect(Buffer.compare(await storage.storage().get(verified!.key), bytes)).toBe(0)
  })

  it('remove the bytes once a deletion commits, including with their task', async () => {
    const p = await project()
    const t = await task(p.id)
    const onTask = await run('attachment.upload', owner(), { projectId: p.id, taskId: t.id, file: new File(['a'], 'a.txt') })
    const onProject = await run('attachment.upload', owner(), { projectId: p.id, file: new File(['b'], 'b.txt') })
    const keyOf = async (id: string) => new URL((await run('attachment.download', owner(), { id })).url).searchParams.get('key')!
    const [taskKey, projectKey] = [await keyOf(onTask.id), await keyOf(onProject.id)]

    await run('attachment.delete', owner(), { id: onProject.id })
    expect(await storage.storage().exists(projectKey)).toBe(false)

    await run('task.delete', owner(), { id: t.id })
    expect(await storage.storage().exists(taskKey)).toBe(false)
    expect((await run('attachment.list', owner(), { projectId: p.id })).data).toEqual([])
  })

  it('refuse empty and oversized files', async () => {
    const p = await project()
    await expect(run('attachment.upload', owner(), { projectId: p.id, file: new File([], 'empty.txt') })).rejects.toMatchObject({ code: 'file_empty' })
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'big.bin')
    await expect(run('attachment.upload', owner(), { projectId: p.id, file: big })).rejects.toMatchObject({ code: 'file_too_large' })
  })

  it('need edit rights on what they attach to', async () => {
    const p = await project()
    const t = await task(p.id)
    // Developers can change tasks, but not the project itself.
    await expect(run('attachment.upload', developer(), { projectId: p.id, taskId: t.id, file: new File(['x'], 'x.txt') })).resolves.toBeDefined()
    await expect(run('attachment.upload', developer(), { projectId: p.id, file: new File(['x'], 'x.txt') })).rejects.toBeInstanceOf(core.ForbiddenError)
    const ownersFile = await run('attachment.upload', owner(), { projectId: p.id, taskId: t.id, file: new File(['y'], 'y.txt') })
    await expect(run('attachment.delete', developer(), { id: ownersFile.id })).rejects.toBeInstanceOf(core.ForbiddenError)
  })

  it('are not reachable from another organization', async () => {
    const p = await project()
    const file = await run('attachment.upload', owner(), { projectId: p.id, file: new File(['secret'], 's.txt') })
    await expect(run('attachment.download', as(ORG_B, ownerB, 'owner'), { id: file.id })).rejects.toBeInstanceOf(core.NotFoundError)
  })
})

describe('transaction hooks', () => {
  it('run rollback hooks when the transaction fails, and commit hooks only when it succeeds', async () => {
    const calls: string[] = []
    registry.defineProcedure({
      name: 'test.hooks',
      summary: 'Test-only procedure for transaction hooks',
      permission: 'project:read',
      input: z.object({ fail: z.boolean() }),
      output: z.object({ ok: z.boolean() }),
      http: { method: 'POST', path: '/test-hooks' },
      emits: [],
      async handler(ctx, input) {
        ctx.afterCommit(async () => void calls.push('commit'))
        ctx.afterRollback(async () => void calls.push('rollback'))
        await ctx.audit({ action: 'test.hooks', entityType: 'test' })
        if (input.fail) throw new core.DomainError('nope')
        return { ok: true }
      },
    })

    await run('test.hooks', owner(), { fail: false })
    expect(calls).toEqual(['commit'])
    await expect(run('test.hooks', owner(), { fail: true })).rejects.toMatchObject({ message: 'nope' })
    expect(calls).toEqual(['commit', 'rollback'])
  })
})
