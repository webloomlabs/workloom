import { sql } from 'drizzle-orm'
import { bigint, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { companies, contacts } from './crm.ts'
import { projects } from './projects.ts'
import { invoices, services, taxRates } from './finance.ts'

/**
 * Recurring billing.
 *
 * A schedule is a template for an invoice plus a calendar. It never bills
 * anything itself: the worker raises a *draft* invoice when a period comes due
 * and a person issues it, because an invoice is a statement to a client and an
 * unattended process should not be the last thing that reads it.
 *
 * `next_run_on` is the whole clock. It is advanced only after an invoice has
 * been generated inside the same transaction, so a schedule cannot bill twice
 * for one period and cannot silently skip one: if the generation rolls back,
 * the date rolls back with it.
 */

export const BILLING_INTERVALS = ['week', 'month', 'quarter', 'year'] as const
export const BILLING_SCHEDULE_STATUSES = ['active', 'paused', 'ended'] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

export const billingSchedules = pgTable(
  'billing_schedules',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    companyId: uuid('company_id').notNull(),
    contactId: uuid('contact_id'),
    projectId: uuid('project_id'),
    /** What it is for, and the title each generated invoice is given. */
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),

    currency: text('currency').notNull(),
    taxMode: text('tax_mode').notNull().default('exclusive'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(14),
    notes: text('notes'),
    terms: text('terms'),

    intervalUnit: text('interval_unit').notNull().default('month'),
    /** Every `interval_count` units: 3 months, 2 weeks. */
    intervalCount: integer('interval_count').notNull().default(1),
    startOn: date('start_on', { mode: 'string' }).notNull(),
    /** The period the next invoice covers. Null once the schedule has ended. */
    nextRunOn: date('next_run_on', { mode: 'string' }),
    /** Stops on or before this date. */
    endOn: date('end_on', { mode: 'string' }),
    /** Stops after this many invoices. */
    maxOccurrences: integer('max_occurrences'),
    generatedCount: integer('generated_count').notNull().default(0),

    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    ownerId: uuid('owner_id').references(() => user.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('billing_schedules_organization_id_id_key').on(t.organizationId, t.id),
    unique('billing_schedules_organization_id_id_currency_key').on(t.organizationId, t.id, t.currency),
    index('billing_schedules_organization_company_idx').on(t.organizationId, t.companyId),
    // The worker's query: active schedules whose next period has arrived.
    index('billing_schedules_organization_due_idx').on(t.organizationId, t.status, t.nextRunOn),
    foreignKey({
      name: 'billing_schedules_company_fk',
      columns: [t.organizationId, t.companyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
    foreignKey({
      name: 'billing_schedules_contact_fk',
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
    foreignKey({
      name: 'billing_schedules_project_fk',
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    check('billing_schedules_status_check', sql`${t.status} in ${oneOf(BILLING_SCHEDULE_STATUSES)}`),
    check('billing_schedules_interval_check', sql`${t.intervalUnit} in ${oneOf(BILLING_INTERVALS)}`),
    check('billing_schedules_interval_count_check', sql`${t.intervalCount} between 1 and 52`),
    check('billing_schedules_tax_mode_check', sql`${t.taxMode} in ('exclusive', 'inclusive')`),
    check('billing_schedules_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('billing_schedules_terms_check', sql`${t.paymentTermsDays} between 0 and 365`),
    check('billing_schedules_occurrences_check', sql`${t.maxOccurrences} is null or ${t.maxOccurrences} >= 1`),
    check('billing_schedules_generated_check', sql`${t.generatedCount} >= 0`),
    check('billing_schedules_window_check', sql`${t.endOn} is null or ${t.endOn} >= ${t.startOn}`),
    // A live schedule has a date to run on; an ended one has none left.
    check('billing_schedules_next_run_check', sql`(${t.status} = 'ended') = (${t.nextRunOn} is null)`),
  ],
)

/**
 * A line of the invoice a schedule raises.
 *
 * The same shape as an invoice line, minus everything the calculator derives:
 * what a period costs is priced when the invoice is generated, by the same code
 * that prices a hand-written one.
 */
export const billingScheduleLines = pgTable(
  'billing_schedule_lines',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    scheduleId: uuid('schedule_id').notNull(),
    position: integer('position').notNull(),
    serviceId: uuid('service_id'),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 4 }).notNull().default('1'),
    /** Minor units of the schedule's currency. */
    unitAmountMinor: bigint('unit_amount_minor', { mode: 'number' }).notNull(),
    discountPercent: numeric('discount_percent', { precision: 7, scale: 4 }),
    taxRateId: uuid('tax_rate_id'),
    ...timestamps,
  },
  (t) => [
    unique('billing_schedule_lines_organization_id_id_key').on(t.organizationId, t.id),
    index('billing_schedule_lines_organization_schedule_idx').on(t.organizationId, t.scheduleId, t.position),
    foreignKey({
      name: 'billing_schedule_lines_schedule_fk',
      columns: [t.organizationId, t.scheduleId],
      foreignColumns: [billingSchedules.organizationId, billingSchedules.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'billing_schedule_lines_service_fk',
      columns: [t.organizationId, t.serviceId],
      foreignColumns: [services.organizationId, services.id],
    }),
    foreignKey({
      name: 'billing_schedule_lines_tax_rate_fk',
      columns: [t.organizationId, t.taxRateId],
      foreignColumns: [taxRates.organizationId, taxRates.id],
    }),
    check('billing_schedule_lines_quantity_check', sql`${t.quantity} > 0`),
    check('billing_schedule_lines_discount_check', sql`${t.discountPercent} between 0 and 100`),
    check('billing_schedule_lines_position_check', sql`${t.position} >= 1`),
  ],
)

/**
 * Which invoice covered which period.
 *
 * A column on `invoices` would say where an invoice came from; this says what
 * it was *for*, and the unique key on `(schedule, period_start)` is what makes
 * billing a period twice impossible rather than merely unlikely -- the case a
 * retried job or a double-clicked button would otherwise produce.
 */
export const billingScheduleInvoices = pgTable(
  'billing_schedule_invoices',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    scheduleId: uuid('schedule_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    /** The period the invoice bills, inclusive of both ends. */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('billing_schedule_invoices_organization_id_id_key').on(t.organizationId, t.id),
    unique('billing_schedule_invoices_period_key').on(t.organizationId, t.scheduleId, t.periodStart),
    unique('billing_schedule_invoices_invoice_key').on(t.organizationId, t.invoiceId),
    foreignKey({
      name: 'billing_schedule_invoices_schedule_fk',
      columns: [t.organizationId, t.scheduleId],
      foreignColumns: [billingSchedules.organizationId, billingSchedules.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'billing_schedule_invoices_invoice_fk',
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoices.organizationId, invoices.id],
    }).onDelete('cascade'),
    check('billing_schedule_invoices_period_check', sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
)
