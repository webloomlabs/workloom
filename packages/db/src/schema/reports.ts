import { bigint, integer, pgView, text, uuid } from 'drizzle-orm/pg-core'

/**
 * What a project earned and what it cost.
 *
 * Declared here only so queries against it are typed; the view itself is
 * created by migrations 0018 and 0025, by hand, because `WITH (security_invoker = true)`
 * is a security boundary and must not depend on which version of drizzle-kit
 * ran -- the same reason the row-level-security policies are hand-written.
 * `.existing()` tells drizzle-kit to leave it alone.
 *
 * **One row per project and currency.** There is no rate to convert a time
 * entry at, so a project whose money spans currencies reports each currency
 * separately rather than inventing a conversion.
 *
 * Every figure is derived from what was stored at the time: time at the rate
 * each entry was logged at, revenue from the lines of issued invoices. Changing
 * a rate today cannot move any of it, which is the whole point of snapshotting
 * rates onto entries in the first place.
 */
export const projectFinancials = pgView('project_financials_v', {
  organizationId: uuid('organization_id').notNull(),
  projectId: uuid('project_id').notNull(),
  currency: text('currency').notNull(),

  /** Invoiced, excluding tax: what the agency keeps. Drafts and cancellations are not revenue. */
  billedMinor: bigint('billed_minor', { mode: 'number' }).notNull(),
  /** This project's share of what has been paid against the invoices it was billed on. */
  collectedMinor: bigint('collected_minor', { mode: 'number' }).notNull(),
  /** Billed less collected. */
  outstandingMinor: bigint('outstanding_minor', { mode: 'number' }).notNull(),

  /** Time at the cost rate each entry was logged at, rounded per entry. */
  labourCostMinor: bigint('labour_cost_minor', { mode: 'number' }).notNull(),
  /** Expenses net of tax, which is reclaimed. */
  expenseCostMinor: bigint('expense_cost_minor', { mode: 'number' }).notNull(),
  /** The part of that cost already rebilled to the client, and so also in `billedMinor`. */
  rebilledCostMinor: bigint('rebilled_cost_minor', { mode: 'number' }).notNull(),

  /** Billable time nobody has invoiced yet, at its billable rate: what is still to bill. */
  uninvoicedMinor: bigint('uninvoiced_minor', { mode: 'number' }).notNull(),
  /** Billed less labour, expenses and fixed fees. Work in progress is not counted until it is billed. */
  marginMinor: bigint('margin_minor', { mode: 'number' }).notNull(),

  billableSeconds: bigint('billable_seconds', { mode: 'number' }).notNull(),
  nonBillableSeconds: bigint('non_billable_seconds', { mode: 'number' }).notNull(),
  /** Entries with no cost rate: time the labour cost above cannot include. */
  entriesWithoutCostRate: integer('entries_without_cost_rate').notNull(),

  /**
   * Members engaged for a fixed fee rather than by the hour. Separate from
   * `labourCostMinor`, which stays hourly: their time is snapshotted at a cost
   * rate of zero, so the hours are visible and the money is counted once.
   */
  fixedCostMinor: bigint('fixed_cost_minor', { mode: 'number' }).notNull(),
  membersWithFixedFee: integer('members_with_fixed_fee').notNull(),
}).existing()
