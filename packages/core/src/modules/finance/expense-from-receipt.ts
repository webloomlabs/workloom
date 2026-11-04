import { asc, eq, isNull, schema, withTenant } from '@workloom/db'
import { z } from 'zod'
import { DomainError, type ActorContext } from '../../context.ts'
import { formatAmount } from '../../money/currency.ts'
import { buildContext, defineProcedure, type ExecutionRequest } from '../../registry/index.ts'
import { baseCurrency, optionalText } from '../crm/shared.ts'
import { today } from './documents.ts'
import { expenseOutput, createExpense, ensureExpenseCategories, expenseSource } from './expenses.ts'
import { RECEIPT_MAX_BYTES, receiptOutput, storeReceipt } from './expense-receipts.ts'
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

export const expenseCreateFromReceipt = defineProcedure({
  name: 'expense.createFromReceipt',
  summary: 'Start a draft expense from a receipt (multipart/form-data), filled with what reading it suggested, for a person to confirm',
  permission: 'expense:create',
  input: z.object({
    file: z.file(),
    /** What reading the receipt suggested. Every value is optional; the draft is checked again on confirm. */
    draft: z.preprocess((v) => (typeof v === 'string' ? JSON.parse(v) : v), receiptDraftSchema.nullable()).optional(),
    /** A note sent with the receipt, used as the description when reading gave none. */
    note: optionalText(500),
    projectId: z.uuid().nullish(),
  }),
  output: z.object({
    expense: expenseOutput,
    receipt: receiptOutput,
    duplicateOf: z.object({ expenseId: z.uuid(), number: z.string().nullable(), description: z.string() }).nullable(),
  }),
  http: { method: 'POST', path: '/expenses/from-receipt', successStatus: 201, body: 'multipart' },
  rateLimit: 'expensive',
  emits: ['expense.created', 'expense_receipt.added'],
  async handler(ctx, input) {
    if (input.file.size > RECEIPT_MAX_BYTES) throw new DomainError('A receipt can be at most 10 MB.', 'file_too_large', 'file')
    const draft = input.draft ?? null
    const base = await baseCurrency(ctx)
    // A foreign amount needs a rate a person gives; until then the draft is in
    // the organization's currency, and what was read is kept with it.
    const local = draft && (draft.currency ?? base) === base
    const category = draft?.category ?? undefined
    const expense = await createExpense(
      ctx,
      {
        status: 'draft',
        description: draft?.description ?? input.note ?? (draft?.supplier ? `Receipt from ${draft.supplier}` : 'Receipt'),
        supplier: draft?.supplier ?? null,
        incurredOn: draft?.incurredOn ?? undefined,
        currency: base,
        amountMinor: local ? (draft.amountMinor ?? 0) : 0,
        category,
        paymentMethod: draft?.paymentMethod ?? null,
        notes: input.note && draft?.description ? input.note : null,
        projectId: input.projectId ?? null,
        extraction: draft ? { ...draft } : null,
      },
      expenseSource(ctx),
    )
    const stored = await storeReceipt(ctx, expense.id, { bytes: Buffer.from(await input.file.arrayBuffer()), name: input.file.name }, expenseSource(ctx))
    return { expense, receipt: stored.receipt, duplicateOf: stored.duplicateOf }
  },
})
