import { and, asc, eq, schema, sql } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, optionalFlag, optionalText, provided, requiredText } from '../crm/shared.ts'
import { loadActiveProject, loadProject, progressPercent } from './projects.ts'

export const milestoneOutput = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  dueDate: z.iso.date().nullable(),
  completedAt: z.date().nullable(),
  clientVisible: z.boolean(),
  /** Tasks under the milestone, excluding cancelled ones. */
  tasksTotal: z.number().int(),
  tasksDone: z.number().int(),
  percent: z.number().int().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Milestone = z.infer<typeof milestoneOutput>

async function selectMilestones(ctx: ActorContext, where: ReturnType<typeof eq>): Promise<Milestone[]> {
  const m = schema.milestones
  const t = schema.tasks
  const rows = await ctx.tx
    .select({
      milestone: m,
      total: sql<number>`(select count(*)::int from ${t} where ${t.milestoneId} = ${m.id} and ${t.status} <> 'cancelled')`,
      done: sql<number>`(select count(*)::int from ${t} where ${t.milestoneId} = ${m.id} and ${t.status} = 'done')`,
    })
    .from(m)
    .where(where)
    // Undated milestones last; ties by creation.
    .orderBy(sql`${m.dueDate} asc nulls last`, asc(m.id))
  return rows.map(({ milestone, total, done }) => ({
    id: milestone.id,
    projectId: milestone.projectId,
    name: milestone.name,
    description: milestone.description,
    dueDate: milestone.dueDate,
    completedAt: milestone.completedAt,
    clientVisible: milestone.clientVisible,
    tasksTotal: total,
    tasksDone: done,
    // A milestone's own progress is its tasks; it has no sub-milestones to fall back on.
    percent: total > 0 ? progressPercent({ tasksTotal: total, tasksDone: done, milestonesTotal: 0, milestonesDone: 0 }) : null,
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt,
  }))
}

async function getMilestone(ctx: ActorContext, id: string): Promise<Milestone> {
  const [milestone] = await selectMilestones(ctx, eq(schema.milestones.id, id))
  if (!milestone) throw new NotFoundError('Milestone', id)
  return milestone
}

export async function loadMilestone(ctx: ActorContext, id: string) {
  const [row] = await ctx.tx.select().from(schema.milestones).where(eq(schema.milestones.id, id)).limit(1)
  if (!row) throw new NotFoundError('Milestone', id)
  return row
}

export const milestoneList = defineProcedure({
  name: 'milestone.list',
  summary: "A project's milestones, soonest due first, with their progress",
  permission: 'milestone:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({ data: z.array(milestoneOutput) }),
  http: { method: 'GET', path: '/projects/{id}/milestones' },
  async handler(ctx, input) {
    await loadProject(ctx, input.id)
    return { data: await selectMilestones(ctx, eq(schema.milestones.projectId, input.id)) }
  },
})

const details = {
  description: optionalText(10_000),
  dueDate: z.iso.date().nullish(),
  /** Whether a client may see it once the portal exists. */
  clientVisible: optionalFlag,
}

export const milestoneCreate = defineProcedure({
  name: 'milestone.create',
  summary: 'Add a milestone to a project',
  permission: 'milestone:create',
  input: z.object({ id: z.uuid(), name: requiredText(200, 'Name'), ...details }),
  output: milestoneOutput,
  http: { method: 'POST', path: '/projects/{id}/milestones', successStatus: 201 },
  emits: ['milestone.created'],
  async handler(ctx, input) {
    const project = await loadActiveProject(ctx, input.id)
    const id = newId()
    await ctx.tx.insert(schema.milestones).values({
      id,
      organizationId: ctx.organizationId,
      projectId: project.id,
      name: input.name,
      description: input.description ?? null,
      dueDate: input.dueDate ?? null,
      clientVisible: input.clientVisible ?? false,
      createdBy: actingUserId(ctx),
    })
    const milestone = await getMilestone(ctx, id)
    await ctx.audit({ action: 'milestone.created', entityType: 'milestone', entityId: id, entityLabel: milestone.name })
    await ctx.emit('milestone.created', milestone)
    return milestone
  },
})

export const milestoneUpdate = defineProcedure({
  name: 'milestone.update',
  summary: 'Change a milestone, or mark it complete or not',
  permission: 'milestone:update',
  input: z.object({
    id: z.uuid(),
    name: requiredText(200, 'Name').optional(),
    ...details,
    completed: z.boolean().optional(),
  }),
  output: milestoneOutput,
  http: { method: 'PATCH', path: '/milestones/{id}' },
  emits: ['milestone.updated', 'milestone.completed', 'milestone.reopened'],
  async handler(ctx, input) {
    const { id, completed, ...fields } = input
    const before = await loadMilestone(ctx, id)
    await loadActiveProject(ctx, before.projectId)

    const patch: { [K in keyof typeof schema.milestones.$inferInsert]?: (typeof schema.milestones.$inferInsert)[K] | undefined } = provided(fields)
    const completing = completed === true && !before.completedAt
    const reopening = completed === false && Boolean(before.completedAt)
    const changes = diff(before as Record<string, unknown>, patch) ?? {}
    if (completing || reopening) {
      patch.completedAt = completing ? ctx.now : null
      changes.completed = { from: !completing, to: completing }
    }
    if (Object.keys(changes).length === 0) return getMilestone(ctx, id)

    await ctx.tx.update(schema.milestones).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.milestones.id, id))
    const milestone = await getMilestone(ctx, id)
    const action = completing ? 'milestone.completed' : reopening ? 'milestone.reopened' : 'milestone.updated'
    await ctx.audit({ action, entityType: 'milestone', entityId: id, entityLabel: milestone.name, changes })
    await ctx.emit(action, milestone)
    return milestone
  },
})

export const milestoneDelete = defineProcedure({
  name: 'milestone.delete',
  summary: 'Delete a milestone. Its tasks stay in the project, without a milestone.',
  permission: 'milestone:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/milestones/{id}' },
  emits: ['milestone.deleted'],
  async handler(ctx, input) {
    const milestone = await getMilestone(ctx, input.id)
    await loadActiveProject(ctx, milestone.projectId)
    await ctx.tx
      .update(schema.tasks)
      .set({ milestoneId: null, updatedAt: ctx.now })
      .where(and(eq(schema.tasks.milestoneId, milestone.id), eq(schema.tasks.projectId, milestone.projectId)))
    await ctx.tx.delete(schema.milestones).where(eq(schema.milestones.id, milestone.id))
    await ctx.audit({ action: 'milestone.deleted', entityType: 'milestone', entityId: milestone.id, entityLabel: milestone.name })
    await ctx.emit('milestone.deleted', milestone)
    return { deleted: true }
  },
})
