/**
 * Financial years.
 *
 * A financial year starts on the first of a configured month: January for a
 * calendar year, April for Sri Lanka's year of assessment or the UK's. Pure
 * calendar arithmetic on YYYY-MM-DD strings -- a date is already a date, so no
 * time zone can move it.
 */

export type FiscalYear = {
  /** The calendar year the financial year starts in. */
  startYear: number
  /** First and last day, inclusive. */
  from: string
  to: string
  /** "2025/26" when the year spans two calendar years, "2026" when it does not. */
  label: string
  /** "2025-26" or "2026", for document numbers and file names. */
  slug: string
}

const pad = (n: number) => String(n).padStart(2, '0')

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function assertStartMonth(startMonth: number): void {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new RangeError(`A financial year starts in a month from 1 to 12, not ${startMonth}.`)
  }
}

/** The financial year that starts in `startYear`. */
export function fiscalYearStarting(startYear: number, startMonth: number): FiscalYear {
  assertStartMonth(startMonth)
  const from = `${startYear}-${pad(startMonth)}-01`
  const endYear = startMonth === 1 ? startYear : startYear + 1
  const endMonth = startMonth === 1 ? 12 : startMonth - 1
  const to = `${endYear}-${pad(endMonth)}-${pad(lastDayOfMonth(endYear, endMonth))}`
  const label = startMonth === 1 ? String(startYear) : `${startYear}/${String(endYear).slice(-2)}`
  const slug = startMonth === 1 ? String(startYear) : `${startYear}-${String(endYear).slice(-2)}`
  return { startYear, from, to, label, slug }
}

/** The financial year a date falls in. */
export function fiscalYearOf(date: string, startMonth: number): FiscalYear {
  assertStartMonth(startMonth)
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  return fiscalYearStarting(month >= startMonth ? year : year - 1, startMonth)
}

/** Every financial year that overlaps the range, oldest first. */
export function fiscalYearsBetween(from: string, to: string, startMonth: number): FiscalYear[] {
  const years: FiscalYear[] = []
  for (let year = fiscalYearOf(from, startMonth); year.from <= to; year = fiscalYearStarting(year.startYear + 1, startMonth)) {
    years.push(year)
  }
  return years
}
