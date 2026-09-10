import { sql } from 'drizzle-orm'
import { db, type Database } from './client.ts'

/**
 * Tenant scoping.
 *
 * Row-level security is the actual boundary between organizations; this
 * module is how application code enters it. Every domain table has a policy
 * of the form:
 *
 *   USING (organization_id = current_setting('workloom.org_id', true)::uuid)
 *
 * so a query that forgets its organization predicate returns nothing rather
 * than returning another tenant's rows. That is the point: the failure mode of
 * a mistake is an empty result, not a data leak.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type TenantTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Runs `fn` inside a transaction scoped to one organization.
 *
 * The scope is set with `set_config(..., true)` -- the third argument makes it
 * transaction-local. A session-level `SET` would persist on the pooled
 * connection and leak this organization's scope into whichever request borrows
 * that connection next. That bug is silent, intermittent, and cross-tenant, so
 * the transaction-local form is not negotiable. It is also what makes this
 * design safe under PgBouncer transaction pooling.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (!UUID.test(organizationId)) {
    throw new TypeError(`withTenant: organizationId is not a UUID: ${organizationId}`)
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('workloom.org_id', ${organizationId}, true)`)
    return fn(tx)
  })
}

/**
 * Escape hatch for the few operations that are genuinely instance-wide.
 *
 * This exists because pretending it doesn't leads to worse things -- a
 * scattering of raw `db` imports, or a policy loosened to accommodate one job.
 * The rules:
 *
 *   - Cross-organization jobs enumerate organizations and run ONE withTenant
 *     transaction per organization. They do not query globally and filter in
 *     application code.
 *   - Every caller is named in docs/architecture.
 *   - There should be fewer than five of them.
 *
 * Each invocation is logged with its stack so the list stays honest.
 */
export async function withoutTenant<T>(reason: string, fn: (database: Database) => Promise<T>) {
  const stack = new Error().stack?.split('\n').slice(2, 5).join('\n') ?? '<no stack>'
  console.warn(`[withoutTenant] ${reason}\n${stack}`)
  return fn(db)
}

/**
 * Reads the organization scope of the current transaction. Returns null
 * outside one. Used by the isolation tests and the boot self-test.
 */
export async function currentTenant(tx: TenantTransaction | Database): Promise<string | null> {
  const result = await tx.execute<{ org_id: string | null }>(
    sql`select nullif(current_setting('workloom.org_id', true), '') as org_id`,
  )
  return result.rows[0]?.org_id ?? null
}
