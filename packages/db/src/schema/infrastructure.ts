import { sql } from 'drizzle-orm'
import { bigint, boolean, check, date, foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { companies } from './crm.ts'
import { projects } from './projects.ts'

/**
 * Infrastructure: what the agency runs, and for whom.
 *
 * The value is the renewal date. A domain that lapses takes a client's site
 * with it, and the agency is who they call -- so an asset is a record with an
 * expiry, and the worker announces the ones approaching it.
 *
 * There are deliberately no credentials here. Storing them demands envelope
 * encryption, a restricted role, and an audit entry on every read; that is its
 * own piece of work, and a `password` column added in the meantime is how
 * secrets end up in a database backup in plain text.
 */

export const ASSET_KINDS = ['domain', 'hosting', 'server', 'application', 'ssl_certificate', 'email', 'saas', 'other'] as const
export const ASSET_STATUSES = ['active', 'pending', 'suspended', 'expired', 'decommissioned'] as const
export const ASSET_ENVIRONMENTS = ['production', 'staging', 'development', 'other'] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

export const infrastructureAssets = pgTable(
  'infrastructure_assets',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** The client it belongs to. Null for the agency's own. */
    companyId: uuid('company_id'),
    projectId: uuid('project_id'),
    kind: text('kind').notNull().default('other'),
    /** What it is called where it lives: `example.com`, `web-01`, `Acme staging`. */
    name: text('name').notNull(),
    /** Who it is with: Cloudflare, Vercel, a registrar, a VPS host. */
    provider: text('provider'),
    url: text('url'),
    environment: text('environment').notNull().default('production'),
    status: text('status').notNull().default('active'),

    /** Renewal or expiry. The column the whole module exists for. */
    expiresOn: date('expires_on', { mode: 'string' }),
    autoRenew: boolean('auto_renew').notNull().default(false),
    /** What renewing costs, where it is worth tracking against the client. */
    renewalCostMinor: bigint('renewal_cost_minor', { mode: 'number' }),
    currency: text('currency'),
    /**
     * The expiry the worker has already announced. Compared against
     * `expires_on`, so a renewal that moves the date arms the notice again and
     * an unchanged date is announced once.
     */
    expiryNoticeSentFor: date('expiry_notice_sent_for', { mode: 'string' }),

    /** The person who knows about this one. */
    ownerId: uuid('owner_id').references(() => user.id, { onDelete: 'set null' }),
    notes: text('notes'),
    decommissionedAt: timestamp('decommissioned_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('infrastructure_assets_organization_id_id_key').on(t.organizationId, t.id),
    index('infrastructure_assets_organization_company_idx').on(t.organizationId, t.companyId),
    index('infrastructure_assets_organization_kind_idx').on(t.organizationId, t.kind, t.status),
    // The worker's query, and the "expiring soon" view the module is for.
    index('infrastructure_assets_organization_expiry_idx').on(t.organizationId, t.expiresOn),
    foreignKey({
      name: 'infrastructure_assets_company_fk',
      columns: [t.organizationId, t.companyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
    foreignKey({
      name: 'infrastructure_assets_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    check('infrastructure_assets_kind_check', sql`${t.kind} in ${oneOf(ASSET_KINDS)}`),
    check('infrastructure_assets_status_check', sql`${t.status} in ${oneOf(ASSET_STATUSES)}`),
    check('infrastructure_assets_environment_check', sql`${t.environment} in ${oneOf(ASSET_ENVIRONMENTS)}`),
    check('infrastructure_assets_currency_check', sql`${t.currency} is null or ${t.currency} ~ '^[A-Z]{3}$'`),
    // A cost without a currency is a number nobody can spend.
    check('infrastructure_assets_cost_check', sql`(${t.renewalCostMinor} is null) = (${t.currency} is null) and (${t.renewalCostMinor} is null or ${t.renewalCostMinor} >= 0)`),
    check('infrastructure_assets_decommissioned_check', sql`(${t.status} = 'decommissioned') = (${t.decommissionedAt} is not null)`),
  ],
)
