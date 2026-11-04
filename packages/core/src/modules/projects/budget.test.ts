import { describe, expect, it } from 'vitest'
import { budgetStatus, budgetWindow, estimatedHours, usedPercent } from './budget.ts'

describe('the budget window', () => {
  it('is everything for a whole-project budget', () => {
    expect(budgetWindow('total', '2026-11-03')).toBeNull()
  })

  it('is the month, quarter, year, or Monday-to-Sunday week the day falls in', () => {
    expect(budgetWindow('month', '2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(budgetWindow('month', '2028-02-29')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(budgetWindow('quarter', '2026-11-03')).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(budgetWindow('quarter', '2026-03-31')).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(budgetWindow('year', '2026-06-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    // 3 November 2026 is a Tuesday.
    expect(budgetWindow('week', '2026-11-03')).toEqual({ from: '2026-11-02', to: '2026-11-08' })
    // A Sunday belongs to the week that began the Monday before.
    expect(budgetWindow('week', '2026-11-08')).toEqual({ from: '2026-11-02', to: '2026-11-08' })
    // Across a year end.
    expect(budgetWindow('week', '2027-01-01')).toEqual({ from: '2026-12-28', to: '2027-01-03' })
  })
})

describe('budget status', () => {
  it('warns at 80% and is over at 100%, exactly', () => {
    expect(budgetStatus({ budgetMinor: 100_000, costMinor: 79_999, budgetHours: null, loggedSeconds: 0 }).level).toBe('ok')
    expect(budgetStatus({ budgetMinor: 100_000, costMinor: 80_000, budgetHours: null, loggedSeconds: 0 }).level).toBe('warning')
    expect(budgetStatus({ budgetMinor: 100_000, costMinor: 100_000, budgetHours: null, loggedSeconds: 0 }).level).toBe('over')
  })

  it('takes the worse of money and hours, and lists every threshold reached', () => {
    const status = budgetStatus({ budgetMinor: 100_000, costMinor: 50_000, budgetHours: 10, loggedSeconds: 10 * 3600 })
    expect(status).toMatchObject({ costPercent: 50, hoursPercent: 100, level: 'over' })
    expect(status.crossed).toEqual([
      { measure: 'hours', threshold: 80, percent: 100 },
      { measure: 'hours', threshold: 100, percent: 100 },
    ])
  })

  it('has nothing to say without a budget, and does not divide by a zero one', () => {
    expect(budgetStatus({ budgetMinor: null, costMinor: 5_000, budgetHours: null, loggedSeconds: 3600 })).toEqual({
      costPercent: null,
      hoursPercent: null,
      level: 'none',
      crossed: [],
    })
    expect(usedPercent(0, 0)).toBe(0)
    expect(usedPercent(1, 0)).toBe(1000)
    expect(budgetStatus({ budgetMinor: 0, costMinor: 1, budgetHours: null, loggedSeconds: 0 }).level).toBe('over')
  })
})

describe('estimated hours', () => {
  it('adds up the estimates, leaving out cancelled tasks and those not estimated', () => {
    expect(
      estimatedHours([
        { estimateMinutes: 90, status: 'todo' },
        { estimateMinutes: 30, status: 'done' },
        { estimateMinutes: 600, status: 'cancelled' },
        { estimateMinutes: null, status: 'todo' },
      ]),
    ).toBe(2)
    expect(estimatedHours([{ estimateMinutes: null, status: 'todo' }])).toBeNull()
  })
})
