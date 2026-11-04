import { and, eq, isNotNull, schema, sql } from '@workloom/db'
import type { ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { actingUserId } from '../crm/shared.ts'
import { settleBankTransaction } from './transactions.ts'

/**
 * Money recorded in Workloom, shown in the account it went through.
 *
 * A payment received into an account, or an expense paid from one, puts a line
 * in that account's register -- already explained by the payment or expense
 * that made it -- so the account's balance moves the moment the money is
 * recorded, not when a statement is imported. These lines carry the fingerprint
 * `recorded:payment:<id>` or `recorded:expense:<id>`: a statement import can
 * recognise them as already present.
 *
 * Nothing dated on or before the account's opening balance is added: that
 * balance already includes it. Nor is money in a different currency from the
 * account's: it never went through this account as recorded.
 *
 * The line follows its payment or expense: changed with it, moved with it, and
 * removed with it. A reconciled line is history and is left as it is.
 */

type Kind = 'payment' | 'expense'
type Wanted = { bankAccountId: string; currency: string; amountMinor: number; bookedOn: string; description: string; counterparty: string | null; reference: string | null }

const fingerprint = (kind: Kind, id: string) => `recorded:${kind}:${id}`

async function recordedLine(ctx: ActorContext, kind: Kind, id: string) {
  const [line] = await ctx.tx.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.fingerprint, fingerprint(kind, id))).limit(1)
  return line ?? null
}

/** Takes away the line a payment or expense put in its account. Before a change it does not fit, or a delete. */
export async function dropRecordedLine(ctx: ActorContext, kind: Kind, id: string): Promise<void> {
  const line = await recordedLine(ctx, kind, id)
  if (!line || line.reconciliationId) return
  // The match first: a line that explains something cannot be deleted.
  await ctx.tx.delete(schema.bankTransactionMatches).where(eq(schema.bankTransactionMatches.bankTransactionId, line.id))
  await ctx.tx.delete(schema.bankTransactions).where(eq(schema.bankTransactions.id, line.id))
}

/** Whether the money belongs in the account's register at all, and if so, as what. */
async function placeable(ctx: ActorContext, wanted: Omit<Wanted, 'bankAccountId'> & { bankAccountId: string | null }): Promise<Wanted | null> {
  if (!wanted.bankAccountId || wanted.amountMinor === 0) return null
  const [account] = await ctx.tx
    .select({ currency: schema.bankAccounts.currency, openingOn: schema.bankAccounts.openingBalanceOn })
    .from(schema.bankAccounts)
    .where(eq(schema.bankAccounts.id, wanted.bankAccountId))
    .limit(1)
  if (!account || account.currency !== wanted.currency || wanted.bookedOn <= account.openingOn) return null
  return wanted as Wanted
}

async function place(ctx: ActorContext, kind: Kind, id: string, wanted: Wanted | null): Promise<void> {
  const line = await recordedLine(ctx, kind, id)
  if (line?.reconciliationId) return
  if (
    line &&
    wanted &&
    line.bankAccountId === wanted.bankAccountId &&
    line.amountMinor === wanted.amountMinor &&
    line.bookedOn === wanted.bookedOn &&
    line.description === wanted.description
  ) {
    return
  }
  if (line) await dropRecordedLine(ctx, kind, id)
  if (!wanted) return

  const lineId = newId()
  await ctx.tx.insert(schema.bankTransactions).values({
    id: lineId,
    organizationId: ctx.organizationId,
    bankAccountId: wanted.bankAccountId,
    currency: wanted.currency,
    amountMinor: wanted.amountMinor,
    bookedOn: wanted.bookedOn,
    description: wanted.description,
    counterparty: wanted.counterparty,
    reference: wanted.reference,
    status: 'unexplained',
    fingerprint: fingerprint(kind, id),
    notes: 'Recorded in Workloom',
    createdBy: actingUserId(ctx),
  })
  await ctx.tx.insert(schema.bankTransactionMatches).values({
    id: newId(),
    organizationId: ctx.organizationId,
    bankTransactionId: lineId,
    currency: wanted.currency,
    kind,
    ...(kind === 'payment' ? { paymentId: id } : { expenseId: id }),
    amountMinor: wanted.amountMinor,
    createdBy: actingUserId(ctx),
  })
  await settleBankTransaction(ctx, lineId)
}

/** Brings a payment's line in its account up to date with the payment. */
export async function syncPaymentLine(ctx: ActorContext, paymentId: string): Promise<void> {
  const p = schema.payments
  const [payment] = await ctx.tx
    .select({
      bankAccountId: p.bankAccountId,
      currency: p.currency,
      kind: p.kind,
      amountMinor: p.amountMinor,
      receivedOn: p.receivedOn,
      reference: p.reference,
      client: schema.companies.name,
      invoices: sql<string>`coalesce((select string_agg(i.number, ', ' order by i.number) from payment_allocations a join invoices i on i.id = a.invoice_id where a.payment_id = ${p.id}), '')`,
    })
    .from(p)
    .innerJoin(schema.companies, eq(schema.companies.id, p.companyId))
    .where(eq(p.id, paymentId))
    .limit(1)
  if (!payment) return
  const refund = payment.kind === 'refund'
  const wanted = await placeable(ctx, {
    bankAccountId: payment.bankAccountId,
    currency: payment.currency,
    amountMinor: refund ? -payment.amountMinor : payment.amountMinor,
    bookedOn: payment.receivedOn,
    description: `${refund ? 'Refund to' : 'Payment from'} ${payment.client}${payment.invoices ? ` (${payment.invoices})` : ''}`,
    counterparty: payment.client,
    reference: payment.reference,
  })
  await place(ctx, 'payment', paymentId, wanted)
}

/** Brings a confirmed expense's line in the account it was paid from up to date. Drafts have none. */
export async function syncExpenseLine(ctx: ActorContext, expenseId: string): Promise<void> {
  const [expense] = await ctx.tx.select().from(schema.expenses).where(eq(schema.expenses.id, expenseId)).limit(1)
  if (!expense) return
  const wanted =
    expense.status === 'confirmed'
      ? await placeable(ctx, {
          bankAccountId: expense.bankAccountId,
          currency: expense.currency,
          // What left the account is the whole receipt, tax included.
          amountMinor: -(expense.amountMinor + expense.taxMinor),
          bookedOn: expense.paidOn ?? expense.incurredOn,
          description: `${expense.number ? `${expense.number} ` : ''}${expense.supplier ?? expense.description}`,
          counterparty: expense.supplier,
          reference: expense.number,
        })
      : null
  await place(ctx, 'expense', expenseId, wanted)
}

/** Every payment and expense recorded against an account, placed again: after its opening balance moves. */
export async function resyncAccount(ctx: ActorContext, bankAccountId: string): Promise<void> {
  const payments = await ctx.tx.select({ id: schema.payments.id }).from(schema.payments).where(eq(schema.payments.bankAccountId, bankAccountId))
  for (const p of payments) await syncPaymentLine(ctx, p.id)
  const expenses = await ctx.tx.select({ id: schema.expenses.id }).from(schema.expenses).where(eq(schema.expenses.bankAccountId, bankAccountId))
  for (const e of expenses) await syncExpenseLine(ctx, e.id)
}

/**
 * Places money recorded before lines were kept this way, once. For the
 * worker's hourly pass: payments and confirmed expenses recorded against an
 * account that no line explains yet. Returns how many it placed.
 */
export async function placeRecordedMoney(ctx: ActorContext): Promise<number> {
  const m = schema.bankTransactionMatches
  const payments = await ctx.tx
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(and(isNotNull(schema.payments.bankAccountId), sql`not exists (select 1 from ${m} where ${m.paymentId} = ${schema.payments.id})`))
    .limit(500)
  const expenses = await ctx.tx
    .select({ id: schema.expenses.id })
    .from(schema.expenses)
    .where(and(isNotNull(schema.expenses.bankAccountId), eq(schema.expenses.status, 'confirmed'), sql`not exists (select 1 from ${m} where ${m.expenseId} = ${schema.expenses.id})`))
    .limit(500)
  let placed = 0
  for (const p of payments) {
    await syncPaymentLine(ctx, p.id)
    if (await recordedLine(ctx, 'payment', p.id)) placed += 1
  }
  for (const e of expenses) {
    await syncExpenseLine(ctx, e.id)
    if (await recordedLine(ctx, 'expense', e.id)) placed += 1
  }
  return placed
}

