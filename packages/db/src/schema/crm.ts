import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'

/**
 * The CRM.
 *
 * Lifecycle: a lead is captured, worked, and qualified; conversion turns it
 * into a company, a contact, and optionally a deal; winning a deal (or
 * converting without one) makes the company a client.
 *
 * There is no `clients` table. A client is a company whose lifecycle stage is
 * `client`. Splitting the two at the table level would force a re-parenting
 * migration on every conversion -- which is exactly where CRMs lose history.
 * Leads, by contrast, stay in their own table: web forms and the public API
 * produce low-quality rows that must not pollute the company list.
 *
 * Status vocabularies are text with a CHECK constraint rather than Postgres
 * enums, which cannot have values removed or reordered. The value lists are
 * defined here, once, and the service layer's validation derives from them.
 */

export const COMPANY_LIFECYCLE_STAGES = ['prospect', 'client', 'former_client'] as const
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'disqualified', 'converted'] as const
export const LEAD_SOURCES = [
  'website',
  'referral',
  'inbound_email',
  'phone',
  'social',
  'event',
  'partner',
  'outbound',
  'other',
] as const
/** The sales pipeline after qualification. Before it, a prospect is a lead. */
export const DEAL_STAGES = ['qualified', 'proposal_sent', 'negotiation', 'won', 'lost'] as const
export const ACTIVITY_TYPES = ['note', 'call', 'email', 'meeting'] as const

/** `col in ('a', 'b')` as literal SQL: a bound parameter is invalid in DDL. */
function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

const owner = () => uuid('owner_id').references(() => user.id, { onDelete: 'set null' })
const createdBy = () => uuid('created_by').references(() => user.id, { onDelete: 'set null' })

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    name: text('name').notNull(),
    website: text('website'),
    email: text('email'),
    phone: text('phone'),
    industry: text('industry'),
    address: text('address'),
    description: text('description'),

    lifecycleStage: text('lifecycle_stage').notNull().default('prospect'),
    /** First time it became a client. Kept if it later lapses, for reporting. */
    becameClientAt: timestamp('became_client_at', { withTimezone: true }),

    /** The account manager responsible for the relationship. */
    ownerId: owner(),
    /** Denormalised from activities, for "not contacted recently" queries. */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('companies_organization_id_id_key').on(t.organizationId, t.id),
    index('companies_organization_stage_idx').on(t.organizationId, t.lifecycleStage),
    index('companies_organization_name_idx').on(t.organizationId, t.name),
    check('companies_lifecycle_stage_check', sql`${t.lifecycleStage} in ${oneOf(COMPANY_LIFECYCLE_STAGES)}`),
  ],
)

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    companyId: uuid('company_id'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    jobTitle: text('job_title'),
    ownerId: owner(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('contacts_organization_id_id_key').on(t.organizationId, t.id),
    index('contacts_organization_company_idx').on(t.organizationId, t.companyId),
    // One live contact per email address. Lead conversion relies on it to
    // find the existing person rather than creating a duplicate.
    uniqueIndex('contacts_organization_email_key')
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.email} is not null and ${t.archivedAt} is null`),
    // Composite: a contact cannot belong to another organization's company,
    // whatever the application does.
    foreignKey({
      name: 'contacts_company_fk',
      columns: [t.organizationId, t.companyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
  ],
)

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    companyId: uuid('company_id').notNull(),
    /** The main person on the client side. */
    contactId: uuid('contact_id'),
    name: text('name').notNull(),
    stage: text('stage').notNull().default('qualified'),

    /**
     * Integer minor units of `currency` (cents for AUD, yen for JPY). Never a
     * float, and not `numeric` either: drivers return numeric as a string, and
     * the first parseFloat() introduces a rounding error nobody notices.
     */
    valueMinor: bigint('value_minor', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull(),
    expectedCloseDate: date('expected_close_date', { mode: 'string' }),

    ownerId: owner(),
    /** Set when the deal is won or lost; cleared if it is reopened. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lostReason: text('lost_reason'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('deals_organization_id_id_key').on(t.organizationId, t.id),
    index('deals_organization_stage_idx').on(t.organizationId, t.stage),
    index('deals_organization_company_idx').on(t.organizationId, t.companyId),
    foreignKey({
      name: 'deals_company_fk',
      columns: [t.organizationId, t.companyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
    foreignKey({
      name: 'deals_contact_fk',
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    check('deals_stage_check', sql`${t.stage} in ${oneOf(DEAL_STAGES)}`),
    check('deals_value_check', sql`${t.valueMinor} >= 0`),
    check('deals_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('deals_closed_check', sql`(${t.stage} in ('won', 'lost')) = (${t.closedAt} is not null)`),
  ],
)

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** The person, as they gave their name. Split into first/last on conversion. */
    contactName: text('contact_name'),
    email: text('email'),
    phone: text('phone'),
    companyName: text('company_name'),
    website: text('website'),
    source: text('source').notNull().default('other'),
    status: text('status').notNull().default('new'),
    /** What they asked for -- often the body of an enquiry form. */
    details: text('details'),
    disqualifiedReason: text('disqualified_reason'),

    ownerId: owner(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),

    convertedAt: timestamp('converted_at', { withTimezone: true }),
    convertedCompanyId: uuid('converted_company_id'),
    convertedContactId: uuid('converted_contact_id'),
    convertedDealId: uuid('converted_deal_id'),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [
    unique('leads_organization_id_id_key').on(t.organizationId, t.id),
    index('leads_organization_status_idx').on(t.organizationId, t.status),
    foreignKey({
      name: 'leads_converted_company_fk',
      columns: [t.organizationId, t.convertedCompanyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
    foreignKey({
      name: 'leads_converted_contact_fk',
      columns: [t.organizationId, t.convertedContactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    foreignKey({
      name: 'leads_converted_deal_fk',
      columns: [t.organizationId, t.convertedDealId],
      foreignColumns: [deals.organizationId, deals.id],
    }),
    check('leads_status_check', sql`${t.status} in ${oneOf(LEAD_STATUSES)}`),
    check('leads_source_check', sql`${t.source} in ${oneOf(LEAD_SOURCES)}`),
    // A lead nobody can identify is not a lead.
    check(
      'leads_identifiable_check',
      sql`coalesce(${t.contactName}, ${t.companyName}, ${t.email}) is not null`,
    ),
    check(
      'leads_converted_check',
      sql`(${t.status} = 'converted') = (${t.convertedAt} is not null and ${t.convertedCompanyId} is not null)`,
    ),
  ],
)

/**
 * Notes, calls, emails, and meetings.
 *
 * Linked by real foreign keys rather than a polymorphic `(entity_type,
 * entity_id)` pair, so a note can never point at a record that does not exist
 * or belongs to another organization. One activity can link several records at
 * once: a call logged on a deal also carries the deal's company, which is what
 * puts it in the company's history. On lead conversion the lead's activities
 * gain the new company, contact, and deal -- history moves with the relationship.
 */
export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    type: text('type').notNull(),
    body: text('body').notNull(),
    /** When it happened, which for a logged call is often earlier than now. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    authorId: uuid('author_id').references(() => user.id, { onDelete: 'set null' }),

    companyId: uuid('company_id'),
    contactId: uuid('contact_id'),
    leadId: uuid('lead_id'),
    dealId: uuid('deal_id'),
    ...timestamps,
  },
  (t) => [
    unique('activities_organization_id_id_key').on(t.organizationId, t.id),
    index('activities_organization_company_idx').on(t.organizationId, t.companyId, t.occurredAt),
    index('activities_organization_contact_idx').on(t.organizationId, t.contactId, t.occurredAt),
    index('activities_organization_lead_idx').on(t.organizationId, t.leadId, t.occurredAt),
    index('activities_organization_deal_idx').on(t.organizationId, t.dealId, t.occurredAt),
    foreignKey({
      name: 'activities_company_fk',
      columns: [t.organizationId, t.companyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
    foreignKey({
      name: 'activities_contact_fk',
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    foreignKey({
      name: 'activities_lead_fk',
      columns: [t.organizationId, t.leadId],
      foreignColumns: [leads.organizationId, leads.id],
    }),
    foreignKey({
      name: 'activities_deal_fk',
      columns: [t.organizationId, t.dealId],
      foreignColumns: [deals.organizationId, deals.id],
    }),
    check('activities_type_check', sql`${t.type} in ${oneOf(ACTIVITY_TYPES)}`),
    check(
      'activities_linked_check',
      sql`num_nonnulls(${t.companyId}, ${t.contactId}, ${t.leadId}, ${t.dealId}) > 0`,
    ),
  ],
)
