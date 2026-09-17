import { and, count, desc, eq, ilike, lt, or, schema, type SQL } from '@workloom/db'
import { storage } from '@workloom/storage'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import {
  actingUserId,
  contains,
  optionalFlag,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  requiredText,
  searchInput,
} from '../crm/shared.ts'
import { cleanFilename } from '../projects/attachments.ts'
import { loadProject } from '../projects/projects.ts'

/**
 * Documents filed against a client.
 *
 * Distinct from attachments, which are files posted into a project's
 * discussion. A document is filed rather than posted: the signed contract, the
 * brief, the accessibility report. It belongs to the client, outlives the
 * project that produced it, and is what someone goes looking for two years
 * later when a dispute starts.
 *
 * The bytes live in object storage under a generated key; this row is the only
 * way to reach them, and a download is a short-lived signed URL issued after a
 * permission check -- never a path a caller could guess.
 */

export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024

const DOWNLOAD_URL_SECONDS = 300

type DocumentRow = typeof schema.clientDocuments.$inferSelect

export const documentOutput = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  companyName: z.string(),
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
  title: z.string(),
  category: z.enum(schema.CLIENT_DOCUMENT_CATEGORIES),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  clientVisible: z.boolean(),
  notes: z.string().nullable(),
  uploadedBy: z.uuid().nullable(),
  uploaderName: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type ClientDocument = z.infer<typeof documentOutput>

type DocumentJoin = { document: DocumentRow; companyName: string; projectName: string | null; uploaderName: string | null }

function present(row: DocumentJoin): ClientDocument {
  const d = row.document
  return {
    id: d.id,
    companyId: d.companyId,
    companyName: row.companyName,
    projectId: d.projectId,
    projectName: row.projectName,
    title: d.title,
    category: d.category as ClientDocument['category'],
    filename: d.filename,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    clientVisible: d.clientVisible,
    notes: d.notes,
    uploadedBy: d.uploadedBy,
    uploaderName: row.uploaderName,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    // The storage key is internal: reaching the bytes goes through a check.
  }
}

function selectDocuments(ctx: ActorContext) {
  return ctx.tx
    .select({
      document: schema.clientDocuments,
      companyName: schema.companies.name,
      projectName: schema.projects.name,
      uploaderName: schema.user.name,
    })
    .from(schema.clientDocuments)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.clientDocuments.companyId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.clientDocuments.projectId))
    .leftJoin(schema.user, eq(schema.user.id, schema.clientDocuments.uploadedBy))
}

export async function getDocument(ctx: ActorContext, id: string): Promise<ClientDocument> {
  const [row] = await selectDocuments(ctx).where(eq(schema.clientDocuments.id, id)).limit(1)
  if (!row) throw new NotFoundError('Document', id)
  return present(row)
}

async function loadDocument(ctx: ActorContext, id: string): Promise<DocumentRow> {
  const [row] = await ctx.tx.select().from(schema.clientDocuments).where(eq(schema.clientDocuments.id, id)).limit(1)
  if (!row) throw new NotFoundError('Document', id)
  return row
}

/** A document's project, where it has one, has to be that client's. */
async function assertProject(ctx: ActorContext, companyId: string, projectId: string | null | undefined) {
  if (!projectId) return
  const project = await loadProject(ctx, projectId)
  if (project.companyId !== companyId) {
    throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'projectId')
  }
}

function cleanContentType(type: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.toLowerCase() : 'application/octet-stream'
}

export const documentList = defineProcedure({
  name: 'document.list',
  summary: "A client's documents, newest first, filtered by project or category",
  permission: 'document:read',
  readOnly: true,
  input: z.object({
    companyId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    category: z.enum(schema.CLIENT_DOCUMENT_CATEGORIES).optional(),
    /** Matches the title, the filename, or the note. */
    q: searchInput,
    ...pageInput,
  }),
  output: pageOutput(documentOutput),
  http: { method: 'GET', path: '/documents' },
  async handler(ctx, input) {
    const d = schema.clientDocuments
    if (input.companyId) await loadCompany(ctx, input.companyId)
    if (input.projectId) await loadProject(ctx, input.projectId)
    const conditions: Array<SQL | undefined> = [
      input.companyId ? eq(d.companyId, input.companyId) : undefined,
      input.projectId ? eq(d.projectId, input.projectId) : undefined,
      input.category ? eq(d.category, input.category) : undefined,
      input.q ? or(ilike(d.title, contains(input.q)), ilike(d.filename, contains(input.q)), ilike(d.notes, contains(input.q))) : undefined,
      input.cursor ? lt(d.id, input.cursor) : undefined,
    ]
    const rows = await selectDocuments(ctx).where(and(...conditions)).orderBy(desc(d.id)).limit(input.limit + 1)
    return paginate(rows.map(present), input.limit)
  },
})

export const documentGet = defineProcedure({
  name: 'document.get',
  summary: 'One document on file, with who filed it',
  permission: 'document:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: documentOutput,
  http: { method: 'GET', path: '/documents/{id}' },
  async handler(ctx, input) {
    return getDocument(ctx, input.id)
  },
})

export const documentUpload = defineProcedure({
  name: 'document.upload',
  summary: 'File a document against a client (multipart/form-data, up to 25 MB)',
  permission: 'document:create',
  input: z.object({
    companyId: z.uuid(),
    projectId: z.uuid().nullish(),
    file: z.file(),
    /** Defaults to the file's name. */
    title: optionalText(200),
    category: z.enum(schema.CLIENT_DOCUMENT_CATEGORIES).optional(),
    /** Share with the client portal, when there is one. */
    clientVisible: optionalFlag,
    notes: optionalText(10_000),
  }),
  output: documentOutput,
  http: { method: 'POST', path: '/documents', successStatus: 201, body: 'multipart' },
  rateLimit: 'expensive',
  emits: ['document.uploaded'],
  async handler(ctx, input) {
    const company = await loadCompany(ctx, input.companyId)
    await assertProject(ctx, company.id, input.projectId)

    if (input.file.size === 0) throw new DomainError('That file is empty.', 'file_empty', 'file')
    if (input.file.size > DOCUMENT_MAX_BYTES) throw new DomainError('Documents can be at most 25 MB.', 'file_too_large', 'file')

    const id = newId()
    const filename = cleanFilename(input.file.name)
    const contentType = cleanContentType(input.file.type)
    // Generated from ids alone, so no filename can steer where the bytes land.
    const key = `${ctx.organizationId}/documents/${id}`

    await storage().put(key, Buffer.from(await input.file.arrayBuffer()), { contentType, filename })
    // Written before the database commits, so undone if it does not.
    ctx.afterRollback(() => storage().delete(key))

    await ctx.tx.insert(schema.clientDocuments).values({
      id,
      organizationId: ctx.organizationId,
      companyId: company.id,
      projectId: input.projectId ?? null,
      title: input.title ?? filename,
      category: input.category ?? 'other',
      filename,
      contentType,
      sizeBytes: input.file.size,
      storageKey: key,
      clientVisible: input.clientVisible ?? false,
      notes: input.notes ?? null,
      uploadedBy: actingUserId(ctx),
    })

    const document = await getDocument(ctx, id)
    await ctx.audit({ action: 'document.uploaded', entityType: 'document', entityId: id, entityLabel: document.title })
    await ctx.emit('document.uploaded', document)
    return document
  },
})

export const documentUpdate = defineProcedure({
  name: 'document.update',
  summary: "Change a document's title, category, note, or visibility. The file itself does not change: upload a new version.",
  permission: 'document:update',
  input: z.object({
    id: z.uuid(),
    title: requiredText(200, 'Title').optional(),
    category: z.enum(schema.CLIENT_DOCUMENT_CATEGORIES).optional(),
    projectId: z.uuid().nullish(),
    clientVisible: optionalFlag,
    notes: optionalText(10_000),
  }),
  output: documentOutput,
  http: { method: 'PATCH', path: '/documents/{id}' },
  emits: ['document.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadDocument(ctx, id)
    if (fields.projectId !== undefined) await assertProject(ctx, before.companyId, fields.projectId)

    const patch = provided(fields) as Partial<DocumentRow>
    const changes = diff(before as unknown as Record<string, unknown>, patch)
    if (!changes) return getDocument(ctx, id)

    await ctx.tx.update(schema.clientDocuments).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.clientDocuments.id, id))
    const document = await getDocument(ctx, id)
    await ctx.audit({ action: 'document.updated', entityType: 'document', entityId: id, entityLabel: document.title, changes })
    await ctx.emit('document.updated', document)
    return document
  },
})

export const documentDownload = defineProcedure({
  name: 'document.download',
  summary: 'A short-lived URL that downloads the document',
  permission: 'document:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({ url: z.string(), expiresAt: z.date(), filename: z.string() }),
  http: { method: 'GET', path: '/documents/{id}/download' },
  async handler(ctx, input) {
    const document = await loadDocument(ctx, input.id)
    const url = await storage().signedUrl(document.storageKey, {
      expiresInSeconds: DOWNLOAD_URL_SECONDS,
      filename: document.filename,
      contentType: document.contentType,
    })
    return { url, expiresAt: new Date(ctx.now.getTime() + DOWNLOAD_URL_SECONDS * 1000), filename: document.filename }
  },
})

export const documentDelete = defineProcedure({
  name: 'document.delete',
  summary: 'Delete a document and the file behind it',
  permission: 'document:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/documents/{id}' },
  emits: ['document.deleted'],
  async handler(ctx, input) {
    const row = await loadDocument(ctx, input.id)
    const document = await getDocument(ctx, input.id)
    await ctx.tx.delete(schema.clientDocuments).where(eq(schema.clientDocuments.id, input.id))
    // Only once the row is certainly gone: a deleted file with a surviving row
    // is a broken download, and the reverse is merely wasted bytes.
    ctx.afterCommit(() => storage().delete(row.storageKey))

    await ctx.audit({ action: 'document.deleted', entityType: 'document', entityId: document.id, entityLabel: document.title })
    await ctx.emit('document.deleted', document)
    return { deleted: true }
  },
})

/** Documents on file for a client, for the client view's Documents tab. */
export async function countDocuments(ctx: ActorContext, companyId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: count() })
    .from(schema.clientDocuments)
    .where(eq(schema.clientDocuments.companyId, companyId))
  return row?.n ?? 0
}
