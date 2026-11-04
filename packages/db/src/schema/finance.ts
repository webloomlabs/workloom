import { sql } from 'drizzle-orm'
import {
  bigint,
  jsonb,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { companies, contacts, deals } from './crm.ts'
import { bankAccounts } from './banking.ts'
import { projects } from './projects.ts'

/**
 * Finance: tax rates, the service catalogue, document numbering, quotes,
 * invoices, the payments that settle them, and what the agency spent.
 *
 * Amounts are integer minor units beside an explicit currency. Quantities,
 * percentages, and exchange rates are `numeric`, returned as strings and parsed
 * exactly -- never through a float.
 *
 * Totals are stored, not computed on read, so a tax rate edited next year
 * cannot change what a quote already said. Each line keeps a snapshot of its
 * tax's name and rate for the same reason. Once a quote leaves draft, a trigger
 * (migration 0012) refuses any change to its content or its lines.
 */

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const
/**
 * The whole invoice lifecycle. S7b issues, views, and cancels; S7c settles.
 * Which of these an issued invoice is in follows from what is stored -- see
 * `settlementStatus` in core, which is the only thing that decides.
 */
export const INVOICE_STATUSES = ['draft', 'sent', 'viewed', 'partially_paid', 'paid', 'overdue', 'cancelled', 'refunded'] as const
export const TAX_MODES = ['exclusive', 'inclusive'] as const
export const SERVICE_PRICING_MODELS = ['fixed', 'hourly', 'per_unit'] as const
export const SERVICE_BILLING_TYPES = ['one_off', 'recurring'] as const
/**
 * What the per-organization numbering sequences hand out numbers for. Tickets
 * share the mechanism because they need the same thing: a per-tenant counter
 * that does not skip and does not collide.
 */
export const DOCUMENT_KINDS = ['quote', 'invoice', 'ticket', 'expense'] as const
/**
 * When a sequence starts again from 1. A resetting format must say which year
 * it is in, or the numbers it hands out would collide.
 */
export const SEQUENCE_RESETS = ['never', 'yearly', 'fiscal_yearly'] as const
/** What an invoice line is: something billed, or an earlier invoice taken off it. */
export const INVOICE_LINE_KINDS = ['item', 'deduction'] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

const createdBy = () => uuid('created_by').references(() => user.id, { onDelete: 'set null' })

/**
 * The next number for each kind of document, per organization.
 *
 * A row locked `FOR UPDATE` in the same transaction that issues the document,
 * not a Postgres sequence: sequences are not per-tenant and skip values on
 * rollback, and some jurisdictions require invoice numbers without gaps.
 */
export const documentSequences = pgTable(
  'document_sequences',
  {
    ...tenantColumn,
    kind: text('kind').notNull(),
    /**
     * Which run of numbers this row counts: '' for the settings row and for a
     * sequence that never resets, '2026' or 'FY2025' for one that does. The
     * settings row holds the format; the scoped rows only count.
     */
    scope: text('scope').notNull().default(''),
    prefix: text('prefix').notNull(),
    /** Digits the number is zero-padded to: 4 makes "Q-0001". */
    padding: integer('padding').notNull().default(4),
    /**
     * The whole number as a template, overriding prefix and padding:
     * "WL-{YYYY}-{NNNN}". Tokens: {YYYY} {YY} for the issue year, {FY} for the
     * financial year ("2025-26"), and a run of N for the zero-padded counter.
     */
    format: text('format'),
    reset: text('reset').notNull().default('never'),
    nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'document_sequences_pkey', columns: [t.organizationId, t.kind, t.scope] }),
    check('document_sequences_kind_check', sql`${t.kind} in ${oneOf(DOCUMENT_KINDS)}`),
    check('document_sequences_next_value_check', sql`${t.nextValue} >= 1`),
    check('document_sequences_padding_check', sql`${t.padding} between 1 and 12`),
    check('document_sequences_reset_check', sql`${t.reset} in ${oneOf(SEQUENCE_RESETS)}`),
    check('document_sequences_format_check', sql`${t.format} is null or (length(${t.format}) <= 60 and ${t.format} ~ '\\{N+\\}')`),
    /** A sequence that starts again each year must print the year, or it repeats numbers. */
    check('document_sequences_reset_year_check', sql`${t.reset} = 'never' or ${t.format} ~ '\\{(YYYY|YY|FY)\\}'`),
  ],
)

/**
 * A tax, such as GST at 10%. Archived rather than deleted, and its rate cannot
 * change once a document uses it: a change in the law is a new tax rate.
 */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    name: text('name').notNull(),
    /** A percentage, up to four decimal places: "8.875". */
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
    description: text('description'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('tax_rates_organization_id_id_key').on(t.organizationId, t.id),
    uniqueIndex('tax_rates_organization_name_key').on(t.organizationId, sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`),
    check('tax_rates_rate_check', sql`${t.rate} between 0 and 100`),
  ],
)

/** What the agency sells, so a quote line starts from a known price instead of free text. */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    name: text('name').notNull(),
    description: text('description'),
    pricingModel: text('pricing_model').notNull().default('fixed'),
    billingType: text('billing_type').notNull().default('one_off'),
    /** What one of the quantity is: "hour", "page", "month". */
    unit: text('unit'),
    currency: text('currency').notNull(),
    /** Minor units of `currency` per unit. Null when there is no standard price. */
    defaultPriceMinor: bigint('default_price_minor', { mode: 'number' }),
    defaultTaxRateId: uuid('default_tax_rate_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('services_organization_id_id_key').on(t.organizationId, t.id),
    uniqueIndex('services_organization_name_key').on(t.organizationId, sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`),
    foreignKey({
      name: 'services_default_tax_rate_fk',
      columns: [t.organizationId, t.defaultTaxRateId],
      foreignColumns: [taxRates.organizationId, taxRates.id],
    }),
    check('services_pricing_model_check', sql`${t.pricingModel} in ${oneOf(SERVICE_PRICING_MODELS)}`),
    check('services_billing_type_check', sql`${t.billingType} in ${oneOf(SERVICE_BILLING_TYPES)}`),
    check('services_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('services_price_check', sql`${t.defaultPriceMinor} >= 0`),
  ],
)

/**
 * Quotes offered as alternatives -- "Essentials", "Standard", "Premium" -- of
 * which the client takes one. Accepting one declines the others still open,
 * and the group is decided; a partial unique index on `quotes` makes a second
 * accepted option impossible.
 */
export const quoteOptionGroups = pgTable(
  'quote_option_groups',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    companyId: uuid('company_id').notNull(),
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    /** The option the client took. */
    decidedQuoteId: uuid('decided_quote_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('quote_option_groups_organization_id_id_key').on(t.organizationId, t.id),
    index('quote_option_groups_organization_company_idx').on(t.organizationId, t.companyId),
    foreignKey({ name: 'quote_option_groups_company_fk', columns: [t.organizationId, t.companyId], foreignColumns: [companies.organizationId, companies.id] }),
    foreignKey({ name: 'quote_option_groups_project_fk', columns: [t.organizationId, t.projectId], foreignColumns: [projects.organizationId, projects.id] }),
    check('quote_option_groups_decided_check', sql`(${t.decidedQuoteId} is null) = (${t.decidedAt} is null)`),
  ],
)

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** Assigned when the quote is sent. Drafts have none, so abandoned drafts leave no gaps. */
    number: text('number'),
    companyId: uuid('company_id').notNull(),
    contactId: uuid('contact_id'),
    dealId: uuid('deal_id'),
    /**
     * The project it prices. May be given once after the quote is sent -- a
     * quote accepted before its project existed -- and never changed after.
     */
    projectId: uuid('project_id'),
    /** The group of alternatives it is one of, and what it is called there: "Option B — Standard". */
    optionGroupId: uuid('option_group_id'),
    optionLabel: text('option_label'),
    title: text('title').notNull(),
    status: text('status').notNull().default('draft'),
    currency: text('currency').notNull(),
    taxMode: text('tax_mode').notNull().default('exclusive'),
    /** Set when sent, in the organization's time zone. */
    issueDate: date('issue_date', { mode: 'string' }),
    validUntil: date('valid_until', { mode: 'string' }).notNull(),

    /** A document discount: a percentage or a fixed amount, never both. */
    discountPercent: numeric('discount_percent', { precision: 7, scale: 4 }),
    discountAmountMinor: bigint('discount_amount_minor', { mode: 'number' }),

    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),

    /**
     * Captured when sent, and never changed: the organization's base currency
     * then, the rate from `currency` to it, and the total converted. Without
     * these a dashboard cannot add up quotes in different currencies, and the
     * historical rate would be unrecoverable.
     */
    baseCurrency: text('base_currency'),
    exchangeRateToBase: numeric('exchange_rate_to_base', { precision: 18, scale: 8 }),
    totalBaseMinor: bigint('total_base_minor', { mode: 'number' }),

    notes: text('notes'),
    terms: text('terms'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    declineReason: text('decline_reason'),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('quotes_organization_id_id_key').on(t.organizationId, t.id),
    uniqueIndex('quotes_organization_number_key').on(t.organizationId, t.number),
    index('quotes_organization_status_idx').on(t.organizationId, t.status),
    index('quotes_organization_company_idx').on(t.organizationId, t.companyId),
    index('quotes_organization_deal_idx').on(t.organizationId, t.dealId),
    foreignKey({ name: 'quotes_company_fk', columns: [t.organizationId, t.companyId], foreignColumns: [companies.organizationId, companies.id] }),
    foreignKey({ name: 'quotes_contact_fk', columns: [t.organizationId, t.contactId], foreignColumns: [contacts.organizationId, contacts.id] }),
    foreignKey({ name: 'quotes_deal_fk', columns: [t.organizationId, t.dealId], foreignColumns: [deals.organizationId, deals.id] }),
    foreignKey({ name: 'quotes_project_fk', columns: [t.organizationId, t.projectId], foreignColumns: [projects.organizationId, projects.id] }),
    foreignKey({ name: 'quotes_option_group_fk', columns: [t.organizationId, t.optionGroupId], foreignColumns: [quoteOptionGroups.organizationId, quoteOptionGroups.id] }),
    index('quotes_organization_project_idx').on(t.organizationId, t.projectId),
    /** Of a group of alternatives, the client takes one. */
    uniqueIndex('quotes_one_accepted_option_key').on(t.organizationId, t.optionGroupId).where(sql`${t.status} = 'accepted' and ${t.optionGroupId} is not null`),
    check('quotes_status_check', sql`${t.status} in ${oneOf(QUOTE_STATUSES)}`),
    check('quotes_tax_mode_check', sql`${t.taxMode} in ${oneOf(TAX_MODES)}`),
    check('quotes_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$' and (${t.baseCurrency} is null or ${t.baseCurrency} ~ '^[A-Z]{3}$')`),
    check('quotes_one_discount_check', sql`${t.discountPercent} is null or ${t.discountAmountMinor} is null`),
    check('quotes_discount_check', sql`${t.discountPercent} between 0 and 100 and ${t.discountAmountMinor} >= 0`),
    check('quotes_number_check', sql`(${t.status} = 'draft') = (${t.number} is null)`),
    check(
      'quotes_issued_check',
      sql`(${t.status} = 'draft') = (${t.sentAt} is null and ${t.issueDate} is null and ${t.exchangeRateToBase} is null and ${t.baseCurrency} is null and ${t.totalBaseMinor} is null)`,
    ),
    check('quotes_exchange_rate_check', sql`${t.exchangeRateToBase} > 0`),
    check('quotes_accepted_check', sql`(${t.status} = 'accepted') = (${t.acceptedAt} is not null)`),
    check('quotes_declined_check', sql`(${t.status} = 'declined') = (${t.declinedAt} is not null)`),
    check('quotes_expired_check', sql`(${t.status} = 'expired') = (${t.expiredAt} is not null)`),
    check('quotes_valid_until_check', sql`${t.issueDate} is null or ${t.validUntil} >= ${t.issueDate}`),
  ],
)

export const quoteLines = pgTable(
  'quote_lines',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    quoteId: uuid('quote_id').notNull(),
    position: integer('position').notNull(),
    serviceId: uuid('service_id'),
    /** The line's title, printed in bold. */
    description: text('description').notNull(),
    /** A second, quieter line under the title: "Initially quoted project fee". */
    detail: text('detail'),
    /** One-off or recurring, as printed in the Billing column. Copied from the service. */
    billingType: text('billing_type'),
    /**
     * For a recurring line, how often it recurs: every 1 month, every 3
     * months. Accepting the quote sets up a billing schedule from it.
     */
    intervalUnit: text('interval_unit'),
    intervalCount: integer('interval_count'),
    quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
    /** Minor units of the quote's currency; negative for a credit. */
    unitAmountMinor: bigint('unit_amount_minor', { mode: 'number' }).notNull(),
    discountPercent: numeric('discount_percent', { precision: 7, scale: 4 }),
    taxRateId: uuid('tax_rate_id'),
    /** The tax as it was when applied to this line. */
    taxName: text('tax_name'),
    taxRatePctSnapshot: numeric('tax_rate_pct_snapshot', { precision: 7, scale: 4 }),

    // Computed by the calculator and stored with the quote's totals.
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    lineDiscountMinor: bigint('line_discount_minor', { mode: 'number' }).notNull(),
    netMinor: bigint('net_minor', { mode: 'number' }).notNull(),
    documentDiscountMinor: bigint('document_discount_minor', { mode: 'number' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('quote_lines_organization_id_id_key').on(t.organizationId, t.id),
    index('quote_lines_organization_quote_position_idx').on(t.organizationId, t.quoteId, t.position),
    index('quote_lines_organization_tax_rate_idx').on(t.organizationId, t.taxRateId),
    foreignKey({ name: 'quote_lines_quote_fk', columns: [t.organizationId, t.quoteId], foreignColumns: [quotes.organizationId, quotes.id] }).onDelete('cascade'),
    foreignKey({ name: 'quote_lines_service_fk', columns: [t.organizationId, t.serviceId], foreignColumns: [services.organizationId, services.id] }),
    foreignKey({ name: 'quote_lines_tax_rate_fk', columns: [t.organizationId, t.taxRateId], foreignColumns: [taxRates.organizationId, taxRates.id] }),
    check('quote_lines_quantity_check', sql`${t.quantity} <> 0`),
    check('quote_lines_billing_type_check', sql`${t.billingType} in ${oneOf(SERVICE_BILLING_TYPES)}`),
    check('quote_lines_interval_check', sql`(${t.intervalUnit} is null) = (${t.intervalCount} is null) and (${t.intervalUnit} is null or (${t.billingType} = 'recurring' and ${t.intervalUnit} in ('week', 'month', 'quarter', 'year') and ${t.intervalCount} between 1 and 52))`),
    check('quote_lines_discount_check', sql`${t.discountPercent} between 0 and 100`),
    check('quote_lines_tax_snapshot_check', sql`(${t.taxRateId} is null) = (${t.taxName} is null) and (${t.taxName} is null) = (${t.taxRatePctSnapshot} is null)`),
    check('quote_lines_totals_check', sql`${t.netMinor} = ${t.amountMinor} - ${t.lineDiscountMinor}`),
  ],
)

/**
 * Invoices.
 *
 * The same shape as a quote, priced by the same calculator, with the dates and
 * states a demand for payment needs: an issue date, a due date from the payment
 * terms, when the client opened it, and what has been paid so far (S7c).
 *
 * Numbers are assigned when the invoice is issued, and nothing about an issued
 * invoice may change afterwards -- enforced by the guard trigger in migration
 * 0014 as well as by the service.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** Assigned when issued. Drafts have none, so abandoned drafts leave no gaps. */
    number: text('number'),
    companyId: uuid('company_id').notNull(),
    contactId: uuid('contact_id'),
    dealId: uuid('deal_id'),
    projectId: uuid('project_id'),
    /** The quote this was raised from, if any. One quote may bill in several invoices. */
    quoteId: uuid('quote_id'),
    title: text('title').notNull(),
    status: text('status').notNull().default('draft'),
    currency: text('currency').notNull(),
    taxMode: text('tax_mode').notNull().default('exclusive'),
    issueDate: date('issue_date', { mode: 'string' }),
    /**
     * Issue date plus the payment terms, fixed when the invoice is issued --
     * unless it is due on an event rather than a date ("At launch"), when it
     * stays empty until the event has a date. Only then may it be set later.
     */
    dueDate: date('due_date', { mode: 'string' }),
    /** When the invoice is due, in words, for an event without a date yet: "At launch". */
    dueLabel: text('due_label'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(14),

    discountPercent: numeric('discount_percent', { precision: 7, scale: 4 }),
    discountAmountMinor: bigint('discount_amount_minor', { mode: 'number' }),

    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    /** Maintained by payment allocations from S7c. Amount due is total minus this. */
    amountPaidMinor: bigint('amount_paid_minor', { mode: 'number' }).notNull().default(0),

    baseCurrency: text('base_currency'),
    exchangeRateToBase: numeric('exchange_rate_to_base', { precision: 18, scale: 8 }),
    totalBaseMinor: bigint('total_base_minor', { mode: 'number' }),

    notes: text('notes'),
    terms: text('terms'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** Where the invoice was emailed, and when it last went out. */
    emailTo: text('email_to'),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    /** When the client first opened its link. */
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('invoices_organization_id_id_key').on(t.organizationId, t.id),
    // Carries the currency, so an allocation in another currency cannot reference it.
    unique('invoices_organization_id_id_currency_key').on(t.organizationId, t.id, t.currency),
    uniqueIndex('invoices_organization_number_key').on(t.organizationId, t.number),
    index('invoices_organization_status_idx').on(t.organizationId, t.status),
    index('invoices_organization_company_idx').on(t.organizationId, t.companyId),
    index('invoices_organization_due_date_idx').on(t.organizationId, t.dueDate),
    index('invoices_organization_quote_idx').on(t.organizationId, t.quoteId),
    foreignKey({ name: 'invoices_company_fk', columns: [t.organizationId, t.companyId], foreignColumns: [companies.organizationId, companies.id] }),
    foreignKey({ name: 'invoices_contact_fk', columns: [t.organizationId, t.contactId], foreignColumns: [contacts.organizationId, contacts.id] }),
    foreignKey({ name: 'invoices_deal_fk', columns: [t.organizationId, t.dealId], foreignColumns: [deals.organizationId, deals.id] }),
    foreignKey({ name: 'invoices_project_fk', columns: [t.organizationId, t.projectId], foreignColumns: [projects.organizationId, projects.id] }),
    foreignKey({ name: 'invoices_quote_fk', columns: [t.organizationId, t.quoteId], foreignColumns: [quotes.organizationId, quotes.id] }),
    check('invoices_status_check', sql`${t.status} in ${oneOf(INVOICE_STATUSES)}`),
    check('invoices_tax_mode_check', sql`${t.taxMode} in ${oneOf(TAX_MODES)}`),
    check('invoices_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$' and (${t.baseCurrency} is null or ${t.baseCurrency} ~ '^[A-Z]{3}$')`),
    check('invoices_one_discount_check', sql`${t.discountPercent} is null or ${t.discountAmountMinor} is null`),
    check('invoices_discount_check', sql`${t.discountPercent} between 0 and 100 and ${t.discountAmountMinor} >= 0`),
    check('invoices_number_check', sql`(${t.status} = 'draft') = (${t.number} is null)`),
    check(
      'invoices_issued_check',
      sql`(${t.status} = 'draft') = (${t.sentAt} is null and ${t.issueDate} is null and ${t.exchangeRateToBase} is null and ${t.baseCurrency} is null and ${t.totalBaseMinor} is null)`,
    ),
    /** A draft has no due date; an issued invoice has one, or says in words when it is due. */
    check('invoices_due_check', sql`case when ${t.status} = 'draft' then ${t.dueDate} is null else ${t.dueDate} is not null or ${t.dueLabel} is not null end`),
    check('invoices_due_label_check', sql`length(${t.dueLabel}) between 1 and 80`),
    check('invoices_exchange_rate_check', sql`${t.exchangeRateToBase} > 0`),
    check('invoices_due_date_check', sql`${t.dueDate} is null or ${t.dueDate} >= ${t.issueDate}`),
    check('invoices_payment_terms_check', sql`${t.paymentTermsDays} between 0 and 365`),
    check('invoices_cancelled_check', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
    /** Having been paid is a fact about the past: refunding or cancelling does not unmake it. */
    check('invoices_paid_check', sql`${t.amountPaidMinor} >= 0 and (${t.paidAt} is null or ${t.status} in ('paid', 'refunded', 'cancelled'))`),
    check('invoices_viewed_check', sql`${t.viewedAt} is null or ${t.status} <> 'draft'`),
  ],
)

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    invoiceId: uuid('invoice_id').notNull(),
    position: integer('position').notNull(),
    /** Something billed, or an earlier invoice of the same client taken off this one. */
    kind: text('kind').notNull().default('item'),
    serviceId: uuid('service_id'),
    /** The line's title, printed in bold. */
    description: text('description').notNull(),
    /** A second, quieter line under the title: "Additional scope", "Deposit -- WL-2026-0130". */
    detail: text('detail'),
    /** One-off or recurring, as printed in the Billing column. */
    billingType: text('billing_type'),
    /** The service period this line pays for, when it pays for one: a month, or three months prepaid. */
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
    unitAmountMinor: bigint('unit_amount_minor', { mode: 'number' }).notNull(),
    discountPercent: numeric('discount_percent', { precision: 7, scale: 4 }),
    taxRateId: uuid('tax_rate_id'),
    taxName: text('tax_name'),
    taxRatePctSnapshot: numeric('tax_rate_pct_snapshot', { precision: 7, scale: 4 }),
    /**
     * For a deduction: the earlier invoice it takes off -- a deposit, a
     * progress payment. The final invoice then states the whole project and
     * demands only what is left, so nothing is billed twice.
     */
    deductsInvoiceId: uuid('deducts_invoice_id'),
    /**
     * Whether the deducted invoice had been paid in full when this one was
     * issued, which decides whether it prints as "Already paid" or
     * "Previously invoiced". Fixed at issue, like everything else on it.
     */
    deductionSettled: boolean('deduction_settled'),

    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    lineDiscountMinor: bigint('line_discount_minor', { mode: 'number' }).notNull(),
    netMinor: bigint('net_minor', { mode: 'number' }).notNull(),
    documentDiscountMinor: bigint('document_discount_minor', { mode: 'number' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('invoice_lines_organization_id_id_key').on(t.organizationId, t.id),
    index('invoice_lines_organization_invoice_position_idx').on(t.organizationId, t.invoiceId, t.position),
    index('invoice_lines_organization_tax_rate_idx').on(t.organizationId, t.taxRateId),
    index('invoice_lines_organization_deducts_idx').on(t.organizationId, t.deductsInvoiceId),
    foreignKey({ name: 'invoice_lines_invoice_fk', columns: [t.organizationId, t.invoiceId], foreignColumns: [invoices.organizationId, invoices.id] }).onDelete('cascade'),
    foreignKey({ name: 'invoice_lines_service_fk', columns: [t.organizationId, t.serviceId], foreignColumns: [services.organizationId, services.id] }),
    foreignKey({ name: 'invoice_lines_tax_rate_fk', columns: [t.organizationId, t.taxRateId], foreignColumns: [taxRates.organizationId, taxRates.id] }),
    foreignKey({ name: 'invoice_lines_deducts_fk', columns: [t.organizationId, t.deductsInvoiceId], foreignColumns: [invoices.organizationId, invoices.id] }),
    check('invoice_lines_quantity_check', sql`${t.quantity} <> 0`),
    check('invoice_lines_kind_check', sql`${t.kind} in ${oneOf(INVOICE_LINE_KINDS)}`),
    check('invoice_lines_billing_type_check', sql`${t.billingType} in ${oneOf(SERVICE_BILLING_TYPES)}`),
    check('invoice_lines_period_check', sql`(${t.periodStart} is null) = (${t.periodEnd} is null) and (${t.periodEnd} is null or ${t.periodEnd} >= ${t.periodStart})`),
    check(
      'invoice_lines_deduction_check',
      sql`(${t.kind} = 'deduction') = (${t.deductsInvoiceId} is not null) and (${t.kind} = 'item' or (${t.unitAmountMinor} < 0 and ${t.quantity} = 1 and ${t.discountPercent} is null and ${t.serviceId} is null))`,
    ),
    check('invoice_lines_deduction_settled_check', sql`${t.deductionSettled} is null or ${t.kind} = 'deduction'`),
    check('invoice_lines_discount_check', sql`${t.discountPercent} between 0 and 100`),
    check('invoice_lines_tax_snapshot_check', sql`(${t.taxRateId} is null) = (${t.taxName} is null) and (${t.taxName} is null) = (${t.taxRatePctSnapshot} is null)`),
    check('invoice_lines_totals_check', sql`${t.netMinor} = ${t.amountMinor} - ${t.lineDiscountMinor}`),
  ],
)

/**
 * Money received, and money given back.
 *
 * A payment is recorded against a client, then allocated across the invoices it
 * settles -- a header and its allocations from the start, because a client who
 * pays three invoices with one transfer is ordinary, and retrofitting the split
 * after payments exist is a painful migration.
 *
 * A refund is a payment with `kind = 'refund'`: its allocations subtract from
 * what the invoice has been paid, which is what lets a wrongly paid invoice be
 * cancelled.
 */
export const PAYMENT_KINDS = ['payment', 'refund'] as const
export const PAYMENT_METHODS = ['bank_transfer', 'card', 'direct_debit', 'cash', 'cheque', 'paypal', 'stripe', 'other'] as const

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    companyId: uuid('company_id').notNull(),
    kind: text('kind').notNull().default('payment'),
    /** The day the money moved, in the organization's time zone. */
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    method: text('method').notNull().default('bank_transfer'),
    /** The bank reference, receipt number, or gateway id. */
    reference: text('reference'),
    currency: text('currency').notNull(),
    /** Always positive; `kind` says which way the money went. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),

    /** As on a document: what this was worth in the base currency when recorded. */
    baseCurrency: text('base_currency').notNull(),
    exchangeRateToBase: numeric('exchange_rate_to_base', { precision: 18, scale: 8 }).notNull(),
    amountBaseMinor: bigint('amount_base_minor', { mode: 'number' }).notNull(),

    /**
     * The account the money moved through.
     *
     * Recorded when the payment is, because that is when the person knows it --
     * there is no statement line to ask yet. It is an attribution, not a
     * reconciliation: it does not create a bank transaction, and the register
     * still only ever shows what the bank actually reported. When the statement
     * arrives and a line is matched, a trigger (migration 0031) refuses a match
     * against any other account, so the two can never come to disagree.
     *
     * The currency is part of the foreign key, so money cannot be recorded into
     * an account that is not in its currency.
     */
    bankAccountId: uuid('bank_account_id'),

    notes: text('notes'),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('payments_organization_id_id_key').on(t.organizationId, t.id),
    // Carries the currency, so an allocation in another currency cannot reference it.
    unique('payments_organization_id_id_currency_key').on(t.organizationId, t.id, t.currency),
    index('payments_organization_company_idx').on(t.organizationId, t.companyId),
    index('payments_organization_received_on_idx').on(t.organizationId, t.receivedOn),
    foreignKey({ name: 'payments_company_fk', columns: [t.organizationId, t.companyId], foreignColumns: [companies.organizationId, companies.id] }),
    index('payments_organization_bank_account_idx').on(t.organizationId, t.bankAccountId),
    foreignKey({
      name: 'payments_bank_account_fk',
      columns: [t.organizationId, t.bankAccountId, t.currency],
      foreignColumns: [bankAccounts.organizationId, bankAccounts.id, bankAccounts.currency],
    }),
    check('payments_kind_check', sql`${t.kind} in ${oneOf(PAYMENT_KINDS)}`),
    check('payments_method_check', sql`${t.method} in ${oneOf(PAYMENT_METHODS)}`),
    check('payments_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$' and ${t.baseCurrency} ~ '^[A-Z]{3}$'`),
    check('payments_amount_check', sql`${t.amountMinor} > 0`),
    check('payments_exchange_rate_check', sql`${t.exchangeRateToBase} > 0`),
  ],
)

/**
 * What part of a payment settles which invoice.
 *
 * `currency` is not redundant: it is part of the foreign key to both sides, so
 * a payment can only ever be allocated to an invoice in the same currency.
 * That removes FX gain and loss from the MVP structurally rather than by rule.
 *
 * `invoices.amount_paid_minor` is recomputed from these rows by a trigger
 * (migration 0016), which also refuses an over-allocation -- so
 * `amount_due = total - sum(allocations)` holds even against hand-written SQL.
 */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    paymentId: uuid('payment_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    /** Equal to both sides' currency, by foreign key. */
    currency: text('currency').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_allocations_organization_id_id_key').on(t.organizationId, t.id),
    /** One row per payment and invoice: a second allocation changes the first. */
    unique('payment_allocations_payment_invoice_key').on(t.organizationId, t.paymentId, t.invoiceId),
    index('payment_allocations_organization_invoice_idx').on(t.organizationId, t.invoiceId),
    foreignKey({
      name: 'payment_allocations_payment_fk',
      columns: [t.organizationId, t.paymentId, t.currency],
      foreignColumns: [payments.organizationId, payments.id, payments.currency],
    }).onDelete('cascade'),
    foreignKey({
      name: 'payment_allocations_invoice_fk',
      columns: [t.organizationId, t.invoiceId, t.currency],
      foreignColumns: [invoices.organizationId, invoices.id, invoices.currency],
    }).onDelete('cascade'),
    check('payment_allocations_amount_check', sql`${t.amountMinor} > 0`),
    check('payment_allocations_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
)

/**
 * What the agency spent: a supplier's invoice, a licence, a contractor, travel.
 *
 * Priced like an invoice line -- a net amount plus a snapshot of the tax that
 * applied -- because that is what a billable expense becomes when it is
 * rebilled. Profitability costs `amount_minor`, net of the tax, which is
 * reclaimed.
 *
 * A billable expense freezes once `invoice_line_id` is set, exactly as tracked
 * time does; removing the line releases it to be billed again.
 */
/**
 * How an expense counts towards the tax computation: deductible in the year,
 * not deductible at all (fines, private use), or capital -- equipment that is
 * claimed through capital allowances over several years instead.
 */
export const EXPENSE_TAX_TREATMENTS = ['deductible', 'non_deductible', 'capital'] as const
/** A draft is a guess -- read from a receipt photo, say -- until a person confirms it. */
export const EXPENSE_STATUSES = ['draft', 'confirmed'] as const
/** Where an expense was entered from. */
export const EXPENSE_SOURCES = ['web', 'api', 'telegram'] as const
/** How an expense was paid: the payment methods, and a person's own card, to be reimbursed. */
export const EXPENSE_PAYMENT_METHODS = [...PAYMENT_METHODS, 'personal_card'] as const

/** The categories every organization starts with. Archived, never deleted, so old expenses keep theirs. */
export const DEFAULT_EXPENSE_CATEGORIES: ReadonlyArray<{ key: string; name: string; taxTreatment: (typeof EXPENSE_TAX_TREATMENTS)[number] }> = [
  { key: 'software', name: 'Software and subscriptions', taxTreatment: 'deductible' },
  { key: 'hosting', name: 'Hosting', taxTreatment: 'deductible' },
  { key: 'domains', name: 'Domains', taxTreatment: 'deductible' },
  { key: 'hardware', name: 'Hardware and equipment', taxTreatment: 'capital' },
  { key: 'contractor', name: 'Contractors', taxTreatment: 'deductible' },
  { key: 'advertising', name: 'Advertising', taxTreatment: 'deductible' },
  { key: 'travel', name: 'Travel', taxTreatment: 'deductible' },
  { key: 'office', name: 'Office', taxTreatment: 'deductible' },
  { key: 'fees', name: 'Bank and professional fees', taxTreatment: 'deductible' },
  { key: 'other', name: 'Other', taxTreatment: 'deductible' },
]

/**
 * The agency's own expense categories, keyed by a short stable slug that
 * expenses reference. Each says how the tax pack treats what is in it.
 */
export const expenseCategories = pgTable(
  'expense_categories',
  {
    ...tenantColumn,
    key: text('key').notNull(),
    name: text('name').notNull(),
    taxTreatment: text('tax_treatment').notNull().default('deductible'),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'expense_categories_pkey', columns: [t.organizationId, t.key] }),
    check('expense_categories_key_check', sql`${t.key} ~ '^[a-z0-9_]{1,40}$'`),
    check('expense_categories_tax_treatment_check', sql`${t.taxTreatment} in ${oneOf(EXPENSE_TAX_TREATMENTS)}`),
  ],
)

/** The category keys expenses had before categories were the agency's own. */
export const EXPENSE_CATEGORIES = [
  'software',
  'hosting',
  'domains',
  'hardware',
  'contractor',
  'advertising',
  'travel',
  'office',
  'fees',
  'other',
] as const

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** The project it belongs to, when it is one project's cost. */
    projectId: uuid('project_id'),
    /** The client it is for. Implied by the project; null for the agency's own overhead. */
    companyId: uuid('company_id'),
    description: text('description').notNull(),
    supplier: text('supplier'),
    category: text('category').notNull().default('other'),
    /** Draft until a person confirms it; only confirmed expenses count anywhere. */
    status: text('status').notNull().default('confirmed'),
    /** "EXP-0042", given when it is confirmed. Older expenses confirmed before numbering have none. */
    number: text('number'),
    /** How it was paid, and when, if not on the day it was incurred. */
    paymentMethod: text('payment_method'),
    paidOn: date('paid_on', { mode: 'string' }),
    /** Paid by a person out of their own pocket, to be paid back. */
    reimbursable: boolean('reimbursable').notNull().default(false),
    source: text('source').notNull().default('web'),
    /** What was read from the receipt and by what, kept as evidence beside what a person confirmed. */
    extraction: jsonb('extraction'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => user.id, { onDelete: 'set null' }),
    /** The day it was incurred, in the organization's time zone. */
    incurredOn: date('incurred_on', { mode: 'string' }).notNull(),

    currency: text('currency').notNull(),
    /** Net of tax: what the expense actually costs the agency. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    taxRateId: uuid('tax_rate_id'),
    taxName: text('tax_name'),
    taxRatePctSnapshot: numeric('tax_rate_pct_snapshot', { precision: 7, scale: 4 }),
    /** Tax on top of `amount_minor`, computed when the expense is written. */
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),

    baseCurrency: text('base_currency').notNull(),
    exchangeRateToBase: numeric('exchange_rate_to_base', { precision: 18, scale: 8 }).notNull(),
    amountBaseMinor: bigint('amount_base_minor', { mode: 'number' }).notNull(),

    /** Rebillable to the client. */
    billable: boolean('billable').notNull().default(false),
    /** What to add when rebilling: 15 means cost plus 15%. */
    markupPercent: numeric('markup_percent', { precision: 7, scale: 4 }),
    /** The invoice line that rebilled it. Set, the expense can no longer change. */
    invoiceLineId: uuid('invoice_line_id'),

    /**
     * The account it was paid from. As on a payment: an attribution recorded
     * when the expense is, not a reconciliation. See the comment there.
     */
    bankAccountId: uuid('bank_account_id'),

    notes: text('notes'),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('expenses_organization_id_id_key').on(t.organizationId, t.id),
    // Carries the currency, so a bank match in another currency cannot reference it.
    unique('expenses_organization_id_id_currency_key').on(t.organizationId, t.id, t.currency),
    index('expenses_organization_incurred_on_idx').on(t.organizationId, t.incurredOn),
    index('expenses_organization_project_idx').on(t.organizationId, t.projectId),
    index('expenses_organization_company_idx').on(t.organizationId, t.companyId),
    index('expenses_organization_invoice_line_idx').on(t.organizationId, t.invoiceLineId),
    foreignKey({ name: 'expenses_project_fk', columns: [t.organizationId, t.projectId], foreignColumns: [projects.organizationId, projects.id] }),
    foreignKey({ name: 'expenses_company_fk', columns: [t.organizationId, t.companyId], foreignColumns: [companies.organizationId, companies.id] }),
    foreignKey({ name: 'expenses_tax_rate_fk', columns: [t.organizationId, t.taxRateId], foreignColumns: [taxRates.organizationId, taxRates.id] }),
    foreignKey({ name: 'expenses_invoice_line_fk', columns: [t.organizationId, t.invoiceLineId], foreignColumns: [invoiceLines.organizationId, invoiceLines.id] }),
    index('expenses_organization_bank_account_idx').on(t.organizationId, t.bankAccountId),
    foreignKey({
      name: 'expenses_bank_account_fk',
      columns: [t.organizationId, t.bankAccountId, t.currency],
      foreignColumns: [bankAccounts.organizationId, bankAccounts.id, bankAccounts.currency],
    }),
    uniqueIndex('expenses_organization_number_key').on(t.organizationId, t.number),
    index('expenses_organization_status_idx').on(t.organizationId, t.status),
    foreignKey({ name: 'expenses_category_fk', columns: [t.organizationId, t.category], foreignColumns: [expenseCategories.organizationId, expenseCategories.key] }),
    check('expenses_status_check', sql`${t.status} in ${oneOf(EXPENSE_STATUSES)}`),
    check('expenses_source_check', sql`${t.source} in ${oneOf(EXPENSE_SOURCES)}`),
    check('expenses_payment_method_check', sql`${t.paymentMethod} in ${oneOf(EXPENSE_PAYMENT_METHODS)}`),
    /** A draft has not been confirmed by anyone. (A confirmed one says when, where it was confirmed through Workloom.) */
    check('expenses_confirmed_check', sql`${t.status} = 'confirmed' or ${t.confirmedAt} is null`),
    /** A draft is not yet a cost: it has no number and cannot have been rebilled. */
    check('expenses_draft_check', sql`${t.status} = 'confirmed' or (${t.number} is null and ${t.invoiceLineId} is null)`),
    check('expenses_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$' and ${t.baseCurrency} ~ '^[A-Z]{3}$'`),
    check('expenses_amount_check', sql`${t.amountMinor} >= 0 and ${t.taxMinor} >= 0`),
    check('expenses_exchange_rate_check', sql`${t.exchangeRateToBase} > 0`),
    check('expenses_tax_snapshot_check', sql`(${t.taxRateId} is null) = (${t.taxName} is null) and (${t.taxName} is null) = (${t.taxRatePctSnapshot} is null)`),
    check('expenses_markup_check', sql`${t.markupPercent} between 0 and 1000`),
    /** Only a billable expense can have been rebilled. */
    check('expenses_billable_check', sql`${t.invoiceLineId} is null or ${t.billable}`),
  ],
)

/**
 * The receipts behind an expense: photos and PDFs, in file storage.
 *
 * Its own table with its own key, as S7c said receipts should be, rather than
 * a polymorphic owner on `attachments`. The bytes were checked to be an image or
 * a PDF when they arrived; `sha256` lets the same receipt sent twice be spotted.
 */
export const expenseReceipts = pgTable(
  'expense_receipts',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    expenseId: uuid('expense_id').notNull(),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    source: text('source').notNull().default('web'),
    uploadedBy: uuid('uploaded_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('expense_receipts_organization_id_id_key').on(t.organizationId, t.id),
    uniqueIndex('expense_receipts_storage_key_key').on(t.storageKey),
    index('expense_receipts_organization_expense_idx').on(t.organizationId, t.expenseId),
    index('expense_receipts_organization_sha256_idx').on(t.organizationId, t.sha256),
    foreignKey({ name: 'expense_receipts_expense_fk', columns: [t.organizationId, t.expenseId], foreignColumns: [expenses.organizationId, expenses.id] }).onDelete('cascade'),
    check('expense_receipts_source_check', sql`${t.source} in ${oneOf(EXPENSE_SOURCES)}`),
    check('expense_receipts_size_check', sql`${t.sizeBytes} > 0`),
    check('expense_receipts_content_type_check', sql`${t.contentType} in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf')`),
  ],
)
