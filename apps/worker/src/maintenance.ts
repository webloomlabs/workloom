import { pruneRateLimits } from '@workloom/core'
import { expireDueQuotes, generateDueInvoices, markOverdueInvoices, sweepExpiringAssets } from '@workloom/core/modules'
import { buildContext } from '@workloom/core/registry'
import { db, lt, schema, withTenant } from '@workloom/db'

/** Replays are honoured for a day; after that a key may be reused. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Periodic cleanup, and the state changes that happen with the passing of time:
 * quotes that have run out of validity, invoices that have gone past their due
 * date without being paid, retainers whose next period has arrived, and
 * domains and certificates approaching their renewal.
 *
 * Idempotency keys are tenant data, so they are pruned the documented way for
 * cross-organization work: enumerate organizations, then one tenant-scoped
 * transaction each. Hourly, that is cheap even for many organizations, and it
 * means the dispatcher's wider policy never needs to cover this table.
 */
export async function runMaintenance(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS)
  const organizations = await db.select({ id: schema.organization.id }).from(schema.organization)

  for (const { id } of organizations) {
    await withTenant(id, (tx) =>
      tx.delete(schema.idempotencyKeys).where(lt(schema.idempotencyKeys.createdAt, cutoff)),
    )
    // Each organization separately, so one failure cannot stop quotes expiring
    // or invoices going overdue elsewhere. Both are decided in the
    // organization's own time zone, which is what "today" means to it.
    await sweep(id, 'quote expiry', expireDueQuotes, 'expired %n quote(s)', now)
    await sweep(id, 'overdue invoices', markOverdueInvoices, 'swept %n invoice(s) past their due date', now)
    // Raises drafts only: nothing is issued or sent without a person.
    await sweep(id, 'recurring billing', generateDueInvoices, 'raised %n draft invoice(s) from schedules', now)
    await sweep(id, 'expiring infrastructure', sweepExpiringAssets, 'announced %n asset(s) approaching renewal', now)
  }

  await pruneRateLimits()
}

/** One organization's periodic state change, as a job actor, failing alone. */
async function sweep(
  organizationId: string,
  label: string,
  run: (ctx: ReturnType<typeof buildContext>) => Promise<number>,
  message: string,
  now: Date,
): Promise<void> {
  try {
    const changed = await withTenant(organizationId, (tx) =>
      run(buildContext({ organizationId, actor: { type: 'job', label }, role: null, permissions: new Set(), now }, tx)),
    )
    if (changed > 0) console.log(`worker: ${message.replace('%n', String(changed))} in ${organizationId}`)
  } catch (error) {
    console.error(`worker: ${label} failed in ${organizationId}`, error)
  }
}
