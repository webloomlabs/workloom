import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Rate-limit counters.
 *
 * Deliberately has NO organization_id. The key is an opaque string that
 * already encodes whatever the limit is scoped to, which keeps this an
 * infrastructure table rather than a tenant table -- it is written on the
 * authentication path, sometimes before an organization is known, and putting
 * it under row-level security would mean a policy consulted on every request
 * for no protective benefit.
 *
 * Postgres rather than Redis because Redis is optional in this deployment.
 * At agency scale a single upsert per request is not the bottleneck; when an
 * installation outgrows it, REDIS_URL switches the driver.
 */
export const rateLimits = pgTable('rate_limits', {
  /** e.g. `org:<uuid>:user:<uuid>:write` */
  key: text('key').primaryKey(),
  /** Start of the current fixed window. */
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
})
