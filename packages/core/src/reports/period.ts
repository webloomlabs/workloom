import { addDays } from '../time/index.ts'
import { ratioPercent } from './margin.ts'

/**
 * The span a dashboard figure covers, and the span it is compared against.
 *
 * Calendar arithmetic on date strings, never on instants: a period is a run of
 * calendar days in the organization's time zone, and a `Date` would drag the
 * viewer's own zone into it.
 *
 * The comparison is **like for like**. Six days into September, revenue is
 * compared with the first six days of August, not with the whole of it --
 * otherwise every month looks like a collapse until the last day of it.
 */

export const PERIODS = ['month', 'quarter', 'year'] as const
export type Period = (typeof PERIODS)[number]

export type PeriodRange = {
  /** The period so far: its first day, through today. */
  from: string
  to: string
  /** The same number of days into the period before, so the two are comparable. */
  previousFrom: string
  previousTo: string
}

const parts = (date: string) => date.split('-').map(Number) as [number, number, number]
const iso = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

/** The first day of the period containing `date`. */
export function periodStart(period: Period, date: string): string {
  const [year, month] = parts(date)
  if (period === 'year') return iso(year, 1, 1)
  if (period === 'quarter') return iso(year, month - ((month - 1) % 3), 1)
  return iso(year, month, 1)
}

/** The last day of the period containing `date`. */
export function periodEnd(period: Period, date: string): string {
  const [year, month] = parts(date)
  if (period === 'year') return iso(year, 12, 31)
  const lastMonth = period === 'quarter' ? month + 2 - ((month - 1) % 3) : month
  // Day zero of the next month is the last day of this one, leap years included.
  return new Date(Date.UTC(year, lastMonth, 0)).toISOString().slice(0, 10)
}

/** The first day of the period before the one containing `date`. */
export function previousPeriodStart(period: Period, date: string): string {
  const start = periodStart(period, date)
  return periodStart(period, addDays(start, -1))
}

/** Whole days from `from` to `to`, counting both ends. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.floor(ms / 86_400_000) + 1
}

/**
 * The period to date, and the equivalent run of days in the period before it.
 *
 * The comparison span is clipped to the previous period: 31 days into March
 * compares against the whole of February, not against three days of March.
 */
export function periodRange(period: Period, today: string): PeriodRange {
  const from = periodStart(period, today)
  const previousFrom = previousPeriodStart(period, today)
  const elapsed = daysBetween(from, today)
  const previousEnd = periodEnd(period, previousFrom)
  const previousTo = addDays(previousFrom, elapsed - 1)
  return {
    from,
    to: today,
    previousFrom,
    previousTo: previousTo > previousEnd ? previousEnd : previousTo,
  }
}

/**
 * How far a figure has moved against the one before it, as a percentage.
 *
 * Null when there is nothing to compare against: a rise from nothing is not a
 * percentage, and a card showing one would be lying about having a baseline.
 * Measured against the size of the previous figure, so a loss shrinking from
 * 100 to 50 reads as an improvement of 50%, not of −50%.
 */
export function changePercent(current: number, previous: number): string | null {
  if (previous === 0) return null
  return ratioPercent(current - previous, Math.abs(previous))
}
