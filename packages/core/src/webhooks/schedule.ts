/**
 * Retry schedule.
 *
 * One immediate attempt, then retries after these delays -- eight attempts over
 * roughly 21 hours. Long enough to ride out a receiver's deploy, an expired
 * certificate noticed the next morning, or a weekend outage of a small agency's
 * automation server; short enough that a dead endpoint stops consuming work.
 */
export const RETRY_DELAYS_SECONDS = [15, 60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600, 12 * 3600] as const

export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1

/**
 * After this many deliveries in a row exhaust every retry, the endpoint is
 * switched off and says why. Re-enabling it is one click once the receiver is
 * fixed.
 */
export const DISABLE_AFTER_CONSECUTIVE_FAILURES = 5

/**
 * Seconds to wait before the next attempt, given how many have been made, or
 * null when retries are exhausted.
 *
 * Jittered by up to +/-20% so that deliveries which failed together -- because
 * the receiver was down -- do not all retry in the same instant and knock it
 * over again as it comes back.
 */
export function nextRetryDelay(attemptsMade: number, random: () => number = Math.random): number | null {
  const base = RETRY_DELAYS_SECONDS[attemptsMade - 1]
  if (base === undefined) return null
  return Math.round(base * (0.8 + random() * 0.4))
}
