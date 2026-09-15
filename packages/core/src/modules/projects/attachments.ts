import { and, desc, eq, isNull, schema } from '@workloom/db'
import { storage } from '@workloom/storage'
import { z } from 'zod'
import { DomainError, ForbiddenError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, optionalFlag } from '../crm/shared.ts'
import { loadActiveProject, loadProject } from './projects.ts'
import { loadTask } from './tasks.ts'

/** Per file. Server Actions and the reverse proxy must allow at least this much. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

const DOWNLOAD_URL_SECONDS = 300

export const attachmentOutput = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  /** Null for a file on the project itself. */
  taskId: z.uuid().nullable(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  uploadedBy: z.uuid().nullable(),
  uploaderName: z.string().nullable(),
  clientVisible: z.boolean(),
  /** Whether the caller may delete it: their own upload, or anyone who can edit the project. */
  deletable: z.boolean(),
  createdAt: z.date(),
})

type AttachmentRow = typeof schema.attachments.$inferSelect

function present(ctx: ActorContext, row: AttachmentRow, uploaderName: string | null) {
  return {
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    uploadedBy: row.uploadedBy,
    uploaderName,
    clientVisible: row.clientVisible,
    deletable: row.uploadedBy === actingUserId(ctx) || ctx.has('project:update'),
    createdAt: row.createdAt,
    // The storage key is internal: reaching the bytes goes through a permission check.
  }
}

function selectAttachments(ctx: ActorContext) {
  return ctx.tx
    .select({ attachment: schema.attachments, uploaderName: schema.user.name })
    .from(schema.attachments)
    .leftJoin(schema.user, eq(schema.user.id, schema.attachments.uploadedBy))
}

async function loadAttachment(ctx: ActorContext, id: string) {
  const [row] = await ctx.tx.select().from(schema.attachments).where(eq(schema.attachments.id, id)).limit(1)
  if (!row) throw new NotFoundError('Attachment', id)
  return row
}

/** Files on a task need the task; a project's own files need only the project. */
async function assertReadable(ctx: ActorContext, projectId: string, taskId: string | null | undefined) {
  await loadProject(ctx, projectId)
  if (taskId) {
    ctx.require('task:read')
    const task = await loadTask(ctx, taskId)
    if (task.projectId !== projectId) throw new NotFoundError('Task', taskId)
  }
}

/**
 * Removes path components and control characters. The name is only ever
 * displayed and offered as the download name -- storage keys never contain it.
 */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = [...base]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 255)
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned
}

function cleanContentType(type: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.toLowerCase() : 'application/octet-stream'
}

export const attachmentList = defineProcedure({
  name: 'attachment.list',
  summary: "A task's files, or (without taskId) a project's own files, newest first",
  permission: 'project:read',
  readOnly: true,
  input: z.object({ projectId: z.uuid(), taskId: z.uuid().optional() }),
  output: z.object({ data: z.array(attachmentOutput) }),
  http: { method: 'GET', path: '/attachments' },
  async handler(ctx, input) {
    await assertReadable(ctx, input.projectId, input.taskId)
    const a = schema.attachments
    const rows = await selectAttachments(ctx)
      .where(and(eq(a.projectId, input.projectId), input.taskId ? eq(a.taskId, input.taskId) : isNull(a.taskId)))
      .orderBy(desc(a.id))
      .limit(500)
    return { data: rows.map((r) => present(ctx, r.attachment, r.uploaderName)) }
  },
})

export const attachmentUpload = defineProcedure({
  name: 'attachment.upload',
  summary: 'Attach a file to a task or project (multipart/form-data, up to 20 MB)',
  permission: 'project:read',
  input: z.object({
    projectId: z.uuid(),
    taskId: z.uuid().nullish(),
    file: z.file(),
    /** Share with the client portal. Requires `project:update`. */
    clientVisible: optionalFlag,
  }),
  output: attachmentOutput,
  http: { method: 'POST', path: '/attachments', successStatus: 201, body: 'multipart' },
  rateLimit: 'expensive',
  emits: ['attachment.added'],
  async handler(ctx, input) {
    // Attaching changes the work: to a task needs task:update, to the project project:update.
    ctx.require(input.taskId ? 'task:update' : 'project:update')
    if (input.clientVisible) ctx.require('project:update')
    await assertReadable(ctx, input.projectId, input.taskId)
    await loadActiveProject(ctx, input.projectId)

    if (input.file.size === 0) throw new DomainError('That file is empty.', 'file_empty', 'file')
    if (input.file.size > ATTACHMENT_MAX_BYTES) {
      throw new DomainError('Files can be at most 20 MB.', 'file_too_large', 'file')
    }

    const id = newId()
    const filename = cleanFilename(input.file.name)
    const contentType = cleanContentType(input.file.type)
    // Generated from ids alone, so no filename can steer where the bytes land.
    const key = `${ctx.organizationId}/attachments/${id}`

    await storage().put(key, Buffer.from(await input.file.arrayBuffer()), { contentType, filename })
    // Written before the database commits, so undone if it does not.
    ctx.afterRollback(() => storage().delete(key))

    await ctx.tx.insert(schema.attachments).values({
      id,
      organizationId: ctx.organizationId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      filename,
      contentType,
      sizeBytes: input.file.size,
      storageKey: key,
      uploadedBy: actingUserId(ctx),
      clientVisible: input.clientVisible ?? false,
    })

    const [row] = await selectAttachments(ctx).where(eq(schema.attachments.id, id))
    const attachment = present(ctx, row!.attachment, row!.uploaderName)
    await ctx.audit({
      action: 'attachment.added',
      entityType: input.taskId ? 'task' : 'project',
      entityId: input.taskId ?? input.projectId,
      entityLabel: filename,
    })
    await ctx.emit('attachment.added', attachment)
    return attachment
  },
})

export const attachmentDownload = defineProcedure({
  name: 'attachment.download',
  summary: 'A short-lived URL that downloads the file',
  permission: 'project:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({ url: z.string(), expiresAt: z.date(), filename: z.string() }),
  http: { method: 'GET', path: '/attachments/{id}/download' },
  async handler(ctx, input) {
    const attachment = await loadAttachment(ctx, input.id)
    await assertReadable(ctx, attachment.projectId, attachment.taskId)
    const url = await storage().signedUrl(attachment.storageKey, {
      expiresInSeconds: DOWNLOAD_URL_SECONDS,
      filename: attachment.filename,
      contentType: attachment.contentType,
    })
    return { url, expiresAt: new Date(ctx.now.getTime() + DOWNLOAD_URL_SECONDS * 1000), filename: attachment.filename }
  },
})

export const attachmentDelete = defineProcedure({
  name: 'attachment.delete',
  summary: 'Delete a file. Your own upload, or any if you can edit the project.',
  permission: 'project:read',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/attachments/{id}' },
  emits: ['attachment.deleted'],
  async handler(ctx, input) {
    const row = await loadAttachment(ctx, input.id)
    await assertReadable(ctx, row.projectId, row.taskId)
    if (row.uploadedBy !== actingUserId(ctx) && !ctx.has('project:update')) throw new ForbiddenError('project:update')

    const [withName] = await selectAttachments(ctx).where(eq(schema.attachments.id, row.id))
    const attachment = present(ctx, withName!.attachment, withName!.uploaderName)
    await ctx.tx.delete(schema.attachments).where(eq(schema.attachments.id, row.id))
    ctx.afterCommit(() => storage().delete(row.storageKey))

    await ctx.audit({
      action: 'attachment.deleted',
      entityType: row.taskId ? 'task' : 'project',
      entityId: row.taskId ?? row.projectId,
      entityLabel: row.filename,
    })
    await ctx.emit('attachment.deleted', attachment)
    return { deleted: true }
  },
})
