import { storage } from '@workloom/storage'
import { alias, and, desc, eq, ilike, lt, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import {
  actingUserId,
  assertMember,
  contains,
  optionalFlag,
  optionalText,
  pageInput,
  paginate,
  provided,
  queryFlag,
  requiredText,
  searchInput,
} from '../crm/shared.ts'
import { loadMilestone } from './milestones.ts'
import { loadActiveProject, loadProject } from './projects.ts'

type TaskStatus = (typeof schema.TASK_STATUSES)[number]
type TaskRow = typeof schema.tasks.$inferSelect

export const taskOutput = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string(),
  milestoneId: z.uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(schema.TASK_STATUSES),
  priority: z.enum(schema.TASK_PRIORITIES),
  assigneeId: z.uuid().nullable(),
  assigneeName: z.string().nullable(),
  dueDate: z.iso.date().nullable(),
  labels: z.array(z.string()),
  estimateMinutes: z.number().int().nullable(),
  clientVisible: z.boolean(),
  /** Dependencies not yet done or cancelled. A task with any cannot be completed. */
  openDependencies: z.number().int(),
  completedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

const taskReference = z.object({ id: z.uuid(), title: z.string(), status: z.enum(schema.TASK_STATUSES) })

const taskDetailOutput = taskOutput.extend({
  /** What this task waits on. */
  dependencies: z.array(taskReference),
  /** What waits on this task. */
  dependents: z.array(taskReference),
})

export type Task = z.infer<typeof taskOutput>

const assignee = alias(schema.user, 'task_assignee')

function selectTasks(ctx: ActorContext) {
  const t = schema.tasks
  return ctx.tx
    .select({
      task: t,
      projectName: schema.projects.name,
      assigneeName: assignee.name,
      // Plain SQL names: an aliased table interpolated into a template loses its alias.
      openDependencies: sql<number>`(
        select count(*)::int from task_dependencies dep
        join tasks blocker on blocker.id = dep.depends_on_task_id
        where dep.task_id = ${t.id} and blocker.status not in ('done', 'cancelled')
      )`,
    })
    .from(t)
    .innerJoin(schema.projects, eq(schema.projects.id, t.projectId))
    .leftJoin(assignee, eq(assignee.id, t.assigneeId))
}

function present(row: { task: TaskRow; projectName: string; assigneeName: string | null; openDependencies: number }): Task {
  const { task } = row
  return {
    id: task.id,
    projectId: task.projectId,
    projectName: row.projectName,
    milestoneId: task.milestoneId,
    title: task.title,
    description: task.description,
    status: task.status as TaskStatus,
    priority: task.priority as Task['priority'],
    assigneeId: task.assigneeId,
    assigneeName: row.assigneeName,
    dueDate: task.dueDate,
    labels: task.labels,
    estimateMinutes: task.estimateMinutes,
    clientVisible: task.clientVisible,
    openDependencies: row.openDependencies,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export async function getTask(ctx: ActorContext, id: string): Promise<Task> {
  const [row] = await selectTasks(ctx).where(eq(schema.tasks.id, id)).limit(1)
  if (!row) throw new NotFoundError('Task', id)
  return present(row)
}

async function getTaskDetail(ctx: ActorContext, id: string): Promise<z.infer<typeof taskDetailOutput>> {
  const task = await getTask(ctx, id)
  const d = schema.taskDependencies
  const t = schema.tasks
  const [dependencies, dependents] = await Promise.all([
    ctx.tx
      .select({ id: t.id, title: t.title, status: t.status })
      .from(d)
      .innerJoin(t, eq(t.id, d.dependsOnTaskId))
      .where(eq(d.taskId, id))
      .orderBy(t.title),
    ctx.tx
      .select({ id: t.id, title: t.title, status: t.status })
      .from(d)
      .innerJoin(t, eq(t.id, d.taskId))
      .where(eq(d.dependsOnTaskId, id))
      .orderBy(t.title),
  ])
  const cast = (rows: typeof dependencies) => rows.map((r) => ({ ...r, status: r.status as TaskStatus }))
  return { ...task, dependencies: cast(dependencies), dependents: cast(dependents) }
}

export async function loadTask(ctx: ActorContext, id: string, options: { lock?: boolean } = {}) {
  const query = ctx.tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1)
  const [row] = options.lock ? await query.for('update') : await query
  if (!row) throw new NotFoundError('Task', id)
  return row
}

const labels = z
  .array(z.string().trim().min(1).max(50))
  .max(20, 'At most 20 labels.')
  .transform((values) => [...new Set(values)])

async function assertMilestoneInProject(ctx: ActorContext, milestoneId: string | null | undefined, projectId: string) {
  if (!milestoneId) return
  const milestone = await loadMilestone(ctx, milestoneId)
  if (milestone.projectId !== projectId) {
    throw new DomainError('That milestone belongs to a different project.', 'milestone_project_mismatch', 'milestoneId')
  }
}

export const taskList = defineProcedure({
  name: 'task.list',
  summary: 'Tasks, newest first, filtered by project, milestone, assignee, or status',
  permission: 'task:read',
  readOnly: true,
  input: z.object({
    projectId: z.uuid().optional(),
    milestoneId: z.uuid().optional(),
    assigneeId: z.uuid().optional(),
    /** Only tasks assigned to the caller (or, for an API key, its owner). */
    mine: queryFlag,
    status: z.enum(schema.TASK_STATUSES).optional(),
    /** Only tasks not yet done or cancelled. */
    open: queryFlag,
    q: searchInput,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: pageInput.cursor,
  }),
  output: z.object({ data: z.array(taskOutput), nextCursor: z.uuid().nullable() }),
  http: { method: 'GET', path: '/tasks' },
  async handler(ctx, input) {
    const t = schema.tasks
    if (input.projectId) await loadProject(ctx, input.projectId)
    const conditions: Array<SQL | undefined> = [
      input.projectId ? eq(t.projectId, input.projectId) : undefined,
      input.milestoneId ? eq(t.milestoneId, input.milestoneId) : undefined,
      input.assigneeId ? eq(t.assigneeId, input.assigneeId) : undefined,
      input.mine ? eq(t.assigneeId, actingUserId(ctx) ?? '00000000-0000-0000-0000-000000000000') : undefined,
      input.status ? eq(t.status, input.status) : undefined,
      input.open ? sql`${t.status} not in ('done', 'cancelled')` : undefined,
      input.q ? ilike(t.title, contains(input.q)) : undefined,
      input.cursor ? lt(t.id, input.cursor) : undefined,
      // A task list is not a way round an archived project.
      input.projectId ? undefined : sql`${schema.projects.archivedAt} is null`,
    ]
    const rows = await selectTasks(ctx)
      .where(and(...conditions))
      .orderBy(desc(t.id))
      .limit(input.limit + 1)
    return paginate(rows.map(present), input.limit)
  },
})

export const taskGet = defineProcedure({
  name: 'task.get',
  summary: 'One task, with what it depends on and what depends on it',
  permission: 'task:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: taskDetailOutput,
  http: { method: 'GET', path: '/tasks/{id}' },
  async handler(ctx, input) {
    return getTaskDetail(ctx, input.id)
  },
})

const details = {
  description: optionalText(20_000),
  milestoneId: z.uuid().nullish(),
  priority: z.enum(schema.TASK_PRIORITIES).optional(),
  assigneeId: z.uuid().nullish(),
  dueDate: z.iso.date().nullish(),
  labels: labels.optional(),
  estimateMinutes: z.number().int().min(0).max(100_000).nullish(),
  clientVisible: optionalFlag,
}

export const taskCreate = defineProcedure({
  name: 'task.create',
  summary: 'Add a task to a project',
  permission: 'task:create',
  input: z.object({
    projectId: z.uuid(),
    title: requiredText(300, 'Title'),
    ...details,
    /** New tasks start in an open status; complete them with the status endpoint. */
    status: z.enum(['todo', 'in_progress', 'in_review']).default('todo'),
  }),
  output: taskOutput,
  http: { method: 'POST', path: '/tasks', successStatus: 201 },
  emits: ['task.created', 'task.assigned'],
  async handler(ctx, input) {
    const project = await loadActiveProject(ctx, input.projectId)
    await assertMilestoneInProject(ctx, input.milestoneId, project.id)
    await assertMember(ctx, input.assigneeId)

    const id = newId()
    await ctx.tx.insert(schema.tasks).values({
      id,
      organizationId: ctx.organizationId,
      projectId: project.id,
      milestoneId: input.milestoneId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: input.status,
      priority: input.priority ?? 'normal',
      assigneeId: input.assigneeId ?? null,
      dueDate: input.dueDate ?? null,
      labels: input.labels ?? [],
      estimateMinutes: input.estimateMinutes ?? null,
      clientVisible: input.clientVisible ?? false,
      createdBy: actingUserId(ctx),
    })
    const task = await getTask(ctx, id)
    await ctx.audit({ action: 'task.created', entityType: 'task', entityId: id, entityLabel: task.title })
    await ctx.emit('task.created', task)
    if (task.assigneeId) await ctx.emit('task.assigned', task)
    return task
  },
})

export const taskUpdate = defineProcedure({
  name: 'task.update',
  summary: "Change a task's details or assignee. Use the status endpoint to move it along.",
  permission: 'task:update',
  input: z.object({ id: z.uuid(), title: requiredText(300, 'Title').optional(), ...details }),
  output: taskOutput,
  http: { method: 'PATCH', path: '/tasks/{id}' },
  emits: ['task.updated', 'task.assigned'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadTask(ctx, id, { lock: true })
    await loadActiveProject(ctx, before.projectId)
    const patch = provided(fields)
    if (patch.milestoneId) await assertMilestoneInProject(ctx, patch.milestoneId, before.projectId)
    if (patch.assigneeId) await assertMember(ctx, patch.assigneeId)

    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return getTask(ctx, id)

    await ctx.tx.update(schema.tasks).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.tasks.id, id))
    const task = await getTask(ctx, id)
    await ctx.audit({ action: 'task.updated', entityType: 'task', entityId: id, entityLabel: task.title, changes })
    await ctx.emit('task.updated', task)
    if (changes.assigneeId && task.assigneeId) await ctx.emit('task.assigned', task)
    return task
  },
})

export const taskChangeStatus = defineProcedure({
  name: 'task.changeStatus',
  summary: 'Move a task to another status. A task waiting on others cannot be completed.',
  permission: 'task:update',
  input: z.object({ id: z.uuid(), status: z.enum(schema.TASK_STATUSES) }),
  output: taskOutput.extend({ previousStatus: z.enum(schema.TASK_STATUSES) }),
  http: { method: 'POST', path: '/tasks/{id}/status' },
  emits: ['task.status_changed', 'task.completed'],
  async handler(ctx, input) {
    const before = await loadTask(ctx, input.id, { lock: true })
    await loadActiveProject(ctx, before.projectId)
    const previousStatus = before.status as TaskStatus
    if (previousStatus === input.status) return { ...(await getTask(ctx, before.id)), previousStatus }

    if (input.status === 'done') {
      const current = await getTask(ctx, before.id)
      if (current.openDependencies > 0) {
        throw new DomainError(
          `This task is waiting on ${current.openDependencies} other ${current.openDependencies === 1 ? 'task' : 'tasks'}. Finish or cancel those first.`,
          'blocked_by_dependencies',
          'status',
        )
      }
    }

    await ctx.tx
      .update(schema.tasks)
      .set({ status: input.status, completedAt: input.status === 'done' ? ctx.now : null, updatedAt: ctx.now })
      .where(eq(schema.tasks.id, before.id))
    const task = { ...(await getTask(ctx, before.id)), previousStatus }
    await ctx.audit({
      action: input.status === 'done' ? 'task.completed' : 'task.status_changed',
      entityType: 'task',
      entityId: task.id,
      entityLabel: task.title,
      changes: { status: { from: previousStatus, to: input.status } },
    })
    await ctx.emit('task.status_changed', task)
    if (input.status === 'done') await ctx.emit('task.completed', task)
    return task
  },
})

export const taskDelete = defineProcedure({
  name: 'task.delete',
  summary: 'Delete a task, with its comments, files, and dependencies. A task with time logged against it cannot be deleted.',
  permission: 'task:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/tasks/{id}' },
  emits: ['task.deleted'],
  async handler(ctx, input) {
    const task = await getTask(ctx, input.id)
    await loadActiveProject(ctx, task.projectId)
    // Logged time is financial history; it cannot lose the task it was spent on.
    const [logged] = await ctx.tx
      .select({ id: schema.timeEntries.id })
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.taskId, task.id))
      .limit(1)
    if (logged) {
      throw new DomainError(
        'Time has been logged against this task, so it cannot be deleted. Cancel it instead.',
        'task_has_time',
      )
    }
    const files = await ctx.tx
      .select({ key: schema.attachments.storageKey })
      .from(schema.attachments)
      .where(eq(schema.attachments.taskId, task.id))

    // Comments, attachments, and dependencies go with it (ON DELETE CASCADE).
    await ctx.tx.delete(schema.tasks).where(eq(schema.tasks.id, task.id))
    // The bytes go only once the deletion has committed.
    ctx.afterCommit(async () => {
      for (const { key } of files) await storage().delete(key)
    })

    await ctx.audit({ action: 'task.deleted', entityType: 'task', entityId: task.id, entityLabel: task.title })
    await ctx.emit('task.deleted', task)
    return { deleted: true }
  },
})

// Dependencies

export const taskDependencyAdd = defineProcedure({
  name: 'taskDependency.add',
  summary: 'Make a task wait on another task in the same project',
  permission: 'task:update',
  input: z.object({ id: z.uuid(), dependsOnTaskId: z.uuid() }),
  output: taskDetailOutput,
  http: { method: 'POST', path: '/tasks/{id}/dependencies', successStatus: 201 },
  emits: ['task_dependency.added'],
  async handler(ctx, input) {
    const task = await loadTask(ctx, input.id)
    if (input.dependsOnTaskId === task.id) {
      throw new DomainError('A task cannot depend on itself.', 'dependency_cycle', 'dependsOnTaskId')
    }
    const other = await loadTask(ctx, input.dependsOnTaskId)
    if (other.projectId !== task.projectId) {
      throw new DomainError('Dependencies must be between tasks in the same project.', 'dependency_project_mismatch', 'dependsOnTaskId')
    }

    // Serialise dependency changes per project. Without the lock, two requests
    // adding A->B and B->A at once would each see no cycle and both commit.
    await loadActiveProject(ctx, task.projectId, { lock: true })

    const d = schema.taskDependencies
    const { rows } = await ctx.tx.execute<{ cycle: boolean }>(sql`
      with recursive reachable(id) as (
        select ${d.dependsOnTaskId} from ${d} where ${d.taskId} = ${other.id}
        union
        select dep.depends_on_task_id from task_dependencies dep join reachable r on dep.task_id = r.id
      )
      select exists (select 1 from reachable where id = ${task.id}) as cycle
    `)
    if (rows[0]?.cycle) {
      throw new DomainError(
        `"${other.title}" already waits on "${task.title}", directly or through other tasks, so this would create a loop.`,
        'dependency_cycle',
        'dependsOnTaskId',
      )
    }

    const inserted = await ctx.tx
      .insert(d)
      .values({ organizationId: ctx.organizationId, projectId: task.projectId, taskId: task.id, dependsOnTaskId: other.id })
      .onConflictDoNothing()
      .returning({ taskId: d.taskId })
    if (inserted.length > 0) {
      await ctx.audit({
        action: 'task_dependency.added',
        entityType: 'task',
        entityId: task.id,
        entityLabel: task.title,
        changes: { dependsOn: { from: null, to: other.id } },
      })
      await ctx.emit('task_dependency.added', { taskId: task.id, dependsOnTaskId: other.id, projectId: task.projectId })
    }
    return getTaskDetail(ctx, task.id)
  },
})

export const taskDependencyRemove = defineProcedure({
  name: 'taskDependency.remove',
  summary: 'Stop a task waiting on another',
  permission: 'task:update',
  input: z.object({ id: z.uuid(), dependsOnTaskId: z.uuid() }),
  output: taskDetailOutput,
  http: { method: 'DELETE', path: '/tasks/{id}/dependencies/{dependsOnTaskId}' },
  emits: ['task_dependency.removed'],
  async handler(ctx, input) {
    const task = await loadTask(ctx, input.id)
    const d = schema.taskDependencies
    const removed = await ctx.tx
      .delete(d)
      .where(and(eq(d.taskId, task.id), eq(d.dependsOnTaskId, input.dependsOnTaskId)))
      .returning({ taskId: d.taskId })
    if (removed.length === 0) throw new NotFoundError('Task dependency')
    await ctx.audit({
      action: 'task_dependency.removed',
      entityType: 'task',
      entityId: task.id,
      entityLabel: task.title,
      changes: { dependsOn: { from: input.dependsOnTaskId, to: null } },
    })
    await ctx.emit('task_dependency.removed', { taskId: task.id, dependsOnTaskId: input.dependsOnTaskId, projectId: task.projectId })
    return getTaskDetail(ctx, task.id)
  },
})

