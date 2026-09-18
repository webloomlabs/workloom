import { sql } from 'drizzle-orm'
import { bigint, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'
import { invoices, quotes } from './finance.ts'
import { milestones, projects } from './projects.ts'

/**
 * How a project changed after it was agreed.
 *
 * A **variation** changes the scope and the price. An **extension** changes the
 * dates and nothing else. Both are the same record because they are the same
 * conversation -- "this is not what we agreed, here is what it is now" -- and
 * splitting them into two tables would mean two approval flows for one act.
 *
 * Accepting one raises the project's `contract_value_minor` and moves its due
 * date. That is the whole mechanism: there is no separate "extra work" ledger,
 * because the contracted value is simply the agreed price plus every accepted
 * change to it, and a billing plan draws against that total.
 *
 * Numbers restart at 1 per project -- "revision 2 of the Acme rebuild" -- so
 * they deliberately do not come from `document_sequences`, which hands out
 * per-tenant gapless numbers for documents with legal weight. Deleting a draft
 * leaves a gap here, and that is fine: a revision nobody sent was never a
 * statement to anyone.
 */

export const PROJECT_REVISION_KINDS = ['variation', 'extension'] as const
export const PROJECT_REVISION_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'withdrawn'] as const

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

export const projectRevisions = pgTable(
  'project_revisions',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    projectId: uuid('project_id').notNull(),
    /** From 1, per project. Assigned at creation: a draft has to be referable while it is drafted. */
    number: integer('number').notNull(),
    kind: text('kind').notNull().default('variation'),
    title: text('title').notNull(),
    /** What changed, in the words the client will read. */
    summary: text('summary'),
    status: text('status').notNull().default('draft'),

    /** Copied from the project, and part of the foreign key: never another currency. */
    currency: text('currency').notNull(),
    /**
     * The change to the contracted value. Negative for a descope -- taking work
     * out is as much a variation as putting it in. Zero for an extension.
     */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull().default(0),
    /** The project's new due date once accepted. Null leaves the dates alone. */
    newDueDate: date('new_due_date', { mode: 'string' }),

    requestedOn: date('requested_on', { mode: 'string' }).notNull(),
    /** The quote that put this to the client formally, where there was one. */
    quoteId: uuid('quote_id'),

    /**
     * What the project said before this was applied. A snapshot for the
     * timeline, not a constraint: a project may legitimately have had neither a
     * contract value nor a due date. The authoritative record of what moved is
     * the audit entry; these columns exist so the history renders without
     * joining to it.
     */
    previousContractValueMinor: bigint('previous_contract_value_minor', { mode: 'number' }),
    previousDueDate: date('previous_due_date', { mode: 'string' }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => user.id, { onDelete: 'set null' }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    declineReason: text('decline_reason'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('project_revisions_organization_id_id_key').on(t.organizationId, t.id),
    unique('project_revisions_project_number_key').on(t.organizationId, t.projectId, t.number),
    index('project_revisions_organization_project_status_idx').on(t.organizationId, t.projectId, t.status),
    foreignKey({
      name: 'project_revisions_project_fk',
      columns: [t.organizationId, t.projectId, t.currency],
      foreignColumns: [projects.organizationId, projects.id, projects.currency],
    }),
    foreignKey({
      name: 'project_revisions_quote_fk',
      columns: [t.organizationId, t.quoteId],
      foreignColumns: [quotes.organizationId, quotes.id],
    }),
    check('project_revisions_kind_check', sql`${t.kind} in ${oneOf(PROJECT_REVISION_KINDS)}`),
    check('project_revisions_status_check', sql`${t.status} in ${oneOf(PROJECT_REVISION_STATUSES)}`),
    check('project_revisions_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('project_revisions_number_check', sql`${t.number} >= 1`),
    /** An extension is a change of time, not of price. */
    check('project_revisions_extension_check', sql`${t.kind} <> 'extension' or ${t.amountMinor} = 0`),
    /** And it has to move something, or it is not a change at all. */
    check('project_revisions_extension_date_check', sql`${t.kind} <> 'extension' or ${t.newDueDate} is not null`),
    check('project_revisions_sent_check', sql`(${t.status} = 'draft') = (${t.sentAt} is null)`),
    check('project_revisions_accepted_check', sql`(${t.status} = 'accepted') = (${t.acceptedAt} is not null)`),
    /** Accepting is what applies it. Neither happens without the other. */
    check('project_revisions_applied_check', sql`(${t.acceptedAt} is null) = (${t.appliedAt} is null)`),
    check('project_revisions_declined_check', sql`(${t.status} = 'declined') = (${t.declinedAt} is not null)`),
    check('project_revisions_withdrawn_check', sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} is not null)`),
    check('project_revisions_decline_reason_check', sql`${t.declineReason} is null or ${t.status} = 'declined'`),
  ],
)

/**
 * How a fixed-price project is billed: the advance, the mid-term, the final.
 *
 * There is no plan header table. The plan *is* the ordered set of stages plus
 * `projects.contract_value_minor` -- a header would carry nothing but a project
 * id and three defaults (`tax_mode`, `payment_terms_days`, `contact_id`) that
 * `invoice.create` already resolves, and resolving them when a stage is
 * released is more correct anyway: payment terms six months out are not
 * knowable today.
 *
 * A stage is worth either a fixed amount or a share of what the project is
 * contracted for, and which of the two is stored rather than inferred: a
 * percentage stage has to follow the contracted value as revisions raise it --
 * that is the entire point of "50% on acceptance" on a growing contract -- and
 * a fixed one must not. At release the resolved figure is frozen into
 * `released_amount_minor`, exactly as a tax snapshot is frozen onto a line.
 *
 * **This is not `billing_schedules`.** A schedule answers *how often* and bills
 * a period, forever. A plan answers *how much of a fixed price, and when it is
 * earned*, and bills a total to exhaustion. Both on one project is ordinary --
 * a fixed-price build with a monthly hosting retainer -- and they cannot eat
 * each other, because what has been billed against the plan is counted only
 * through the stages below, never through `invoices.project_id`.
 *
 * Note there is deliberately no column on `invoices` pointing back here. A new
 * column there would be frozen by `workloom_invoice_guard` the moment the
 * invoice issues; keeping the link on the child dodges the freeze entirely.
 */

export const BILLING_STAGE_BASIS = ['amount', 'percent'] as const
export const BILLING_STAGE_STATUSES = ['pending', 'invoiced', 'cancelled'] as const

export const projectBillingStages = pgTable(
  'project_billing_stages',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    projectId: uuid('project_id').notNull(),
    /** Order on the plan: 1, 2, 3 -- advance, delivery, final. */
    position: integer('position').notNull(),
    name: text('name').notNull(),
    basis: text('basis').notNull().default('amount'),
    percent: numeric('percent', { precision: 7, scale: 4 }),
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    /** Part of the foreign key to the project: never another currency. */
    currency: text('currency').notNull(),

    /** What has to be true before it is billed, in words. */
    trigger: text('trigger'),
    dueOn: date('due_on', { mode: 'string' }),
    /** The milestone whose completion releases it, where there is one. */
    milestoneId: uuid('milestone_id'),
    /** The revision this stage bills, when it came from one. */
    revisionId: uuid('revision_id'),

    status: text('status').notNull().default('pending'),
    /** What the stage was worth when released. Never recomputed afterwards. */
    releasedAmountMinor: bigint('released_amount_minor', { mode: 'number' }),
    invoiceId: uuid('invoice_id'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('project_billing_stages_organization_id_id_key').on(t.organizationId, t.id),
    uniqueIndex('project_billing_stages_project_position_key').on(t.organizationId, t.projectId, t.position),
    /** One stage per invoice: releasing the same stage twice is impossible, not merely refused. */
    uniqueIndex('project_billing_stages_invoice_key').on(t.organizationId, t.invoiceId),
    index('project_billing_stages_organization_project_status_idx').on(t.organizationId, t.projectId, t.status),
    foreignKey({
      name: 'project_billing_stages_project_fk',
      columns: [t.organizationId, t.projectId, t.currency],
      foreignColumns: [projects.organizationId, projects.id, projects.currency],
    }),
    // Including project_id, so a stage cannot hang off another project's milestone.
    foreignKey({
      name: 'project_billing_stages_milestone_fk',
      columns: [t.organizationId, t.projectId, t.milestoneId],
      foreignColumns: [milestones.organizationId, milestones.projectId, milestones.id],
    }),
    foreignKey({
      name: 'project_billing_stages_revision_fk',
      columns: [t.organizationId, t.revisionId],
      foreignColumns: [projectRevisions.organizationId, projectRevisions.id],
    }),
    foreignKey({
      name: 'project_billing_stages_invoice_fk',
      columns: [t.organizationId, t.invoiceId],
      foreignColumns: [invoices.organizationId, invoices.id],
    }),
    check('project_billing_stages_basis_check', sql`${t.basis} in ${oneOf(BILLING_STAGE_BASIS)}`),
    /** Exactly one of the two says what the stage is worth. */
    check(
      'project_billing_stages_percent_check',
      sql`(${t.basis} = 'percent') = (${t.percent} is not null) and (${t.percent} is null or ${t.percent} between 0 and 100)`,
    ),
    check(
      'project_billing_stages_amount_check',
      sql`(${t.basis} = 'amount') = (${t.amountMinor} is not null) and (${t.amountMinor} is null or ${t.amountMinor} >= 0)`,
    ),
    check('project_billing_stages_status_check', sql`${t.status} in ${oneOf(BILLING_STAGE_STATUSES)}`),
    check('project_billing_stages_position_check', sql`${t.position} >= 1`),
    check('project_billing_stages_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    /** Invoiced means all three facts, or none of them. */
    check(
      'project_billing_stages_released_check',
      sql`(${t.status} = 'invoiced') = (${t.invoiceId} is not null)
          and (${t.invoiceId} is null) = (${t.releasedAmountMinor} is null)
          and (${t.invoiceId} is null) = (${t.releasedAt} is null)`,
    ),
    check('project_billing_stages_cancelled_check', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
  ],
)
