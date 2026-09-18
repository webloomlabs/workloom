import { sql } from 'drizzle-orm'
import { bigint, boolean, check, date, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { invoiceLines } from './finance.ts'
import { projects, tasks } from './projects.ts'

/**
 * Time tracking.
 *
 * An entry's rates are resolved when it is created and copied onto the row:
 * the project member's override, then the person's default, then the
 * organization's default, each in the project's currency. Changing a rate
 * afterwards never rewrites time already logged -- which is what keeps last
 * quarter's profitability from moving when someone gets a raise.
 */

/** Where a snapshotted rate came from. */
export const RATE_SOURCES = ['project_member', 'member', 'organization'] as const
/**
 * The same, plus the one source a billable rate can never have: a member on a
 * fixed engagement fee costs the project nothing per hour, because the fee is
 * the cost. The zero that lands on their entries says so, rather than looking
 * like a rate nobody set.
 */
export const COST_RATE_SOURCES = [...RATE_SOURCES, 'project_member_fixed'] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

/**
 * Default hourly rates: the organization's (no user) and each person's.
 *
 * One row per person per currency. A default applies only to projects in its
 * own currency: there is no exchange-rate feed, and converting a rate at
 * logging time would bake an arbitrary rate into history.
 */
export const defaultRates = pgTable(
  'default_rates',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** Null for the organization's default. */
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull(),
    /** What the client is charged per hour, in minor units. */
    billableRateMinor: bigint('billable_rate_minor', { mode: 'number' }),
    /** What an hour costs the agency, in minor units. */
    costRateMinor: bigint('cost_rate_minor', { mode: 'number' }),
    ...timestamps,
  },
  (t) => [
    // NULLS NOT DISTINCT: one organization default per currency, not one per insert.
    unique('default_rates_organization_user_currency_key').on(t.organizationId, t.userId, t.currency).nullsNotDistinct(),
    check('default_rates_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('default_rates_rates_check', sql`${t.billableRateMinor} >= 0 and ${t.costRateMinor} >= 0`),
  ],
)

/**
 * Time spent on a project, and optionally on one of its tasks.
 *
 * A running timer has `started_at` and nothing else; stopping it sets
 * `ended_at` and `duration_seconds`. A manual entry has a duration and no
 * times. `duration_seconds` is what counts: editing a stopped timer's duration
 * does not rewrite when it ran.
 */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** Whose time. Not cascaded: logged time is financial history. */
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    projectId: uuid('project_id').notNull(),
    taskId: uuid('task_id'),
    description: text('description'),
    /** The calendar day the work counts towards, in the organization's time zone. */
    spentOn: date('spent_on', { mode: 'string' }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** Null only while the timer runs. */
    durationSeconds: integer('duration_seconds'),
    billable: boolean('billable').notNull(),

    /** The project's currency when the rates were resolved. */
    currency: text('currency').notNull(),
    billableRateMinor: bigint('billable_rate_minor', { mode: 'number' }),
    billableRateSource: text('billable_rate_source'),
    costRateMinor: bigint('cost_rate_minor', { mode: 'number' }),
    costRateSource: text('cost_rate_source'),

    /**
     * The invoice line that billed this time, from S7b. Set together for every
     * entry a line covers; cleared by the service when the line goes, which the
     * foreign key requires before the line can be deleted.
     */
    invoiceLineId: uuid('invoice_line_id'),

    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('time_entries_organization_id_id_key').on(t.organizationId, t.id),
    index('time_entries_organization_invoice_line_idx').on(t.organizationId, t.invoiceLineId),
    foreignKey({
      name: 'time_entries_invoice_line_fk',
      columns: [t.organizationId, t.invoiceLineId],
      foreignColumns: [invoiceLines.organizationId, invoiceLines.id],
    }),
    // The rule the whole timer design rests on: one running timer per person,
    // per organization, however many requests arrive at once.
    uniqueIndex('time_entries_one_running_timer_key')
      .on(t.organizationId, t.userId)
      .where(sql`${t.startedAt} is not null and ${t.endedAt} is null`),
    index('time_entries_organization_user_spent_on_idx').on(t.organizationId, t.userId, t.spentOn),
    index('time_entries_organization_project_spent_on_idx').on(t.organizationId, t.projectId, t.spentOn),
    index('time_entries_organization_task_idx').on(t.organizationId, t.taskId),
    foreignKey({
      name: 'time_entries_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    // Including project_id, so an entry's task is always from its own project.
    // Not cascaded: a task with time logged against it cannot simply vanish.
    foreignKey({
      name: 'time_entries_task_fk',
      columns: [t.organizationId, t.projectId, t.taskId],
      foreignColumns: [tasks.organizationId, tasks.projectId, tasks.id],
    }),
    check('time_entries_running_check', sql`(${t.durationSeconds} is null) = (${t.startedAt} is not null and ${t.endedAt} is null)`),
    check('time_entries_ended_check', sql`${t.endedAt} is null or (${t.startedAt} is not null and ${t.endedAt} >= ${t.startedAt})`),
    check('time_entries_duration_check', sql`${t.durationSeconds} >= 0`),
    check('time_entries_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('time_entries_rates_check', sql`${t.billableRateMinor} >= 0 and ${t.costRateMinor} >= 0`),
    check(
      'time_entries_billable_source_check',
      sql`(${t.billableRateMinor} is null) = (${t.billableRateSource} is null) and ${t.billableRateSource} in ${oneOf(RATE_SOURCES)}`,
    ),
    check(
      'time_entries_cost_source_check',
      sql`(${t.costRateMinor} is null) = (${t.costRateSource} is null) and ${t.costRateSource} in ${oneOf(COST_RATE_SOURCES)}`,
    ),
  ],
)
