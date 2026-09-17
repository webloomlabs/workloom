import { addDays } from '../../time/index.ts'

/**
 * When a recurring schedule bills.
 *
 * Periods are computed from the start date by index, never by stepping from
 * the last one. That is what keeps a schedule anchored: one that starts on the
 * 31st bills 31 January, 28 February, 31 March -- stepping month by month from
 * the clamped February date would drift to the 28th and stay there for the rest
 * of the agreement, quietly shortening every period after it.
 *
 * All arithmetic is on calendar dates in UTC, so no time zone can move a
 * billing day.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type Interval = 'week' | 'month' | 'quarter' | 'year'

const MONTHS_PER: Record<Exclude<Interval, 'week'>, number> = { month: 1, quarter: 3, year: 12 }

/**
 * A calendar date moved by whole months, clamped to the end of the month it
 * lands in: 31 January plus one month is 28 February, not 3 March.
 */
export function addMonths(date: string, months: number): string {
  if (!ISO_DATE.test(date)) throw new RangeError(`Not a calendar date: ${date}`)
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.toISOString().slice(0, 10)
}

/** The day the `index`-th period starts, counting the first period as 0. */
export function periodStart(startOn: string, unit: Interval, count: number, index: number): string {
  if (index === 0) return startOn
  return unit === 'week' ? addDays(startOn, 7 * count * index) : addMonths(startOn, MONTHS_PER[unit] * count * index)
}

/** The last day the `index`-th period covers: the day before the next one starts. */
export function periodEnd(startOn: string, unit: Interval, count: number, index: number): string {
  return addDays(periodStart(startOn, unit, count, index + 1), -1)
}

/**
 * The period a date belongs to, or the one after the last that was billed.
 *
 * Used when a schedule is edited: moving the start date has to leave the
 * counter and the next run consistent with each other.
 */
export function periodIndexOf(startOn: string, unit: Interval, count: number, date: string): number {
  let index = 0
  // Schedules are measured in years, not centuries; the loop is bounded by the
  // longest agreement anyone could plausibly enter.
  while (index < 1200 && periodStart(startOn, unit, count, index + 1) <= date) index += 1
  return index
}
