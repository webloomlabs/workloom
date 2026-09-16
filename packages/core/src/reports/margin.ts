import { formatDecimal, roundDiv } from '../money/money.ts'

/**
 * The arithmetic a profit report rests on.
 *
 * Kept here, pure and integer-only, because these are the numbers someone
 * decides whether to keep a client on. A float would make them almost right,
 * which on a page about margin is worse than useless.
 *
 * Ratios come back as exact decimal strings, never floats, for the same reason
 * money does: the caller formats them, and nothing downstream can drift.
 */

/** Two decimal places, so "31.25" means 31.25%. */
const PERCENT_SCALE = 2

/**
 * `numerator ÷ denominator` as a percentage, rounded half away from zero.
 *
 * Null when the denominator is zero or negative: a share of nothing has no
 * value, and a share of a negative total reads backwards. The caller shows a
 * dash rather than a number nobody can act on.
 */
export function ratioPercent(numerator: number, denominator: number): string | null {
  if (denominator <= 0) return null
  return formatDecimal(roundDiv(BigInt(numerator) * 10_000n, BigInt(denominator)), PERCENT_SCALE)
}

/**
 * Margin as a share of revenue: what is left of every dollar billed.
 *
 * Of revenue rather than of cost, because that is what an agency quotes and
 * what a rate card is set against.
 */
export function marginPercent(marginMinor: number, billedMinor: number): string | null {
  return ratioPercent(marginMinor, billedMinor)
}

/** The share of tracked time that was billable. */
export function utilisationPercent(billableSeconds: number, totalSeconds: number): string | null {
  return ratioPercent(billableSeconds, totalSeconds)
}

/**
 * What an hour of tracked time actually earned, in minor units.
 *
 * Against every hour, billable or not: an agency's real rate is what the work
 * brought in divided by what it took, and unbillable hours are part of what it
 * took. Null when no time has been tracked.
 */
export function effectiveHourlyMinor(billedMinor: number, seconds: number): number | null {
  if (seconds <= 0) return null
  return Number(roundDiv(BigInt(billedMinor) * 3600n, BigInt(seconds)))
}

/** How much of a budget has been spent, where there is one to spend. */
export function budgetUsedPercent(costMinor: number, budgetMinor: number | null): string | null {
  return budgetMinor === null ? null : ratioPercent(costMinor, budgetMinor)
}
