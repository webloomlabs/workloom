/**
 * Durations, calendar days, and rate resolution for time tracking.
 *
 * Pure functions with no database or server imports, so client components
 * (the running timer in the header) can use them too.
 */

/** The longest single entry a person can log by hand. */
export const MAX_ENTRY_SECONDS = 24 * 60 * 60

/**
 * A duration typed by a person, in seconds. Null when it cannot be read.
 *
 * Accepts "1:30", "1.5", "1,5", "1.5h", "90m", "90 min", "1h 30m", and
 * "1h30". A bare number is hours, as on a paper timesheet.
 */
export function parseDuration(input: string): number | null {
  const value = input.trim().toLowerCase().replace(',', '.')
  if (value === '') return null

  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(value)
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60

  const hours = /^(\d+(?:\.\d+)?|\.\d+)\s*(?:h|hr|hrs|hours?)?$/.exec(value)
  if (hours) return Math.round(Number(hours[1]) * 3600)

  const minutes = /^(\d+)\s*(?:m|min|mins|minutes?)$/.exec(value)
  if (minutes) return Number(minutes[1]) * 60

  const both = /^(\d+)\s*(?:h|hr|hrs|hours?)\s*(\d+)\s*(?:m|min|mins|minutes?)?$/.exec(value)
  if (both) return Number(both[1]) * 3600 + Number(both[2]) * 60

  return null
}

/** Seconds as "h:mm", rounded to the nearest minute. */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

/** Seconds as "h:mm:ss", for a running timer. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** Seconds as decimal hours, to two places: 5400 is 1.5. */
export function secondsToHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function dateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
}

/** A calendar date moved by whole days. Calendar arithmetic, so no time zone can shift it. */
export function addDays(date: string, days: number): string {
  if (!ISO_DATE.test(date)) throw new RangeError(`Not a calendar date: ${date}`)
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The Monday on or before a calendar date. Timesheet weeks run Monday to Sunday. */
export function weekStart(date: string): string {
  if (!ISO_DATE.test(date)) throw new RangeError(`Not a calendar date: ${date}`)
  const day = new Date(`${date}T00:00:00Z`).getUTCDay() // 0 is Sunday
  return addDays(date, -((day + 6) % 7))
}

/** The seven dates of the week containing `date`, Monday first. */
export function weekDays(date: string): string[] {
  const monday = weekStart(date)
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}

export type RateLevel = { billableRateMinor: number | null; costRateMinor: number | null }
export type RateSource = 'project_member' | 'member' | 'organization'

export type RateSnapshot = {
  billableRateMinor: number | null
  billableRateSource: RateSource | null
  costRateMinor: number | null
  costRateSource: RateSource | null
}

/**
 * The rates an entry takes, most specific first: the person's override on the
 * project, then their own default, then the organization's.
 *
 * Billable and cost resolve independently. A project override that sets only
 * a billable rate still takes its cost from the person's default -- an
 * override is a statement about one number, not both.
 */
export function resolveRates(levels: { project_member?: RateLevel | undefined; member?: RateLevel | undefined; organization?: RateLevel | undefined }): RateSnapshot {
  const order: RateSource[] = ['project_member', 'member', 'organization']
  const pick = (field: keyof RateLevel) => {
    for (const source of order) {
      const value = levels[source]?.[field]
      if (value !== null && value !== undefined) return { value, source }
    }
    return { value: null, source: null }
  }
  const billable = pick('billableRateMinor')
  const cost = pick('costRateMinor')
  return {
    billableRateMinor: billable.value,
    billableRateSource: billable.source,
    costRateMinor: cost.value,
    costRateSource: cost.source,
  }
}

/**
 * What a stretch of time is worth at an hourly rate, in minor units. Rounded
 * half away from zero, once per entry: 20 minutes at 100.00/h is 33.33.
 */
export function valueOf(seconds: number, hourlyRateMinor: number): number {
  const exact = (seconds * hourlyRateMinor) / 3600
  return Math.sign(exact) * Math.round(Math.abs(exact))
}
