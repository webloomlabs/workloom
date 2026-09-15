import { db, sql } from '@workloom/db'
import type { RateLimitClass } from './registry/types.ts'

/**
 * Fixed-window rate limiting.
 *
 * A fixed window can allow up to twice the nominal rate across a window
 * boundary. That is a known and accepted imprecision: the purpose here is to
 * stop runaway scripts and brute-force attempts, not to meter billing, and a
 * sliding window costs more storage and complexity than that buys.
 */

export type RateLimitDecision = {
  allowed: boolean
  limit: number
  remaining: number
  /** Seconds until the current window resets. */
  resetSeconds: number
}

const WINDOW_MS = 60_000

/** Requests per minute. Generous by default; tighten via configuration later. */
const LIMITS: Record<RateLimitClass | 'auth', number> = {
  read: 600,
  write: 120,
  /** PDF rendering, exports, outbound email. */
  expensive: 20,
  /** Sign-in and password reset, keyed by IP and email rather than by actor. */
  auth: 10,
}

export function rateLimitKey(parts: {
  organizationId?: string | undefined
  actorId: string
  klass: RateLimitClass | 'auth'
}): string {
  return `org:${parts.organizationId ?? 'none'}:actor:${parts.actorId}:${parts.klass}`
}

/**
 * Counts one request against a key.
 *
 * The upsert is a single statement so that concurrent requests cannot both
 * read a stale count and write the same value -- a read-then-write here would
 * let the limit be exceeded under exactly the load it exists to control.
 */
export async function consumeRateLimit(
  key: string,
  klass: RateLimitClass | 'auth',
  now = new Date(),
): Promise<RateLimitDecision> {
  const limit = LIMITS[klass]
  const windowStart = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS)

  const { rows } = await db.execute<{ count: number }>(sql`
    insert into rate_limits (key, window_start, count)
    values (${key}, ${windowStart.toISOString()}, 1)
    on conflict (key) do update set
      count = case
        when rate_limits.window_start = excluded.window_start then rate_limits.count + 1
        else 1
      end,
      window_start = excluded.window_start
    returning count
  `)

  const count = rows[0]?.count ?? 1
  const resetSeconds = Math.ceil((windowStart.getTime() + WINDOW_MS - now.getTime()) / 1000)

  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetSeconds,
  }
}

/**
 * Removes windows that have long since passed.
 *
 * Without this the table grows one row per distinct key forever. Runs from the
 * scheduled-job worker; safe to call at any time.
 */
export async function pruneRateLimits(olderThan = new Date(Date.now() - 3600_000)): Promise<void> {
  await db.execute(sql`delete from rate_limits where window_start < ${olderThan.toISOString()}`)
}
