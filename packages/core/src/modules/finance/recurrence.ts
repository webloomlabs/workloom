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

export type Period = { index: number; start: string; end: string }

/** The period with this index. */
export function periodAt(startOn: string, unit: Interval, count: number, index: number): Period {
  return { index, start: periodStart(startOn, unit, count, index), end: periodEnd(startOn, unit, count, index) }
}

/**
 * The first period at or after `fromIndex` that has not been billed, given the
 * start dates of those that have. After a rewind -- January deleted while
 * February stays billed -- the schedule bills January, then skips to March.
 */
export function nextUnbilledIndex(startOn: string, unit: Interval, count: number, fromIndex: number, billedStarts: ReadonlySet<string>): number {
  let index = fromIndex
  while (index < fromIndex + 1200 && billedStarts.has(periodStart(startOn, unit, count, index))) index += 1
  return index
}

/**
 * The next `n` unbilled periods from `fromIndex`, oldest first. Stops early at
 * `endOn`: a period starting after the agreement ends is not billed.
 */
export function unbilledPeriods(
  startOn: string,
  unit: Interval,
  count: number,
  fromIndex: number,
  n: number,
  billedStarts: ReadonlySet<string>,
  endOn: string | null = null,
): Period[] {
  const periods: Period[] = []
  let index = fromIndex
  while (periods.length < n) {
    index = nextUnbilledIndex(startOn, unit, count, index, billedStarts)
    const period = periodAt(startOn, unit, count, index)
    if (endOn && period.start > endOn) break
    periods.push(period)
    index += 1
  }
  return periods
}

/** How many more periods a schedule may bill under its occurrence limit. Null when there is none. */
export function remainingOccurrences(maxOccurrences: number | null, generatedCount: number): number | null {
  return maxOccurrences === null ? null : Math.max(0, maxOccurrences - generatedCount)
}

/** Whether these periods follow one another with no gap, so one line can state them as a single range. */
export function contiguous(periods: readonly Period[]): boolean {
  return periods.every((p, i) => i === 0 || p.index === periods[i - 1]!.index + 1)
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Whole calendar months a period covers, when it runs from a first of the month to a last; otherwise null. */
export function wholeMonths(start: string, end: string): number | null {
  const [sy, sm, sd] = start.split('-').map(Number) as [number, number, number]
  const [ey, em, ed] = end.split('-').map(Number) as [number, number, number]
  const lastDay = new Date(Date.UTC(ey, em, 0)).getUTCDate()
  if (sd !== 1 || ed !== lastDay) return null
  const months = (ey - sy) * 12 + (em - sm) + 1
  return months > 0 ? months : null
}

/**
 * A period in words: "Nov 2026", "Nov 2026 – Jan 2027", "Jan – Mar 2026", or
 * the two dates for a period that is not whole months.
 */
export function periodText(start: string, end: string, formatDate: (date: string) => string = (d) => d): string {
  const months = wholeMonths(start, end)
  const month = (d: string) => `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
  if (months === 1) return month(start)
  if (months !== null) {
    return start.slice(0, 4) === end.slice(0, 4) ? `${MONTH_NAMES[Number(start.slice(5, 7)) - 1]} – ${month(end)}` : `${month(start)} – ${month(end)}`
  }
  return `${formatDate(start)} – ${formatDate(end)}`
}
