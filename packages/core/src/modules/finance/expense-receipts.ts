import { createHash } from 'node:crypto'
import { and, asc, eq, ne, schema } from '@workloom/db'
import { isOneOf, storage, type SniffedType } from '@workloom/storage'
import { z } from 'zod'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId } from '../crm/shared.ts'
import { expenseSource } from './expenses.ts'

/**
 * The receipts behind an expense: what an auditor asks to see.
 *
 * A receipt is a photo or a PDF. Its bytes decide what it is -- a file named
 * `receipt.jpg` that is really an HTML page is refused -- and it is kept under
 * a key made of ids alone. The same receipt sent twice is spotted by its
 * SHA-256 and flagged, not refused: two coffees can cost the same.
 */

/** What a receipt may be. HEIC is what an iPhone takes; it is kept but cannot be previewed. */
export const RECEIPT_TYPES: readonly SniffedType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf']
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024

const EXTENSIONS: Record<SniffedType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
}

export const receiptOutput = z.object({
  id: z.uuid(),
  expenseId: z.uuid(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  source: z.enum(schema.EXPENSE_SOURCES),
  /** Whether the browser can show it: images other than HEIC. */
  previewable: z.boolean(),
  createdAt: z.date(),
})

export type Receipt = z.infer<typeof receiptOutput>

type ReceiptRow = typeof schema.expenseReceipts.$inferSelect

function present(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    expenseId: row.expenseId,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    source: row.source as Receipt['source'],
    previewable: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(row.contentType),
    createdAt: row.createdAt,
  }
}

/** A filename safe to show and to offer as the download name, with the extension its bytes deserve. */
export function receiptFilename(name: string | undefined, type: SniffedType): string {
  const base = (name ?? 'receipt')
    .replace(/\.[^.]*$/, '')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 80)
  return `${base || 'receipt'}.${EXTENSIONS[type]}`
}

/**
 * The expense a receipt is being attached to or taken off. Your own expense is
 * yours to evidence; someone else's needs the right to change expenses.
 */
async function loadExpenseForReceipts(ctx: ActorContext, expenseId: string) {
  const [expense] = await ctx.tx.select().from(schema.expenses).where(eq(schema.expenses.id, expenseId)).limit(1)
  if (!expense) throw new NotFoundError('Expense', expenseId)
  if (expense.createdBy !== actingUserId(ctx)) ctx.require('expense:update')
  return expense
}

export type StoredReceipt = { receipt: Receipt; duplicateOf: { expenseId: string; number: string | null; description: string } | null }

/**
 * Checks, stores, and records a receipt. Used by the upload procedure and by
 * the Telegram bot, so a receipt arriving either way is held to the same rules.
 */
export async function storeReceipt(
  ctx: ActorContext,
  expenseId: string,
  file: { bytes: Buffer; name?: string | undefined },
  source: (typeof schema.EXPENSE_SOURCES)[number],
): Promise<StoredReceipt> {
  if (file.bytes.byteLength === 0) throw new DomainError('That file is empty.', 'file_empty', 'file')
  if (file.bytes.byteLength > RECEIPT_MAX_BYTES) throw new DomainError('A receipt can be at most 10 MB.', 'file_too_large', 'file')
  const type = isOneOf(file.bytes, RECEIPT_TYPES)
  if (!type) throw new DomainError('A receipt must be a photo (JPEG, PNG, WebP, HEIC) or a PDF.', 'file_type', 'file')

  const sha256 = createHash('sha256').update(file.bytes).digest('hex')
  const r = schema.expenseReceipts
  const [duplicate] = await ctx.tx
    .select({ expenseId: r.expenseId, number: schema.expenses.number, description: schema.expenses.description })
    .from(r)
    .innerJoin(schema.expenses, eq(schema.expenses.id, r.expenseId))
    .where(and(eq(r.sha256, sha256), ne(r.expenseId, expenseId)))
    .limit(1)

  const id = newId()
  // Ids alone: no filename can steer where the bytes land.
  const key = `${ctx.organizationId}/receipts/${expenseId}/${id}`
  const filename = receiptFilename(file.name, type)
  await storage().put(key, file.bytes, { contentType: type, filename })
  ctx.afterRollback(() => storage().delete(key))
  await ctx.tx.insert(r).values({
    id,
    organizationId: ctx.organizationId,
    expenseId,
    storageKey: key,
    filename,
    contentType: type,
    sizeBytes: file.bytes.byteLength,
    sha256,
    source,
    uploadedBy: actingUserId(ctx),
  })
  const [row] = await ctx.tx.select().from(r).where(eq(r.id, id))
  const receipt = present(row!)
  await ctx.audit({
    action: 'expense_receipt.added',
    entityType: 'expense',
    entityId: expenseId,
    entityLabel: filename,
    changes: { receipts: { from: null, to: filename }, ...(duplicate ? { duplicateOf: { from: null, to: duplicate.expenseId } } : {}) },
  })
  await ctx.emit('expense_receipt.added', receipt)
  return { receipt, duplicateOf: duplicate ?? null }
}

export const expenseReceiptList = defineProcedure({
  name: 'expenseReceipt.list',
  summary: "An expense's receipts",
  permission: 'expense:read',
  readOnly: true,
  input: z.object({ expenseId: z.uuid() }),
  output: z.object({ data: z.array(receiptOutput) }),
  http: { method: 'GET', path: '/expenses/{expenseId}/receipts' },
  async handler(ctx, input) {
    const [expense] = await ctx.tx.select({ id: schema.expenses.id }).from(schema.expenses).where(eq(schema.expenses.id, input.expenseId)).limit(1)
    if (!expense) throw new NotFoundError('Expense', input.expenseId)
    const rows = await ctx.tx.select().from(schema.expenseReceipts).where(eq(schema.expenseReceipts.expenseId, input.expenseId)).orderBy(asc(schema.expenseReceipts.createdAt))
    return { data: rows.map(present) }
  },
})

export const expenseReceiptUpload = defineProcedure({
  name: 'expenseReceipt.upload',
  summary: 'Attach a receipt -- a photo or a PDF, up to 10 MB -- to an expense (multipart/form-data)',
  permission: 'expense:create',
  input: z.object({ expenseId: z.uuid(), file: z.file() }),
  output: receiptOutput.extend({
    /** Another expense already has this exact file: possibly the same purchase entered twice. */
    duplicateOf: z.object({ expenseId: z.uuid(), number: z.string().nullable(), description: z.string() }).nullable(),
  }),
  http: { method: 'POST', path: '/expenses/{expenseId}/receipts', successStatus: 201, body: 'multipart' },
  rateLimit: 'expensive',
  emits: ['expense_receipt.added'],
  async handler(ctx, input) {
    await loadExpenseForReceipts(ctx, input.expenseId)
    if (input.file.size > RECEIPT_MAX_BYTES) throw new DomainError('A receipt can be at most 10 MB.', 'file_too_large', 'file')
    const stored = await storeReceipt(ctx, input.expenseId, { bytes: Buffer.from(await input.file.arrayBuffer()), name: input.file.name }, expenseSource(ctx))
    return { ...stored.receipt, duplicateOf: stored.duplicateOf }
  },
})

async function loadReceipt(ctx: ActorContext, id: string): Promise<ReceiptRow> {
  const [row] = await ctx.tx.select().from(schema.expenseReceipts).where(eq(schema.expenseReceipts.id, id)).limit(1)
  if (!row) throw new NotFoundError('Receipt', id)
  return row
}

export const expenseReceiptDownload = defineProcedure({
  name: 'expenseReceipt.download',
  summary: 'A short-lived link to a receipt. Images open in the browser; PDFs and HEIC photos download.',
  permission: 'expense:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: z.object({ url: z.url(), expiresAt: z.date(), filename: z.string(), inline: z.boolean() }),
  http: { method: 'GET', path: '/expense-receipts/{id}/download' },
  async handler(ctx, input) {
    const receipt = present(await loadReceipt(ctx, input.id))
    const row = await loadReceipt(ctx, input.id)
    const expiresInSeconds = 300
    const url = await storage().signedUrl(row.storageKey, {
      expiresInSeconds,
      filename: receipt.filename,
      contentType: receipt.contentType,
      inline: receipt.previewable,
    })
    return { url, expiresAt: new Date(ctx.now.getTime() + expiresInSeconds * 1000), filename: receipt.filename, inline: receipt.previewable }
  },
})

export const expenseReceiptDelete = defineProcedure({
  name: 'expenseReceipt.delete',
  summary: 'Take a receipt off an expense',
  permission: 'expense:create',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/expense-receipts/{id}' },
  emits: ['expense_receipt.removed'],
  async handler(ctx, input) {
    const row = await loadReceipt(ctx, input.id)
    await loadExpenseForReceipts(ctx, row.expenseId)
    await ctx.tx.delete(schema.expenseReceipts).where(eq(schema.expenseReceipts.id, row.id))
    ctx.afterCommit(() => storage().delete(row.storageKey))
    await ctx.audit({ action: 'expense_receipt.removed', entityType: 'expense', entityId: row.expenseId, entityLabel: row.filename, changes: { receipts: { from: row.filename, to: null } } })
    await ctx.emit('expense_receipt.removed', present(row))
    return { deleted: true }
  },
})
