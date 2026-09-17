import { sql } from 'drizzle-orm'
import {
  bigint,
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
export const DOCUMENT_KINDS = ['quote', 'invoice', 'ticket'] as const

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
    prefix: text('prefix').notNull(),
    /** Digits the number is zero-padded to: 4 makes "Q-0001". */
    padding: integer('padding').notNull().default(4),
    nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'document_sequences_pkey', columns: [t.organizationId, t.kind] }),
    check('document_sequences_kind_check', sql`${t.kind} in ${oneOf(DOCUMENT_KINDS)}`),
    check('document_sequences_next_value_check', sql`${t.nextValue} >= 1`),
    check('document_sequences_padding_check', sql`${t.padding} between 1 and 12`),
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
    projectId: uuid('project_id'),
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
    description: text('description').notNull(),
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
    /** Issue date plus the payment terms, fixed when the invoice is issued. */
    dueDate: date('due_date', { mode: 'string' }),
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
      sql`(${t.status} = 'draft') = (${t.sentAt} is null and ${t.issueDate} is null and ${t.dueDate} is null and ${t.exchangeRateToBase} is null and ${t.baseCurrency} is null and ${t.totalBaseMinor} is null)`,
    ),
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
    serviceId: uuid('service_id'),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
    unitAmountMinor: bigint('unit_amount_minor', { mode: 'number' }).notNull(),
    discountPercent: numeric('discount_percent', { precision: 7, scale: 4 }),
    taxRateId: uuid('tax_rate_id'),
    taxName: text('tax_name'),
    taxRatePctSnapshot: numeric('tax_rate_pct_snapshot', { precision: 7, scale: 4 }),

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
    foreignKey({ name: 'invoice_lines_invoice_fk', columns: [t.organizationId, t.invoiceId], foreignColumns: [invoices.organizationId, invoices.id] }).onDelete('cascade'),
    foreignKey({ name: 'invoice_lines_service_fk', columns: [t.organizationId, t.serviceId], foreignColumns: [services.organizationId, services.id] }),
    foreignKey({ name: 'invoice_lines_tax_rate_fk', columns: [t.organizationId, t.taxRateId], foreignColumns: [taxRates.organizationId, taxRates.id] }),
    check('invoice_lines_quantity_check', sql`${t.quantity} <> 0`),
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

    notes: text('notes'),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('expenses_organization_id_id_key').on(t.organizationId, t.id),
    index('expenses_organization_incurred_on_idx').on(t.organizationId, t.incurredOn),
    index('expenses_organization_project_idx').on(t.organizationId, t.projectId),
    index('expenses_organization_company_idx').on(t.organizationId, t.companyId),
    index('expenses_organization_invoice_line_idx').on(t.organizationId, t.invoiceLineId),
    foreignKey({ name: 'expenses_project_fk', columns: [t.organizationId, t.projectId], foreignColumns: [projects.organizationId, projects.id] }),
    foreignKey({ name: 'expenses_company_fk', columns: [t.organizationId, t.companyId], foreignColumns: [companies.organizationId, companies.id] }),
    foreignKey({ name: 'expenses_tax_rate_fk', columns: [t.organizationId, t.taxRateId], foreignColumns: [taxRates.organizationId, taxRates.id] }),
    foreignKey({ name: 'expenses_invoice_line_fk', columns: [t.organizationId, t.invoiceLineId], foreignColumns: [invoiceLines.organizationId, invoiceLines.id] }),
    check('expenses_category_check', sql`${t.category} in ${oneOf(EXPENSE_CATEGORIES)}`),
    check('expenses_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$' and ${t.baseCurrency} ~ '^[A-Z]{3}$'`),
    check('expenses_amount_check', sql`${t.amountMinor} >= 0 and ${t.taxMinor} >= 0`),
    check('expenses_exchange_rate_check', sql`${t.exchangeRateToBase} > 0`),
    check('expenses_tax_snapshot_check', sql`(${t.taxRateId} is null) = (${t.taxName} is null) and (${t.taxName} is null) = (${t.taxRatePctSnapshot} is null)`),
    check('expenses_markup_check', sql`${t.markupPercent} between 0 and 1000`),
    /** Only a billable expense can have been rebilled. */
    check('expenses_billable_check', sql`${t.invoiceLineId} is null or ${t.billable}`),
  ],
)
