import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { expenses, payments } from './finance.ts'

/**
 * Banking: the agency's own accounts, what the bank says moved through them,
 * and the evidence tying each movement to a payment or an expense.
 *
 * Finance records what the agency billed and what it was paid. This records
 * where the money actually is, and whether the two agree. They are different
 * calendars -- an invoice is billed when it is issued, a payment when it is
 * received, cash when the bank says it moved -- and an agency that needs to pay
 * its people this month needs the second one.
 *
 * Amounts are integer minor units beside an explicit currency, as in finance.
 * One difference is deliberate and load-bearing: `bank_transactions.amount_minor`
 * is SIGNED, where `payments.amount_minor` is always positive with `kind` saying
 * which way. A statement line is one directional fact; a payment is a business
 * event with two kinds. Do not "fix" the inconsistency -- the balance arithmetic
 * and every check constraint below depend on the sign.
 *
 * This is cash management, not bookkeeping. There is no chart of accounts, no
 * double entry, and no journal. `bank_accounts` is named the way it is to leave
 * `accounts` free should a ledger ever be built; and there is deliberately no
 * `category` on a statement line, because categorisation belongs on the expense
 * that already has one, and a second one here is the beginning of an accidental
 * chart of accounts with no double entry behind it.
 */

export const BANK_ACCOUNT_KINDS = ['bank', 'credit_card', 'cash', 'paypal', 'stripe', 'other'] as const
export const BANK_TRANSACTION_STATUSES = ['unexplained', 'part_explained', 'explained', 'reconciled', 'ignored'] as const
export const BANK_MATCH_KINDS = ['payment', 'expense', 'transfer'] as const
export const STATEMENT_FORMATS = ['csv', 'ofx', 'manual'] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

const createdBy = () => uuid('created_by').references(() => user.id, { onDelete: 'set null' })

/**
 * An account money sits in: a bank account, a card, petty cash, a gateway
 * balance.
 *
 * `currency` is fixed for the life of the account. An agency with a USD account
 * has two accounts, not one account with two currencies -- which is what keeps
 * every balance below a single sum rather than an FX position.
 */
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    name: text('name').notNull(),
    kind: text('kind').notNull().default('bank'),
    currency: text('currency').notNull(),
    /** Who it is with: the bank, the card issuer, the gateway. */
    institution: text('institution'),
    /** Enough to recognise it -- `…6789`, `083-004 ****`. Never the full number. */
    accountIdentifier: text('account_identifier'),

    /**
     * The anchor every balance is measured from. Signed: a credit card opens
     * negative. Frozen once the account has transactions, because moving it
     * silently rewrites every reconciliation that ever balanced.
     */
    openingBalanceMinor: bigint('opening_balance_minor', { mode: 'number' }).notNull().default(0),
    openingBalanceOn: date('opening_balance_on', { mode: 'string' }).notNull(),
    /**
     * `opening_balance_minor` plus every transaction. Derived, and the only
     * writer is the trigger in migration 0023 -- a second trigger refuses
     * anyone setting it by hand, as `invoices.amount_paid_minor` is refused.
     */
    currentBalanceMinor: bigint('current_balance_minor', { mode: 'number' }).notNull().default(0),

    /** What a payment or expense form offers first. At most one per organization. */
    isDefault: boolean('is_default').notNull().default(false),
    /** The last statement mapping used, so the next import from this bank pre-fills. */
    importMapping: jsonb('import_mapping'),
    /**
     * When the worker last announced that this account has lines nobody has
     * explained. Arms the notice once per week rather than every sweep, the way
     * `infrastructure_assets.expiry_notice_sent_for` does.
     */
    unreconciledNoticeOn: date('unreconciled_notice_on', { mode: 'string' }),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('bank_accounts_organization_id_id_key').on(t.organizationId, t.id),
    // Carries the currency, so a transaction in another currency cannot reference it.
    unique('bank_accounts_organization_id_id_currency_key').on(t.organizationId, t.id, t.currency),
    uniqueIndex('bank_accounts_organization_name_key')
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    uniqueIndex('bank_accounts_organization_default_key')
      .on(t.organizationId)
      .where(sql`${t.isDefault} and ${t.archivedAt} is null`),
    index('bank_accounts_organization_kind_idx').on(t.organizationId, t.kind),
    check('bank_accounts_kind_check', sql`${t.kind} in ${oneOf(BANK_ACCOUNT_KINDS)}`),
    check('bank_accounts_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
)

/**
 * One statement file, and what came of it.
 *
 * The file itself is not stored. Object storage exists, but a bank statement is
 * dense personal data and the rows below *are* the record -- keeping the file
 * as well would put every transaction the agency's directors ever made into the
 * backups twice. `content_hash` is kept so the same file cannot be imported
 * twice; the bytes are not.
 */
export const bankStatementImports = pgTable(
  'bank_statement_imports',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    bankAccountId: uuid('bank_account_id').notNull(),
    filename: text('filename').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** sha256 of the bytes. The first line of defence against a double import. */
    contentHash: text('content_hash').notNull(),
    format: text('format').notNull(),
    /** The mapping used, so the import's page can show how it was read. */
    columnMapping: jsonb('column_mapping'),
    rowCount: integer('row_count').notNull(),
    importedCount: integer('imported_count').notNull(),
    duplicateCount: integer('duplicate_count').notNull(),
    earliestOn: date('earliest_on', { mode: 'string' }),
    latestOn: date('latest_on', { mode: 'string' }),
    importedBy: uuid('imported_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('bank_statement_imports_organization_id_id_key').on(t.organizationId, t.id),
    // The same file, twice, is refused outright.
    unique('bank_statement_imports_content_key').on(t.organizationId, t.bankAccountId, t.contentHash),
    index('bank_statement_imports_organization_account_idx').on(t.organizationId, t.bankAccountId, t.createdAt),
    foreignKey({
      name: 'bank_statement_imports_account_fk',
      columns: [t.organizationId, t.bankAccountId],
      foreignColumns: [bankAccounts.organizationId, bankAccounts.id],
    }).onDelete('cascade'),
    check('bank_statement_imports_format_check', sql`${t.format} in ${oneOf(STATEMENT_FORMATS)}`),
    check(
      'bank_statement_imports_counts_check',
      sql`${t.rowCount} >= 0 and ${t.importedCount} >= 0 and ${t.duplicateCount} >= 0`,
    ),
  ],
)

/**
 * A statement period, closed off and proven.
 *
 * A row exists only when a reconciliation *completes*. There is no in-progress
 * state, because in progress is simply "this account has unexplained lines",
 * which needs no row and leaves nothing to sweep up when someone wanders off.
 *
 * `computed_balance_minor` is stored rather than recomputed on read, and the
 * check below refuses a row where it disagrees with what the statement said: a
 * reconciliation that does not balance is not a reconciliation.
 */
export const bankReconciliations = pgTable(
  'bank_reconciliations',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    bankAccountId: uuid('bank_account_id').notNull(),
    currency: text('currency').notNull(),
    statementStartOn: date('statement_start_on', { mode: 'string' }).notNull(),
    statementEndOn: date('statement_end_on', { mode: 'string' }).notNull(),
    /** The previous reconciliation's closing balance, or the account's opening balance. */
    openingBalanceMinor: bigint('opening_balance_minor', { mode: 'number' }).notNull(),
    /** Typed in by a person, from the statement in front of them. */
    closingBalanceMinor: bigint('closing_balance_minor', { mode: 'number' }).notNull(),
    /** Opening plus every line in the period. */
    computedBalanceMinor: bigint('computed_balance_minor', { mode: 'number' }).notNull(),
    transactionCount: integer('transaction_count').notNull(),
    completedBy: uuid('completed_by').references(() => user.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('bank_reconciliations_organization_id_id_key').on(t.organizationId, t.id),
    unique('bank_reconciliations_period_key').on(t.organizationId, t.bankAccountId, t.statementEndOn),
    index('bank_reconciliations_organization_account_idx').on(t.organizationId, t.bankAccountId, t.statementEndOn),
    foreignKey({
      name: 'bank_reconciliations_account_fk',
      columns: [t.organizationId, t.bankAccountId, t.currency],
      foreignColumns: [bankAccounts.organizationId, bankAccounts.id, bankAccounts.currency],
    }),
    check('bank_reconciliations_period_check', sql`${t.statementEndOn} >= ${t.statementStartOn}`),
    check('bank_reconciliations_balanced_check', sql`${t.closingBalanceMinor} = ${t.computedBalanceMinor}`),
  ],
)

/**
 * One line on a bank statement.
 *
 * `amount_minor` is signed -- positive is money in, negative is money out --
 * and `description` holds the narration exactly as the bank wrote it, never
 * rewritten, because it is the only thing that ties a row back to the paper.
 *
 * `fingerprint` is what stops the same line being imported twice, and the
 * unique key on it is the single most important constraint in this module. Its
 * format is a forever-contract: it is version-prefixed, and changing how it is
 * computed orphans every stored value, so the next import of an already
 * imported file silently doubles it.
 */
export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    bankAccountId: uuid('bank_account_id').notNull(),
    /** Equal to the account's currency, by foreign key. */
    currency: text('currency').notNull(),

    /** Signed. Positive in, negative out. The sign is the direction. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    /**
     * How much of it is explained by matches, same sign. Derived, written only
     * by the trigger in migration 0023.
     */
    matchedMinor: bigint('matched_minor', { mode: 'number' }).notNull().default(0),

    /** The day the bank posted it, which is the day it counts. */
    bookedOn: date('booked_on', { mode: 'string' }).notNull(),
    /** OFX offers both; usually null. */
    valueOn: date('value_on', { mode: 'string' }),

    /** The raw narration. Never rewritten. */
    description: text('description').notNull(),
    counterparty: text('counterparty'),
    reference: text('reference'),
    /** The running balance the file itself reported. A cross-check, not a derivation. */
    balanceAfterMinor: bigint('balance_after_minor', { mode: 'number' }),

    status: text('status').notNull().default('unexplained'),
    ignoredReason: text('ignored_reason'),
    ignoredAt: timestamp('ignored_at', { withTimezone: true }),

    reconciliationId: uuid('reconciliation_id'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    importId: uuid('import_id'),

    /** `v1:fitid:…` from OFX, `v1:h:…` hashed from a CSV row, `manual:…` when typed in. */
    fingerprint: text('fingerprint').notNull(),

    notes: text('notes'),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('bank_transactions_organization_id_id_key').on(t.organizationId, t.id),
    // Carries the currency, so a match to a payment in another currency cannot be written.
    unique('bank_transactions_organization_id_id_currency_key').on(t.organizationId, t.id, t.currency),
    // The idempotency key. Without it, a re-imported statement doubles the books.
    unique('bank_transactions_fingerprint_key').on(t.organizationId, t.bankAccountId, t.fingerprint),
    index('bank_transactions_organization_account_booked_idx').on(t.organizationId, t.bankAccountId, t.bookedOn),
    // The reconciliation desk's query: what still needs a person.
    index('bank_transactions_organization_unexplained_idx')
      .on(t.organizationId, t.bankAccountId, t.bookedOn)
      .where(sql`${t.status} in ('unexplained', 'part_explained')`),
    index('bank_transactions_organization_import_idx').on(t.organizationId, t.importId),
    index('bank_transactions_organization_reconciliation_idx').on(t.organizationId, t.reconciliationId),
    foreignKey({
      name: 'bank_transactions_account_fk',
      columns: [t.organizationId, t.bankAccountId, t.currency],
      foreignColumns: [bankAccounts.organizationId, bankAccounts.id, bankAccounts.currency],
    }),
    foreignKey({
      name: 'bank_transactions_import_fk',
      columns: [t.organizationId, t.importId],
      foreignColumns: [bankStatementImports.organizationId, bankStatementImports.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'bank_transactions_reconciliation_fk',
      columns: [t.organizationId, t.reconciliationId],
      foreignColumns: [bankReconciliations.organizationId, bankReconciliations.id],
    }).onDelete('set null'),
    check('bank_transactions_status_check', sql`${t.status} in ${oneOf(BANK_TRANSACTION_STATUSES)}`),
    check('bank_transactions_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    // A zero-amount statement line is not a movement of money.
    check('bank_transactions_amount_check', sql`${t.amountMinor} <> 0`),
    // Matched money never exceeds the line, and never runs the other way.
    check(
      'bank_transactions_matched_check',
      sql`sign(${t.matchedMinor}) in (0, sign(${t.amountMinor})) and abs(${t.matchedMinor}) <= abs(${t.amountMinor})`,
    ),
    check('bank_transactions_ignored_check', sql`(${t.status} = 'ignored') = (${t.ignoredAt} is not null)`),
    check('bank_transactions_reconciled_check', sql`(${t.reconciliationId} is null) = (${t.reconciledAt} is null)`),
  ],
)

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
