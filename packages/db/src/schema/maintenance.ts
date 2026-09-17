import { sql } from 'drizzle-orm'
import { check, date, foreignKey, index, integer, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { billingSchedules } from './billing.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { companies } from './crm.ts'

/**
 * Maintenance: the work that continues after delivery.
 *
 * A plan is the agreement -- what is included, what response the client is
 * owed, and which billing schedule pays for it. Attaching the schedule rather
 * than duplicating its fields is what stops a plan and its invoices disagreeing
 * about the price of a month.
 *
 * Visits are the history. They are what turns "we look after your site" into
 * something that can be shown to a client who asks what they are paying for.
 */

export const MAINTENANCE_PLAN_STATUSES = ['active', 'paused', 'ended'] as const
export const MAINTENANCE_VISIT_KINDS = [
  'security_update',
  'backup',
  'performance_check',
  'uptime_check',
  'content_update',
  'review',
  'incident',
  'other',
] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

export const maintenancePlans = pgTable(
  'maintenance_plans',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active'),
    startedOn: date('started_on', { mode: 'string' }).notNull(),
    endedOn: date('ended_on', { mode: 'string' }),

    /**
     * The service level this plan buys, in hours from the moment a ticket
     * arrives. Null falls back to the defaults for the ticket's priority.
     */
    responseHours: integer('response_hours'),
    resolutionHours: integer('resolution_hours'),
    /** Support hours the plan includes each billing period, where it caps them. */
    includedHours: numeric('included_hours', { precision: 8, scale: 2 }),

    /** What bills it. One schedule, so the plan and the invoice cannot disagree. */
    billingScheduleId: uuid('billing_schedule_id'),
    /** The person accountable for the account. */
    ownerId: uuid('owner_id').references(() => user.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('maintenance_plans_organization_id_id_key').on(t.organizationId, t.id),
    index('maintenance_plans_organization_company_idx').on(t.organizationId, t.companyId, t.status),
    foreignKey({
      name: 'maintenance_plans_company_fk',
      columns: [t.organizationId, t.companyId],
      foreignColumns: [companies.organizationId, companies.id],
    }),
    foreignKey({
      name: 'maintenance_plans_billing_schedule_fk',
      columns: [t.organizationId, t.billingScheduleId],
      foreignColumns: [billingSchedules.organizationId, billingSchedules.id],
    }).onDelete('set null'),
    check('maintenance_plans_status_check', sql`${t.status} in ${oneOf(MAINTENANCE_PLAN_STATUSES)}`),
    check('maintenance_plans_window_check', sql`${t.endedOn} is null or ${t.endedOn} >= ${t.startedOn}`),
    check('maintenance_plans_sla_check', sql`(${t.responseHours} is null or ${t.responseHours} between 1 and 8760) and (${t.resolutionHours} is null or ${t.resolutionHours} between 1 and 8760)`),
    check('maintenance_plans_included_hours_check', sql`${t.includedHours} is null or ${t.includedHours} > 0`),
  ],
)

/** What a plan covers: one line per thing the client is promised. */
export const maintenancePlanItems = pgTable(
  'maintenance_plan_items',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    planId: uuid('plan_id').notNull(),
    label: text('label').notNull(),
    position: integer('position').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('maintenance_plan_items_organization_id_id_key').on(t.organizationId, t.id),
    index('maintenance_plan_items_organization_plan_idx').on(t.organizationId, t.planId, t.position),
    foreignKey({
      name: 'maintenance_plan_items_plan_fk',
      columns: [t.organizationId, t.planId],
      foreignColumns: [maintenancePlans.organizationId, maintenancePlans.id],
    }).onDelete('cascade'),
    check('maintenance_plan_items_position_check', sql`${t.position} >= 1`),
  ],
)

/** What was actually done, and when. The record a client asks to see. */
export const maintenanceVisits = pgTable(
  'maintenance_visits',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    planId: uuid('plan_id').notNull(),
    performedOn: date('performed_on', { mode: 'string' }).notNull(),
    kind: text('kind').notNull().default('other'),
    summary: text('summary').notNull(),
    notes: text('notes'),
    /** Minutes spent, where it is worth recording against the plan's included hours. */
    minutesSpent: integer('minutes_spent'),
    performedBy: uuid('performed_by').references(() => user.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('maintenance_visits_organization_id_id_key').on(t.organizationId, t.id),
    index('maintenance_visits_organization_plan_idx').on(t.organizationId, t.planId, t.performedOn),
    foreignKey({
      name: 'maintenance_visits_plan_fk',
      columns: [t.organizationId, t.planId],
      foreignColumns: [maintenancePlans.organizationId, maintenancePlans.id],
    }).onDelete('cascade'),
    check('maintenance_visits_kind_check', sql`${t.kind} in ${oneOf(MAINTENANCE_VISIT_KINDS)}`),
    check('maintenance_visits_minutes_check', sql`${t.minutesSpent} is null or ${t.minutesSpent} > 0`),
  ],
)
