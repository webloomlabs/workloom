import { inArray, schema } from '@workloom/db'
import { z } from 'zod'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { actingUserId, optionalText } from '../crm/shared.ts'
import { loadBankAccount, refuseArchivedAccount } from './accounts.ts'
import { bankTransactionOutput, getBankTransaction, settleBankTransaction, transferFingerprint } from './transactions.ts'

/**
 * Money moved between two of the agency's own accounts.
 *
 * A transfer is two lines, one in each register: money out of one account and
 * money in to the other, on the same day. Neither is income or spending, so
 * neither should sit on the "to explain" list waiting for a payment or an
 * expense that will never come.
 *
 * In one currency, each line is matched to the other -- the `transfer` match
 * the schema has always had room for -- so both read as explained. Between two
 * currencies a match cannot hold them (it is keyed by currency), so both lines
 * are set aside with the transfer as their reason instead.
 *
 * The pair shares an id, carried in each line's fingerprint
 * (`transfer:<id>:out` and `transfer:<id>:in`), and is only ever created or
 * deleted whole.
 */

type TransactionRow = typeof schema.bankTransactions.$inferSelect

export const bankTransferOutput = z.object({
  id: z.uuid(),
  bookedOn: z.iso.date(),
  /** The line in the account the money left. Negative. */
  from: bankTransactionOutput,
  /** The line in the account it arrived in. Positive. */
  to: bankTransactionOutput,
})

export type BankTransfer = z.infer<typeof bankTransferOutput>

async function loadLegs(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<{ from: TransactionRow; to: TransactionRow }> {
  const query = ctx.tx
    .select()
    .from(schema.bankTransactions)
    .where(inArray(schema.bankTransactions.fingerprint, [transferFingerprint(id, 'out'), transferFingerprint(id, 'in')]))
  const rows = await (options.lock ? query.for('update') : query)
  const from = rows.find((r) => r.fingerprint === transferFingerprint(id, 'out'))
  const to = rows.find((r) => r.fingerprint === transferFingerprint(id, 'in'))
  if (!from || !to) throw new NotFoundError('Bank transfer', id)
  return { from, to }
}

async function getTransfer(ctx: ActorContext, id: string): Promise<BankTransfer> {
  const legs = await loadLegs(ctx, id)
  const [from, to] = await Promise.all([getBankTransaction(ctx, legs.from.id), getBankTransaction(ctx, legs.to.id)])
  return { id, bookedOn: from.bookedOn, from, to }
}

export const bankTransferGet = defineProcedure({
  name: 'bankTransfer.get',
  summary: 'Both sides of a transfer between two of your accounts',
  permission: 'bankTransaction:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: bankTransferOutput,
  http: { method: 'GET', path: '/bank-transfers/{id}' },
  async handler(ctx, input) {
    return getTransfer(ctx, input.id)
  },
})

export const bankTransferCreate = defineProcedure({
  name: 'bankTransfer.create',
  summary: 'Move money from one of your accounts to another: a line out of one, and a line into the other',
  permission: 'bankTransaction:create',
  input: z.object({
    fromAccountId: z.uuid(),
    toAccountId: z.uuid(),
    /** What left the first account, in its currency. Positive. */
    amountMinor: z.number().int(),
    /**
     * What arrived, in the second account's currency. Only between accounts in
     * different currencies; in one currency, what arrives is what left.
     */
    receivedMinor: z.number().int().optional(),
    bookedOn: z.iso.date(),
    reference: optionalText(200),
    notes: optionalText(10_000),
  }),
  output: bankTransferOutput,
  http: { method: 'POST', path: '/bank-transfers', successStatus: 201 },
  emits: ['bank_transfer.created'],
  async handler(ctx, input) {
    if (input.fromAccountId === input.toAccountId) {
      throw new DomainError('Choose two different accounts.', 'same_account', 'toAccountId')
    }
    const from = await loadBankAccount(ctx, input.fromAccountId)
    const to = await loadBankAccount(ctx, input.toAccountId)
    refuseArchivedAccount(from)
    refuseArchivedAccount(to)
    if (input.amountMinor <= 0) {
      throw new DomainError('Enter how much was moved.', 'amount_not_positive', 'amountMinor')
    }
    // The opening balance already counts anything before it; a line then would count it twice.
    for (const account of [from, to]) {
      if (input.bookedOn <= account.openingBalanceOn) {
        throw new DomainError(
          `${account.name} opened on ${account.openingBalanceOn}, and its opening balance already includes anything before then. Date the transfer after that.`,
          'transfer_before_opening',
          'bookedOn',
        )
      }
    }

    const sameCurrency = from.currency === to.currency
    let received = input.amountMinor
    if (sameCurrency) {
      if (input.receivedMinor !== undefined && input.receivedMinor !== input.amountMinor) {
        throw new DomainError(`Both accounts are in ${from.currency}, so what arrives is what left.`, 'received_same_currency', 'receivedMinor')
      }
    } else {
      if (input.receivedMinor === undefined || input.receivedMinor <= 0) {
        throw new DomainError(`Enter how much arrived in ${to.currency}.`, 'received_required', 'receivedMinor')
      }
      received = input.receivedMinor
    }

    const id = newId()
    const fromLine = newId()
    const toLine = newId()
    // Between currencies nothing can match the two together, so each is set aside with the transfer as its reason.
    const setAside = (reason: string) => (sameCurrency ? { status: 'unexplained' } : { status: 'ignored', ignoredAt: ctx.now, ignoredReason: reason })
    const common = {
      organizationId: ctx.organizationId,
      bookedOn: input.bookedOn,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      createdBy: actingUserId(ctx),
    }
    await ctx.tx.insert(schema.bankTransactions).values([
      {
        ...common,
        id: fromLine,
        bankAccountId: from.id,
        currency: from.currency,
        amountMinor: -input.amountMinor,
        description: `Transfer to ${to.name}`,
        counterparty: to.name,
        fingerprint: transferFingerprint(id, 'out'),
        ...setAside(`Transfer to ${to.name} (${to.currency})`),
      },
      {
        ...common,
        id: toLine,
        bankAccountId: to.id,
        currency: to.currency,
        amountMinor: received,
        description: `Transfer from ${from.name}`,
        counterparty: from.name,
        fingerprint: transferFingerprint(id, 'in'),
        ...setAside(`Transfer from ${from.name} (${from.currency})`),
      },
    ])

    if (sameCurrency) {
      // Each side explains the other.
      await ctx.tx.insert(schema.bankTransactionMatches).values([
        { id: newId(), organizationId: ctx.organizationId, bankTransactionId: fromLine, currency: from.currency, kind: 'transfer', counterpartTransactionId: toLine, amountMinor: -input.amountMinor, createdBy: actingUserId(ctx) },
        { id: newId(), organizationId: ctx.organizationId, bankTransactionId: toLine, currency: to.currency, kind: 'transfer', counterpartTransactionId: fromLine, amountMinor: received, createdBy: actingUserId(ctx) },
      ])
      await settleBankTransaction(ctx, fromLine)
      await settleBankTransaction(ctx, toLine)
    }

    const transfer = await getTransfer(ctx, id)
    await ctx.audit({
      action: 'bank_transfer.created',
      entityType: 'bank_transfer',
      entityId: id,
      entityLabel: `${from.name} → ${to.name}`,
    })
    await ctx.emit('bank_transfer.created', transfer)
    return transfer
  },
})

export const bankTransferDelete = defineProcedure({
  name: 'bankTransfer.delete',
  summary: 'Delete a transfer between two of your accounts: both of its lines',
  permission: 'bankTransaction:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.uuid() }),
  http: { method: 'DELETE', path: '/bank-transfers/{id}' },
  emits: ['bank_transfer.deleted'],
  async handler(ctx, input) {
    const { from, to } = await loadLegs(ctx, input.id, { lock: true })
    if (from.reconciliationId || to.reconciliationId) {
      throw new DomainError(
        'One side of this transfer is part of a completed reconciliation. Undo the reconciliation to delete it.',
        'transaction_reconciled',
      )
    }
    const lines = [from.id, to.id]
    // The matches first: a line that explains something cannot be deleted.
    await ctx.tx.delete(schema.bankTransactionMatches).where(inArray(schema.bankTransactionMatches.bankTransactionId, lines))
    await ctx.tx.delete(schema.bankTransactions).where(inArray(schema.bankTransactions.id, lines))

    // Each line names the other account as its counterparty.
    const label = `${to.counterparty ?? 'Account'} → ${from.counterparty ?? 'account'}`
    await ctx.audit({ action: 'bank_transfer.deleted', entityType: 'bank_transfer', entityId: input.id, entityLabel: label })
    await ctx.emit('bank_transfer.deleted', { id: input.id, fromAccountId: from.bankAccountId, toAccountId: to.bankAccountId })
    return { id: input.id }
  },
})
