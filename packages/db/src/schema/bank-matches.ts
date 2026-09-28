import { sql } from 'drizzle-orm'
import { bigint, check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn } from './columns.ts'
import { bankTransactions } from './banking.ts'
import { expenses, payments } from './finance.ts'

/**
 * What explains a statement line.
 *
 * In its own file rather than beside the accounts and transactions, because it
 * is the one banking table that reaches into finance -- and `finance.ts` now
 * reaches back the other way, for the account a payment or an expense moved
 * through. Keeping the match here leaves both of those a one-way edge instead
 * of a cycle between two schema files.
 */

export const BANK_MATCH_KINDS = ['payment', 'expense', 'transfer'] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

const createdBy = () => uuid('created_by').references(() => user.id, { onDelete: 'set null' })

/**
 * What explains a statement line: the payment it settled, the expense it paid,
 * or the other leg of a transfer between two of the agency's own accounts.
 *
 * Many-to-many with an amount, not one-to-one. One deposit covering three
 * invoices is ordinary -- `payment_allocations` exists for exactly that reason
 * on the other side -- and one payment can arrive as two transfers. Retrofitting
 * the split after the rows exist is the migration finance already called
 * painful; the same argument holds here, so take the same answer.
 *
 * `currency` is not redundant: it is part of the foreign key to both sides, so
 * a line can only ever be matched to a payment or expense in the same currency.
 * A foreign payment landing in a domestic account needs FX realisation, which is
 * ledger work -- the escape is to ignore the line with a reason, or to keep an
 * account in that currency.
 */
export const bankTransactionMatches = pgTable(
  'bank_transaction_matches',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    bankTransactionId: uuid('bank_transaction_id').notNull(),
    currency: text('currency').notNull(),
    kind: text('kind').notNull(),
    paymentId: uuid('payment_id'),
    expenseId: uuid('expense_id'),
    /** The other leg, when this line is one half of an internal transfer. */
    counterpartTransactionId: uuid('counterpart_transaction_id'),
    /** Same sign as the line it explains. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    createdBy: createdBy(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('bank_transaction_matches_organization_id_id_key').on(t.organizationId, t.id),
    // One row per line and target: matching the same thing twice is an edit, not a second row.
    unique('bank_transaction_matches_payment_key').on(t.organizationId, t.bankTransactionId, t.paymentId),
    unique('bank_transaction_matches_expense_key').on(t.organizationId, t.bankTransactionId, t.expenseId),
    unique('bank_transaction_matches_transfer_key').on(t.organizationId, t.bankTransactionId, t.counterpartTransactionId),
    index('bank_transaction_matches_organization_payment_idx').on(t.organizationId, t.paymentId),
    index('bank_transaction_matches_organization_expense_idx').on(t.organizationId, t.expenseId),
    foreignKey({
      name: 'bank_transaction_matches_transaction_fk',
      columns: [t.organizationId, t.bankTransactionId, t.currency],
      foreignColumns: [bankTransactions.organizationId, bankTransactions.id, bankTransactions.currency],
    }).onDelete('cascade'),
    foreignKey({
      name: 'bank_transaction_matches_payment_fk',
      columns: [t.organizationId, t.paymentId, t.currency],
      foreignColumns: [payments.organizationId, payments.id, payments.currency],
    }).onDelete('cascade'),
    foreignKey({
      name: 'bank_transaction_matches_expense_fk',
      columns: [t.organizationId, t.expenseId, t.currency],
      foreignColumns: [expenses.organizationId, expenses.id, expenses.currency],
    }).onDelete('cascade'),
    foreignKey({
      name: 'bank_transaction_matches_counterpart_fk',
      columns: [t.organizationId, t.counterpartTransactionId, t.currency],
      foreignColumns: [bankTransactions.organizationId, bankTransactions.id, bankTransactions.currency],
    }).onDelete('cascade'),
    check('bank_transaction_matches_kind_check', sql`${t.kind} in ${oneOf(BANK_MATCH_KINDS)}`),
    // Exactly one target, and it is the one `kind` names.
    check(
      'bank_transaction_matches_target_check',
      sql`num_nonnulls(${t.paymentId}, ${t.expenseId}, ${t.counterpartTransactionId}) = 1
        and (${t.kind} = 'payment') = (${t.paymentId} is not null)
        and (${t.kind} = 'expense') = (${t.expenseId} is not null)
        and (${t.kind} = 'transfer') = (${t.counterpartTransactionId} is not null)`,
    ),
    check('bank_transaction_matches_amount_check', sql`${t.amountMinor} <> 0`),
    // An expense is money out. Always.
    check('bank_transaction_matches_expense_sign_check', sql`${t.kind} <> 'expense' or ${t.amountMinor} < 0`),
    check('bank_transaction_matches_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
)
