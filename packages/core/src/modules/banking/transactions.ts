import { and, desc, eq, gte, ilike, lt, lte, or, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import {
  actingUserId,
  contains,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  requiredText,
  searchInput,
} from '../crm/shared.ts'
import { loadBankAccount, refuseArchivedAccount } from './accounts.ts'
import { explainedStatus, unexplainedMinor } from './explained.ts'

/**
 * The register: what the bank says moved, newest first.
 *
 * Amounts are signed here -- positive in, negative out -- and `description`
 * holds the narration exactly as the bank wrote it. Both are what let a line be
 * recognised months later by someone holding the paper statement.
 *
 * Lines arrive by import in the ordinary case; this module is what reads them
 * back, and what lets one be typed in when a statement has not come yet.
 */

type TransactionRow = typeof schema.bankTransactions.$inferSelect

export const bankTransactionOutput = z.object({
  id: z.uuid(),
  bankAccountId: z.uuid(),
  bankAccountName: z.string(),
  currency: z.string().length(3),
  /** Signed: positive is money in, negative is money out. */
  amountMinor: z.number().int(),
  /** How much of it is explained by matches. Same sign. */
  matchedMinor: z.number().int(),
  /** What is left, keeping the sign. Zero once the line is fully explained. */
  unexplainedMinor: z.number().int(),
  bookedOn: z.iso.date(),
  valueOn: z.iso.date().nullable(),
  description: z.string(),
  counterparty: z.string().nullable(),
  reference: z.string().nullable(),
  balanceAfterMinor: z.number().int().nullable(),
  status: z.enum(schema.BANK_TRANSACTION_STATUSES),
  ignoredReason: z.string().nullable(),
  /**
   * The account balance up to and including this line. Null unless the list was
   * scoped to one account without an amount or text filter -- a running balance
   * over a filtered set is a lie, so it is withheld rather than approximated.
   */
  runningBalanceMinor: z.number().int().nullable(),
  reconciliationId: z.uuid().nullable(),
  importId: z.uuid().nullable(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type BankTransaction = z.infer<typeof bankTransactionOutput>

type TransactionJoin = {
  line: TransactionRow
  bankAccountName: string
  runningBalanceMinor: number | null
}

function presentTransaction(row: TransactionJoin): BankTransaction {
  const t = row.line
  return {
    id: t.id,
    bankAccountId: t.bankAccountId,
    bankAccountName: row.bankAccountName,
    currency: t.currency,
    amountMinor: t.amountMinor,
    matchedMinor: t.matchedMinor,
    unexplainedMinor: unexplainedMinor(t),
    bookedOn: t.bookedOn,
    valueOn: t.valueOn,
    description: t.description,
    counterparty: t.counterparty,
    reference: t.reference,
    balanceAfterMinor: t.balanceAfterMinor,
    status: t.status as BankTransaction['status'],
    ignoredReason: t.ignoredReason,
    runningBalanceMinor: row.runningBalanceMinor,
    reconciliationId: t.reconciliationId,
    importId: t.importId,
    notes: t.notes,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

/**
 * The line, its account, and optionally the balance up to it.
 *
 * The running balance is a correlated subquery rather than a window function:
 * a window is computed over the rows a page left behind, so on page two it
 * would silently restart. The row comparison below rides the
 * `(organization_id, bank_account_id, booked_on)` index.
 */
function selectTransactions(ctx: ActorContext, options: { runningBalance?: boolean } = {}) {
  const t = schema.bankTransactions
  const a = schema.bankAccounts
  const running = options.runningBalance
    ? sql<number>`(${a.openingBalanceMinor} + (
        select coalesce(sum(prior.amount_minor), 0)
          from ${t} prior
         where prior.bank_account_id = ${t.bankAccountId}
           and (prior.booked_on, prior.id) <= (${t.bookedOn}, ${t.id})
      ))::int`
    : sql<number | null>`null::int`
  return ctx.tx
    .select({ line: t, bankAccountName: a.name, runningBalanceMinor: running })
    .from(t)
    .innerJoin(a, eq(a.id, t.bankAccountId))
}

export async function getBankTransaction(ctx: ActorContext, id: string): Promise<BankTransaction> {
  const [row] = await selectTransactions(ctx).where(eq(schema.bankTransactions.id, id)).limit(1)
  if (!row) throw new NotFoundError('Bank transaction', id)
  return presentTransaction(row)
}

export async function loadBankTransaction(
  ctx: ActorContext,
  id: string,
  options: { lock?: boolean } = {},
): Promise<TransactionRow> {
  const query = ctx.tx.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, id)).limit(1)
  const [row] = await (options.lock ? query.for('update') : query)
  if (!row) throw new NotFoundError('Bank transaction', id)
  return row
}

/** A reconciled line is history. Nothing below may change one. */
function refuseReconciled(line: TransactionRow): void {
  if (line.reconciliationId) {
    throw new DomainError(
      'That transaction is part of a completed reconciliation. Undo the reconciliation to change it.',
      'transaction_reconciled',
    )
  }
}

/**
 * Re-reads the trigger-maintained `matched_minor` and writes the status that
 * follows from it. The internal analogue of settling an invoice: one function,
 * so no path invents its own idea of what state a line is in.
 */
export async function settleBankTransaction(ctx: ActorContext, id: string): Promise<void> {
  const line = await loadBankTransaction(ctx, id)
  const status = explainedStatus(line)
  if (status === line.status) return
  await ctx.tx
    .update(schema.bankTransactions)
    .set({ status, updatedAt: ctx.now })
    .where(eq(schema.bankTransactions.id, id))
}

// Reads

export const bankTransactionList = defineProcedure({
  name: 'bankTransaction.list',
  summary: 'The bank register, filtered by account, status, direction, date, amount, or text',
  permission: 'bankTransaction:read',
  readOnly: true,
  input: z.object({
    bankAccountId: z.uuid().optional(),
    status: z.enum(schema.BANK_TRANSACTION_STATUSES).optional(),
    /** Money in or money out. */
    direction: z.enum(['in', 'out']).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    /** Compared against the magnitude, so it reads the same either direction. */
    minAmountMinor: z.coerce.number().int().min(0).optional(),
    maxAmountMinor: z.coerce.number().int().min(0).optional(),
    /** Matches the narration, the counterparty, or the reference. */
    q: searchInput,
    ...pageInput,
  }),
  output: pageOutput(bankTransactionOutput),
  http: { method: 'GET', path: '/bank-transactions' },
  async handler(ctx, input) {
    const t = schema.bankTransactions
    if (input.bankAccountId) await loadBankAccount(ctx, input.bankAccountId)

    // A running balance only means something down one account's own column,
    // and only when nothing has been filtered out of the middle of it.
    const runningBalance =
      Boolean(input.bankAccountId) &&
      input.minAmountMinor === undefined &&
      input.maxAmountMinor === undefined &&
      !input.q &&
      !input.status &&
      !input.direction

    const conditions: Array<SQL | undefined> = [
      input.bankAccountId ? eq(t.bankAccountId, input.bankAccountId) : undefined,
      input.status ? eq(t.status, input.status) : undefined,
      input.direction === 'in' ? sql`${t.amountMinor} > 0` : undefined,
      input.direction === 'out' ? sql`${t.amountMinor} < 0` : undefined,
      input.from ? gte(t.bookedOn, input.from) : undefined,
      input.to ? lte(t.bookedOn, input.to) : undefined,
      input.minAmountMinor !== undefined ? sql`abs(${t.amountMinor}) >= ${input.minAmountMinor}` : undefined,
      input.maxAmountMinor !== undefined ? sql`abs(${t.amountMinor}) <= ${input.maxAmountMinor}` : undefined,
      input.q
        ? or(ilike(t.description, contains(input.q)), ilike(t.counterparty, contains(input.q)), ilike(t.reference, contains(input.q)))
        : undefined,
      input.cursor ? lt(t.id, input.cursor) : undefined,
    ]
    const rows = await selectTransactions(ctx, { runningBalance })
      .where(and(...conditions))
      .orderBy(desc(t.bookedOn), desc(t.id))
      .limit(input.limit + 1)
    return paginate(rows.map(presentTransaction), input.limit)
  },
})

export const bankTransactionGet = defineProcedure({
  name: 'bankTransaction.get',
  summary: 'One statement line',
  permission: 'bankTransaction:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: bankTransactionOutput,
  http: { method: 'GET', path: '/bank-transactions/{id}' },
  async handler(ctx, input) {
    return getBankTransaction(ctx, input.id)
  },
})

// Writes

const transactionFields = {
  counterparty: optionalText(200),
  reference: optionalText(200),
  valueOn: z.iso.date().nullish(),
  notes: optionalText(10_000),
}

export const bankTransactionCreate = defineProcedure({
  name: 'bankTransaction.create',
  summary: 'Enter a statement line by hand, when the statement has not arrived yet',
  permission: 'bankTransaction:create',
  input: z.object({
    bankAccountId: z.uuid(),
    /** Signed: positive is money in, negative is money out. Never zero. */
    amountMinor: z.number().int(),
    bookedOn: z.iso.date(),
    description: requiredText(500, 'Description'),
    ...transactionFields,
  }),
  output: bankTransactionOutput,
  http: { method: 'POST', path: '/bank-transactions', successStatus: 201 },
  emits: ['bank_transaction.created'],
  async handler(ctx, input) {
    const account = await loadBankAccount(ctx, input.bankAccountId)
    refuseArchivedAccount(account)
    if (input.amountMinor === 0) {
      throw new DomainError('A transaction of nothing is not a movement of money.', 'amount_zero', 'amountMinor')
    }

    const id = newId()
    await ctx.tx.insert(schema.bankTransactions).values({
      id,
      organizationId: ctx.organizationId,
      bankAccountId: account.id,
      // From the account, not from the caller: the foreign key requires they agree.
      currency: account.currency,
      amountMinor: input.amountMinor,
      bookedOn: input.bookedOn,
      valueOn: input.valueOn ?? null,
      description: input.description,
      counterparty: input.counterparty ?? null,
      reference: input.reference ?? null,
      status: 'unexplained',
      // Hand entry gets a fingerprint that cannot collide with an imported one,
      // so typing a line in never blocks the statement it later appears on.
      fingerprint: `manual:${id}`,
      notes: input.notes ?? null,
      createdBy: actingUserId(ctx),
    })

    const line = await getBankTransaction(ctx, id)
    await ctx.audit({
      action: 'bank_transaction.created',
      entityType: 'bank_transaction',
      entityId: id,
      entityLabel: line.description,
    })
    await ctx.emit('bank_transaction.created', line)
    return line
  },
})

export const bankTransactionUpdate = defineProcedure({
  name: 'bankTransaction.update',
  summary: 'Correct a statement line',
  permission: 'bankTransaction:update',
  input: z.object({
    id: z.uuid(),
    description: requiredText(500, 'Description').optional(),
    /** Only while nothing is matched to it: what a match explains must stay fixed. */
    amountMinor: z.number().int().optional(),
    bookedOn: z.iso.date().optional(),
    ...transactionFields,
  }),
  output: bankTransactionOutput,
  http: { method: 'PATCH', path: '/bank-transactions/{id}' },
  emits: ['bank_transaction.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadBankTransaction(ctx, id, { lock: true })
    refuseReconciled(before)
    const patch = provided(fields)

    const movesMoney =
      (patch.amountMinor !== undefined && patch.amountMinor !== before.amountMinor) ||
      (patch.bookedOn !== undefined && patch.bookedOn !== before.bookedOn)
    if (movesMoney && before.matchedMinor !== 0) {
      throw new DomainError(
        'This transaction explains a payment or an expense. Unmatch it before changing what it says.',
        'transaction_matched',
        'amountMinor',
      )
    }
    if (patch.amountMinor === 0) {
      throw new DomainError('A transaction of nothing is not a movement of money.', 'amount_zero', 'amountMinor')
    }

    const changes = diff(before as unknown as Record<string, unknown>, patch as Partial<TransactionRow>)
    if (!changes) return getBankTransaction(ctx, id)

    await ctx.tx
      .update(schema.bankTransactions)
      .set({ ...(patch as Partial<TransactionRow>), updatedAt: ctx.now })
      .where(eq(schema.bankTransactions.id, id))

    const line = await getBankTransaction(ctx, id)
    await ctx.audit({
      action: 'bank_transaction.updated',
      entityType: 'bank_transaction',
      entityId: id,
      entityLabel: line.description,
      changes,
    })
    await ctx.emit('bank_transaction.updated', line)
    return line
  },
})

export const bankTransactionDelete = defineProcedure({
  name: 'bankTransaction.delete',
  summary: 'Delete a statement line that should never have been there',
  permission: 'bankTransaction:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.uuid() }),
  http: { method: 'DELETE', path: '/bank-transactions/{id}' },
  emits: ['bank_transaction.deleted'],
  async handler(ctx, input) {
    const line = await loadBankTransaction(ctx, input.id, { lock: true })
    refuseReconciled(line)
    if (line.matchedMinor !== 0) {
      throw new DomainError(
        'This transaction explains a payment or an expense. Unmatch it before deleting it.',
        'transaction_matched',
      )
    }

    await ctx.tx.delete(schema.bankTransactions).where(eq(schema.bankTransactions.id, input.id))
    await ctx.audit({
      action: 'bank_transaction.deleted',
      entityType: 'bank_transaction',
      entityId: input.id,
      entityLabel: line.description,
    })
    await ctx.emit('bank_transaction.deleted', { id: input.id, bankAccountId: line.bankAccountId, description: line.description })
    return { id: input.id }
  },
})

export const bankTransactionIgnore = defineProcedure({
  name: 'bankTransaction.ignore',
  summary: 'Set a line aside with a reason, so it stops asking to be explained',
  permission: 'bankTransaction:reconcile',
  input: z.object({
    id: z.uuid(),
    /** Required: a line set aside without a reason is one nobody can audit. */
    reason: requiredText(500, 'Reason'),
  }),
  output: bankTransactionOutput,
  http: { method: 'POST', path: '/bank-transactions/{id}/ignore' },
  emits: ['bank_transaction.ignored'],
  async handler(ctx, input) {
    const before = await loadBankTransaction(ctx, input.id, { lock: true })
    refuseReconciled(before)
    if (before.ignoredAt) throw new DomainError('That transaction is already set aside.', 'already_ignored')

    await ctx.tx
      .update(schema.bankTransactions)
      .set({
        ignoredAt: ctx.now,
        ignoredReason: input.reason,
        status: explainedStatus({ ...before, ignoredAt: ctx.now }),
        updatedAt: ctx.now,
      })
      .where(eq(schema.bankTransactions.id, input.id))

    const line = await getBankTransaction(ctx, input.id)
    await ctx.audit({
      action: 'bank_transaction.ignored',
      entityType: 'bank_transaction',
      entityId: input.id,
      entityLabel: line.description,
    })
    await ctx.emit('bank_transaction.ignored', line)
    return line
  },
})

export const bankTransactionUnignore = defineProcedure({
  name: 'bankTransaction.unignore',
  summary: 'Put a set-aside line back on the list',
  permission: 'bankTransaction:reconcile',
  input: z.object({ id: z.uuid() }),
  output: bankTransactionOutput,
  http: { method: 'DELETE', path: '/bank-transactions/{id}/ignore' },
  emits: ['bank_transaction.updated'],
  async handler(ctx, input) {
    const before = await loadBankTransaction(ctx, input.id, { lock: true })
    refuseReconciled(before)
    if (!before.ignoredAt) throw new DomainError('That transaction is not set aside.', 'not_ignored')

    await ctx.tx
      .update(schema.bankTransactions)
      .set({
        ignoredAt: null,
        ignoredReason: null,
        status: explainedStatus({ ...before, ignoredAt: null }),
        updatedAt: ctx.now,
      })
      .where(eq(schema.bankTransactions.id, input.id))

    const line = await getBankTransaction(ctx, input.id)
    await ctx.audit({
      action: 'bank_transaction.updated',
      entityType: 'bank_transaction',
      entityId: input.id,
      entityLabel: line.description,
    })
    await ctx.emit('bank_transaction.updated', line)
    return line
  },
})
