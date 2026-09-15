import { pruneRateLimits } from '@workloom/core'
import { db, lt, schema, withTenant } from '@workloom/db'

/** Replays are honoured for a day; after that a key may be reused. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Periodic cleanup.
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
  }

  await pruneRateLimits()
}
