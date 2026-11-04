import { sql } from 'drizzle-orm'
import { boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Authentication and organization membership.
 *
 * These tables are owned by Better Auth. They are deliberately NOT under
 * row-level security -- see docs/architecture.md. In short: a user is not
 * org-scoped, and "which organizations does this user belong to?" has to be
 * answerable before any organization context exists. Under RLS it would
 * return nothing.
 *
 * Access to them is confined to packages/auth. Domain code reads membership
 * through resolveActor, never by querying here.
 */

export const user = pgTable(
  'user',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('user_email_key').on(t.email)],
)

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /**
     * Which organization this session is currently acting in. Set by the
     * organization plugin; read by resolveActor to build the ActorContext.
     */
    activeOrganizationId: uuid('active_organization_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('session_token_key').on(t.token), index('session_user_id_idx').on(t.userId)],
)

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Argon2/scrypt hash for credential accounts. Never a plaintext password. */
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

/**
 * The tenant.
 *
 * `organization.id` is the value every domain table carries as
 * `organization_id`, and the value row-level security compares against.
 *
 * Workloom's own settings live here as additional fields rather than in a
 * separate table: they are read on nearly every request, and a join for
 * `base_currency` on every money-formatting path is a poor trade.
 */
export const organization = pgTable(
  'organization',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    metadata: text('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** Reporting currency. Every cross-currency total is converted into it. */
    baseCurrency: text('base_currency').notNull().default('AUD'),
    /**
     * Drives every "overdue" and "due today" calculation. Getting this wrong
     * puts invoice ageing off by a day, which finance staff notice at once.
     */
    timezone: text('timezone').notNull().default('UTC'),
    dateFormat: text('date_format').notNull().default('DD/MM/YYYY'),

    /** What goes at the top of a quote or an invoice, and how it is paid. */
    legalName: text('legal_name'),
    billingAddress: text('billing_address'),
    /** ABN, VAT number, or whatever the jurisdiction calls it. */
    taxNumber: text('tax_number'),
    paymentInstructions: text('payment_instructions'),
    /** Days from issue to due, unless an invoice says otherwise. */
    paymentTermsDays: integer('payment_terms_days').notNull().default(14),

    /**
     * The month the financial year starts in: 1 for January, 4 for a
     * Sri Lankan or UK April year. Numbering resets and the tax pack use it.
     */
    fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
    /**
     * The printed logo, as a key in file storage -- never a URL, so rendering a
     * document cannot be made to fetch something of someone else's choosing.
     * Better Auth's `logo` column above is left to Better Auth.
     */
    logoKey: text('logo_key'),
    /** The accent on printed documents, as "#0b8a5e". */
    brandColor: text('brand_color'),
    /**
     * How to pay, as ordered label/value rows printed in a box: Account Name,
     * Account Number, Bank, Branch. Validated in core; at most eight rows.
     */
    paymentDetails: jsonb('payment_details').$type<Array<{ label: string; value: string }>>().notNull().default([]),
    /** What a new invoice or quote says unless someone writes otherwise. */
    invoiceNotesDefault: text('invoice_notes_default'),
    invoiceTermsDefault: text('invoice_terms_default'),
    quoteTermsDefault: text('quote_terms_default'),
    /** The last line of every printed page: "This is a computer-generated invoice…". */
    documentFooter: text('document_footer'),
    /**
     * Whether tax paid on expenses is claimed back. When it is not -- an agency
     * below the VAT threshold -- that tax is part of what the expense cost.
     */
    reclaimsInputTax: boolean('reclaims_input_tax').notNull().default(true),
    /**
     * Whether receipts are sent to Claude to be read, from Telegram or the
     * expense form. Off until someone turns it on: it sends the receipt to
     * Anthropic, and the installation needs an API key for it.
     */
    receiptReadingEnabled: boolean('receipt_reading_enabled').notNull().default(false),
    /**
     * The books are closed up to and including this day: invoices issued,
     * payments received, and expenses incurred on or before it can no longer
     * be added, changed, or removed. Enforced by triggers, not only here.
     */
    booksLockedThrough: date('books_locked_through', { mode: 'string' }),
  },
  (t) => [
    uniqueIndex('organization_slug_key').on(t.slug),
    check('organization_fiscal_year_start_month_check', sql`${t.fiscalYearStartMonth} between 1 and 12`),
    check('organization_brand_color_check', sql`${t.brandColor} ~ '^#[0-9a-f]{6}$'`),
    check('organization_payment_details_check', sql`jsonb_typeof(${t.paymentDetails}) = 'array' and jsonb_array_length(${t.paymentDetails}) <= 8`),
  ],
)

export const member = pgTable(
  'member',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** One of the roles in packages/core/permissions. */
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('member_organization_user_key').on(t.organizationId, t.userId),
    index('member_user_id_idx').on(t.userId),
  ],
)

export const invitation = pgTable(
  'invitation',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('pending'),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invitation_organization_id_idx').on(t.organizationId),
    index('invitation_email_idx').on(t.email),
  ],
)
