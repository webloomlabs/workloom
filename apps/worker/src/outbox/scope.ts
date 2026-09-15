import { db, sql, type TenantTransaction } from '@workloom/db'

/**
 * The dispatcher's cross-organization scope.
 *
 * Sets `workloom.dispatcher`, which the policies in migration 0004 check. They
 * grant only what delivery needs: SELECT and UPDATE on events and endpoints,
 * SELECT, INSERT and UPDATE on deliveries -- never DELETE, and nothing on any
 * other table. The flag is transaction-local, and lint confines the string to
 * this directory.
 *
 * Anything that writes on behalf of an organization but does not need to see
 * across organizations should use withTenant() instead.
 */
export function withDispatcher<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('workloom.dispatcher', 'on', true)`)
    return fn(tx)
  })
}
