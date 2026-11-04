/**
 * What a quote is for: a one-time price, and what recurs.
 *
 * A web build with a monthly care plan is quoted on one page, but the two
 * parts go different ways once accepted -- the one-time part becomes the
 * project's contract and billing plan, each recurring part a billing
 * schedule. Pure, so the split shown on the quote, printed on its PDF, and
 * applied on acceptance are one and the same.
 */

export type SplitLine = {
  billingType: string | null
  intervalUnit: string | null
  intervalCount: number | null
  /** What the line is worth before tax, after every discount: what the agency keeps. */
  netMinor: number
  documentDiscountMinor: number
  totalMinor: number
}

export type RecurringPart<L> = {
  unit: 'week' | 'month' | 'quarter' | 'year'
  count: number
  lines: L[]
  /** Each period, before tax. */
  perPeriodNetMinor: number
}

export type QuoteSplit<L> = {
  oneTime: L[]
  /** The one-time part before tax: what becomes the contract value. */
  oneTimeNetMinor: number
  oneTimeTotalMinor: number
  recurring: Array<RecurringPart<L>>
}

export function quoteSplit<L extends SplitLine>(lines: readonly L[]): QuoteSplit<L> {
  const oneTime: L[] = []
  const recurring = new Map<string, RecurringPart<L>>()
  for (const line of lines) {
    if (line.billingType === 'recurring' && line.intervalUnit && line.intervalCount) {
      const key = `${line.intervalUnit}:${line.intervalCount}`
      const part = recurring.get(key) ?? { unit: line.intervalUnit as RecurringPart<L>['unit'], count: line.intervalCount, lines: [], perPeriodNetMinor: 0 }
      part.lines.push(line)
      part.perPeriodNetMinor += line.netMinor - line.documentDiscountMinor
      recurring.set(key, part)
    } else {
      oneTime.push(line)
    }
  }
  return {
    oneTime,
    oneTimeNetMinor: oneTime.reduce((sum, l) => sum + l.netMinor - l.documentDiscountMinor, 0),
    oneTimeTotalMinor: oneTime.reduce((sum, l) => sum + l.totalMinor, 0),
    recurring: [...recurring.values()],
  }
}
