/**
 * Whether a project is still within what it may cost.
 *
 * A budget is per period: the whole project for a fixed-price build, each
 * month for a retainer. Two measures -- money (labour at each entry's cost
 * rate, expenses, fixed fees) and hours -- each compared with its own limit,
 * and each judged against thresholds: 80% is a warning to act on while there
 * is still room, 100% is over.
 *
 * Pure, so the arithmetic is tested on its own and the screen, the sweep, and
 * the API agree.
 */

export type BudgetPeriod = 'total' | 'week' | 'month' | 'quarter' | 'year'
export type BudgetLevel = 'none' | 'ok' | 'warning' | 'over'

export const DEFAULT_THRESHOLDS = [80, 100] as const

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const parse = (date: string) => new Date(`${date}T00:00:00Z`)

/**
 * The budget period a date falls in, inclusive at both ends. Null for a
 * whole-project budget, which has no window: everything counts.
 *
 * Weeks start on Monday. Quarters and years are calendar ones.
 */
export function budgetWindow(period: BudgetPeriod, today: string): { from: string; to: string } | null {
  if (period === 'total') return null
  const d = parse(today)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  if (period === 'week') {
    const back = (d.getUTCDay() + 6) % 7
    const from = new Date(Date.UTC(y, m, d.getUTCDate() - back))
    const to = new Date(Date.UTC(y, m, d.getUTCDate() - back + 6))
    return { from: iso(from), to: iso(to) }
  }
  if (period === 'month') return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) }
  if (period === 'quarter') {
    const first = m - (m % 3)
    return { from: iso(new Date(Date.UTC(y, first, 1))), to: iso(new Date(Date.UTC(y, first + 3, 0))) }
  }
  return { from: `${y}-01-01`, to: `${y}-12-31` }
}

/** A share as a whole percentage, rounded down so 100% means all of it. Null when there is no limit. */
export function usedPercent(used: number, limit: number | null): number | null {
  if (limit === null) return null
  if (limit <= 0) return used > 0 ? 1000 : 0
  return Math.floor((used * 100) / limit)
}

export type BudgetInput = {
  budgetMinor: number | null
  costMinor: number
  /** Hours the work may take; null when there is no hours budget. */
  budgetHours: number | null
  loggedSeconds: number
  thresholds?: readonly number[]
}

export type BudgetStatus = {
  costPercent: number | null
  hoursPercent: number | null
  /** The worse of the two. */
  level: BudgetLevel
  /** Every threshold each measure has reached, lowest first. */
  crossed: Array<{ measure: 'cost' | 'hours'; threshold: number; percent: number }>
}

function levelOf(percent: number | null, thresholds: readonly number[]): BudgetLevel {
  if (percent === null) return 'none'
  const over = thresholds[thresholds.length - 1] ?? 100
  if (percent >= over) return 'over'
  if (thresholds.some((t) => t < over && percent >= t)) return 'warning'
  return 'ok'
}

const RANK: Record<BudgetLevel, number> = { none: 0, ok: 1, warning: 2, over: 3 }

export function budgetStatus(input: BudgetInput): BudgetStatus {
  const thresholds = [...(input.thresholds ?? DEFAULT_THRESHOLDS)].sort((a, b) => a - b)
  const costPercent = usedPercent(input.costMinor, input.budgetMinor)
  const hoursPercent = input.budgetHours === null ? null : usedPercent(input.loggedSeconds, Math.round(input.budgetHours * 3600))
  const crossed: BudgetStatus['crossed'] = []
  for (const [measure, percent] of [
    ['cost', costPercent],
    ['hours', hoursPercent],
  ] as const) {
    if (percent === null) continue
    for (const threshold of thresholds) if (percent >= threshold) crossed.push({ measure, threshold, percent })
  }
  const levels = [levelOf(costPercent, thresholds), levelOf(hoursPercent, thresholds)]
  const level = levels.reduce((worst, l) => (RANK[l] > RANK[worst] ? l : worst), 'none' as BudgetLevel)
  return { costPercent, hoursPercent, level, crossed }
}

/** The hours the project's tasks are estimated at, leaving out cancelled ones. */
export function estimatedHours(tasks: ReadonlyArray<{ estimateMinutes: number | null; status: string }>): number | null {
  const counted = tasks.filter((t) => t.status !== 'cancelled' && t.estimateMinutes !== null)
  if (counted.length === 0) return null
  return Math.round((counted.reduce((sum, t) => sum + (t.estimateMinutes ?? 0), 0) / 60) * 100) / 100
}
