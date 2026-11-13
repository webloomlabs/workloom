import { asc, eq, isNull, schema, withTenant } from '@workloom/db'
import { z } from 'zod'
import { DomainError, type ActorContext } from '../../context.ts'
import { formatAmount } from '../../money/currency.ts'
import { buildContext, defineProcedure, type ExecutionRequest } from '../../registry/index.ts'
import { baseCurrency, optionalText } from '../crm/shared.ts'
import { today } from './documents.ts'
import { expenseOutput, createExpense, ensureExpenseCategories, expenseSource } from './expenses.ts'
import { RECEIPT_MAX_BYTES, receiptOutput, storeReceipt, type Receipt } from './expense-receipts.ts'
import { readReceipt, receiptDraftSchema, type ReceiptDraft, type ReceiptHints } from './receipt-extraction.ts'

/**
 * A receipt in, a draft expense out: what the Telegram bot does with a photo,
 * and what the expense form does when someone drops a receipt on it.
 *
 * Reading the receipt is done *before* this, outside any transaction -- a
 * model can take seconds, and a database connection should not wait on it.
 * What reading suggested arrives here as `draft`, already checked, and the
 * expense is created as a draft for a person to confirm. With no reading, the
 * draft is blank but for the receipt, and a person fills it in.
 */

/** What reading needs to know about the organization: its currency, its today, and its categories. */
export async function receiptHints(ctx: ActorContext): Promise<ReceiptHints & { enabled: boolean }> {
  await ensureExpenseCategories(ctx)
  const categories = await ctx.tx
    .select({ key: schema.expenseCategories.key, name: schema.expenseCategories.name })
    .from(schema.expenseCategories)
    .where(isNull(schema.expenseCategories.archivedAt))
    .orderBy(asc(schema.expenseCategories.position))
  const [org] = await ctx.tx.select({ enabled: schema.organization.receiptReadingEnabled }).from(schema.organization).where(eq(schema.organization.id, ctx.organizationId)).limit(1)
  return { baseCurrency: await baseCurrency(ctx), today: await today(ctx), categories, enabled: org?.enabled ?? false }
}

/** The organization's reading hints, in a short transaction of their own. */
export async function receiptHintsFor(request: Omit<ExecutionRequest, 'input'>): Promise<ReceiptHints & { enabled: boolean }> {
  return withTenant(request.organizationId, (tx) => receiptHints(buildContext(request, tx)))
}

/**
 * Reads a receipt for the expense form, when the organization has turned
 * reading on. Needs the right to record expenses. Never throws for a reader's
 * failure: the draft is simply left for the person to fill.
 */
export async function readReceiptFor(request: Omit<ExecutionRequest, 'input'>, file: { bytes: Buffer; contentType: string }): Promise<ReceiptDraft | null> {
  if (!request.permissions.has('expense:create')) return null
  const hints = await receiptHintsFor(request)
  return hints.enabled ? readReceipt(file, hints) : null
}

/** One line for a person: "Hostinger · LKR 12,500.00 · 30 Oct 2026". */
export function describeDraft(draft: ReceiptDraft | null, base: string): string {
  if (!draft) return 'Nothing could be read from it.'
  const parts = [draft.supplier, draft.amountMinor !== null && draft.currency ? formatAmount(draft.amountMinor, draft.currency) : null, draft.incurredOn].filter(Boolean)
  const foreign = draft.currency && draft.currency !== base && draft.amountMinor !== null ? ` Enter the ${draft.currency} to ${base} rate when you confirm it.` : ''
  return (parts.length > 0 ? parts.join(' · ') : 'Nothing could be read from it.') + foreign
}

/** A draft as a procedure takes it: what reading or the message gave, and -- for several receipts -- what each one said. */
const expenseDraftInput = receiptDraftSchema.extend({ receipts: z.array(receiptDraftSchema.nullable()).max(10).optional() })
const jsonField = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (typeof v === 'string' ? JSON.parse(v) : v), schema)

type DraftInput = z.infer<typeof expenseDraftInput>
type Duplicate = { expenseId: string; number: string | null; description: string }

/**
 * Starts a draft expense from what was read or typed, with its receipts
 * attached, in one transaction: the expense and every receipt, or none.
 */
async function startDraft(
  ctx: ActorContext,
  input: { files: File[]; draft: DraftInput | null; note?: string | null | undefined; projectId?: string | null | undefined; category?: string | undefined },
) {
  for (const file of input.files) if (file.size > RECEIPT_MAX_BYTES) throw new DomainError('A receipt can be at most 10 MB.', 'file_too_large', 'file')
  const { draft, files, note } = input
  const base = await baseCurrency(ctx)
  // A foreign amount needs a rate a person gives; until then the draft is in
  // the organization's currency, and what was read is kept with it.
  const local = draft && (draft.currency ?? base) === base
  const fallback = draft?.supplier ? `Receipt from ${draft.supplier}` : files.length > 1 ? `${files.length} receipts` : files.length === 1 ? 'Receipt' : 'Expense'
  const expense = await createExpense(
    ctx,
    {
      status: 'draft',
      description: draft?.description ?? note ?? fallback,
      supplier: draft?.supplier ?? null,
      incurredOn: draft?.incurredOn ?? undefined,
      currency: base,
      amountMinor: local ? (draft.amountMinor ?? 0) : 0,
      category: input.category ?? draft?.category ?? undefined,
      paymentMethod: draft?.paymentMethod ?? null,
      notes: note && draft?.description ? note : null,
      projectId: input.projectId ?? null,
      extraction: draft ? { ...draft } : null,
    },
    expenseSource(ctx),
  )
  const receipts: Receipt[] = []
  const duplicates: Duplicate[] = []
  for (const file of files) {
    const stored = await storeReceipt(ctx, expense.id, { bytes: Buffer.from(await file.arrayBuffer()), name: file.name }, expenseSource(ctx))
    receipts.push(stored.receipt)
    if (stored.duplicateOf && !duplicates.some((d) => d.expenseId === stored.duplicateOf!.expenseId)) duplicates.push(stored.duplicateOf)
  }
  return { expense, receipts, duplicates }
}

const duplicateOutput = z.object({ expenseId: z.uuid(), number: z.string().nullable(), description: z.string() })

export const expenseCreateFromReceipt = defineProcedure({
  name: 'expense.createFromReceipt',
  summary: 'Start a draft expense from a receipt (multipart/form-data), filled with what reading it suggested, for a person to confirm',
  permission: 'expense:create',
  input: z.object({
    file: z.file(),
    /** What reading the receipt suggested. Every value is optional; the draft is checked again on confirm. */
    draft: jsonField(receiptDraftSchema.nullable()).optional(),
    /** A note sent with the receipt, used as the description when reading gave none. */
    note: optionalText(500),
    projectId: z.uuid().nullish(),
  }),
  output: z.object({
    expense: expenseOutput,
    receipt: receiptOutput,
    duplicateOf: duplicateOutput.nullable(),
  }),
  http: { method: 'POST', path: '/expenses/from-receipt', successStatus: 201, body: 'multipart' },
  rateLimit: 'expensive',
  emits: ['expense.created', 'expense_receipt.added'],
  async handler(ctx, input) {
    const { expense, receipts, duplicates } = await startDraft(ctx, { files: [input.file], draft: input.draft ?? null, note: input.note, projectId: input.projectId })
    return { expense, receipt: receipts[0]!, duplicateOf: duplicates[0] ?? null }
  },
})

/** A form field that may come once, several times, or not at all. */
const filesField = z.preprocess((v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]), z.array(z.file()).max(10, 'At most 10 receipts at once.'))

export const expenseCreateDraft = defineProcedure({
  name: 'expense.createDraft',
  summary:
    'Start one draft expense from a typed line or from several receipts at once (multipart/form-data, a `files` field per receipt), for a person to confirm',
  permission: 'expense:create',
  input: z.object({
    /** Up to ten receipts, all evidence for the one expense. None for a typed expense. */
    files: filesField,
    /** What reading or the typed line gave -- for several receipts, their total, with what each said in `receipts`. */
    draft: jsonField(expenseDraftInput.nullable()).optional(),
    /** A category key, when the person named one: it wins over what reading suggested. */
    category: z.string().min(1).max(100).optional(),
    note: optionalText(500),
    projectId: z.uuid().nullish(),
  }),
  output: z.object({
    expense: expenseOutput,
    receipts: z.array(receiptOutput),
    /** Other expenses that already hold one of these receipts. */
    duplicates: z.array(duplicateOutput),
  }),
  http: { method: 'POST', path: '/expenses/drafts', successStatus: 201, body: 'multipart' },
  rateLimit: 'expensive',
  emits: ['expense.created', 'expense_receipt.added'],
  async handler(ctx, input) {
    const draft = input.draft ?? null
    if (input.files.length === 0 && !draft) throw new DomainError('Send a receipt, or what the expense was and what it cost.', 'draft_empty', 'draft')
    return startDraft(ctx, { files: input.files, draft, note: input.note, projectId: input.projectId, category: input.category })
  },
})
