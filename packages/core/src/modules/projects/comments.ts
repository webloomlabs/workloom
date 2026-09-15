import { and, desc, eq, isNull, lt, schema } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { ForbiddenError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, optionalFlag, pageInput, paginate, provided, requiredText } from '../crm/shared.ts'
import { loadActiveProject, loadProject } from './projects.ts'
import { loadTask } from './tasks.ts'

export const commentOutput = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  /** Null for an update on the project itself. */
  taskId: z.uuid().nullable(),
  authorId: z.uuid().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  clientVisible: z.boolean(),
  /** Whether the caller may edit or delete it: their own, or any with `comment:moderate`. */
  editable: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

type CommentRow = typeof schema.comments.$inferSelect

function present(ctx: ActorContext, comment: CommentRow, authorName: string | null) {
  return {
    id: comment.id,
    projectId: comment.projectId,
    taskId: comment.taskId,
    authorId: comment.authorId,
    authorName,
    body: comment.body,
    clientVisible: comment.clientVisible,
    editable: comment.authorId === actingUserId(ctx) || ctx.has('comment:moderate'),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  }
}

function selectComments(ctx: ActorContext) {
  return ctx.tx
    .select({ comment: schema.comments, authorName: schema.user.name })
    .from(schema.comments)
    .leftJoin(schema.user, eq(schema.user.id, schema.comments.authorId))
}

async function getComment(ctx: ActorContext, id: string) {
  const [row] = await selectComments(ctx).where(eq(schema.comments.id, id)).limit(1)
  if (!row) throw new NotFoundError('Comment', id)
  return present(ctx, row.comment, row.authorName)
}

/** Only the author may change a comment, unless the caller moderates. */
function assertEditable(ctx: ActorContext, comment: { authorId: string | null }) {
  if (comment.authorId !== actingUserId(ctx) && !ctx.has('comment:moderate')) {
    throw new ForbiddenError('comment:moderate')
  }
}

/**
 * Anything marked client-visible will be shown to the client once the portal
 * exists, so choosing to publish is a decision about the project.
 */
function assertMayPublish(ctx: ActorContext, clientVisible: boolean | undefined) {
  if (clientVisible) ctx.require('project:update')
}

/** Reading a task's discussion needs the task; a project update needs only the project. */
async function assertReadable(ctx: ActorContext, projectId: string, taskId: string | null | undefined) {
  ctx.require('project:read')
  await loadProject(ctx, projectId)
  if (taskId) {
    ctx.require('task:read')
    const task = await loadTask(ctx, taskId)
    if (task.projectId !== projectId) throw new NotFoundError('Task', taskId)
  }
}

export const commentList = defineProcedure({
  name: 'comment.list',
  summary: "A task's comments, or (without taskId) a project's updates, newest first",
  permission: 'project:read',
  readOnly: true,
  input: z.object({ projectId: z.uuid(), taskId: z.uuid().optional(), ...pageInput }),
  output: z.object({ data: z.array(commentOutput), nextCursor: z.uuid().nullable() }),
  http: { method: 'GET', path: '/comments' },
  async handler(ctx, input) {
    await assertReadable(ctx, input.projectId, input.taskId)
    const c = schema.comments
    const rows = await selectComments(ctx)
      .where(
        and(
          eq(c.projectId, input.projectId),
          input.taskId ? eq(c.taskId, input.taskId) : isNull(c.taskId),
          input.cursor ? lt(c.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(c.id))
      .limit(input.limit + 1)
    return paginate(rows.map((r) => present(ctx, r.comment, r.authorName)), input.limit)
  },
})

export const commentCreate = defineProcedure({
  name: 'comment.create',
  summary: 'Comment on a task, or post an update on a project',
  permission: 'comment:create',
  input: z.object({
    projectId: z.uuid(),
    taskId: z.uuid().nullish(),
    body: requiredText(20_000, 'Comment'),
    /** Publish to the client portal. Requires `project:update`. */
    clientVisible: optionalFlag,
  }),
  output: commentOutput,
  http: { method: 'POST', path: '/comments', successStatus: 201 },
  emits: ['comment.created'],
  async handler(ctx, input) {
    await assertReadable(ctx, input.projectId, input.taskId)
    await loadActiveProject(ctx, input.projectId)
    assertMayPublish(ctx, input.clientVisible)

    const id = newId()
    await ctx.tx.insert(schema.comments).values({
      id,
      organizationId: ctx.organizationId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      authorId: actingUserId(ctx),
      body: input.body,
      clientVisible: input.clientVisible ?? false,
    })
    const comment = await getComment(ctx, id)
    await ctx.audit({ action: 'comment.created', entityType: input.taskId ? 'task' : 'project', entityId: input.taskId ?? input.projectId })
    await ctx.emit('comment.created', comment)
    return comment
  },
})

export const commentUpdate = defineProcedure({
  name: 'comment.update',
  summary: 'Edit a comment. Your own, unless you moderate.',
  permission: 'comment:create',
  input: z.object({ id: z.uuid(), body: requiredText(20_000, 'Comment').optional(), clientVisible: optionalFlag }),
  output: commentOutput,
  http: { method: 'PATCH', path: '/comments/{id}' },
  emits: ['comment.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const [before] = await ctx.tx.select().from(schema.comments).where(eq(schema.comments.id, id)).limit(1)
    if (!before) throw new NotFoundError('Comment', id)
    await assertReadable(ctx, before.projectId, before.taskId)
    assertEditable(ctx, before)
    const patch = provided(fields)
    if (patch.clientVisible !== undefined && patch.clientVisible !== before.clientVisible) ctx.require('project:update')

    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return getComment(ctx, id)

    await ctx.tx.update(schema.comments).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.comments.id, id))
    const comment = await getComment(ctx, id)
    // The audit trail records that it changed, not the text: comments can be personal.
    await ctx.audit({
      action: 'comment.updated',
      entityType: before.taskId ? 'task' : 'project',
      entityId: before.taskId ?? before.projectId,
      changes: Object.fromEntries(Object.keys(changes).map((k) => [k, k === 'body' ? { from: '…', to: '…' } : changes[k]!])),
    })
    await ctx.emit('comment.updated', comment)
    return comment
  },
})

export const commentDelete = defineProcedure({
  name: 'comment.delete',
  summary: 'Delete a comment. Your own, unless you moderate.',
  permission: 'comment:create',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/comments/{id}' },
  emits: ['comment.deleted'],
  async handler(ctx, input) {
    const [before] = await ctx.tx.select().from(schema.comments).where(eq(schema.comments.id, input.id)).limit(1)
    if (!before) throw new NotFoundError('Comment', input.id)
    await assertReadable(ctx, before.projectId, before.taskId)
    assertEditable(ctx, before)
    const comment = await getComment(ctx, before.id)
    await ctx.tx.delete(schema.comments).where(eq(schema.comments.id, before.id))
    await ctx.audit({ action: 'comment.deleted', entityType: before.taskId ? 'task' : 'project', entityId: before.taskId ?? before.projectId })
    await ctx.emit('comment.deleted', comment)
    return { deleted: true }
  },
})
