import { describe, expect, it } from 'vitest'
import { budgetUsedPercent, effectiveHourlyMinor, marginPercent, ratioPercent, utilisationPercent } from './margin.ts'

describe('a ratio as a percentage', () => {
  it('is exact where a float would not be', () => {
    // 1/3 of 300.00 is exactly a third; the string says so to two places.
    expect(ratioPercent(10_000, 30_000)).toBe('33.33')
    expect(ratioPercent(1, 3)).toBe('33.33')
    expect(ratioPercent(2, 3)).toBe('66.67')
  })

  it('rounds half away from zero, as money does', () => {
    expect(ratioPercent(125, 10_000)).toBe('1.25')
    // 0.125% lands exactly halfway at two places and goes up.
    expect(ratioPercent(1, 800)).toBe('0.13')
    expect(ratioPercent(-1, 800)).toBe('-0.13')
  })

  it('drops trailing zeros rather than padding', () => {
    expect(ratioPercent(1, 2)).toBe('50')
    expect(ratioPercent(1, 8)).toBe('12.5')
    expect(ratioPercent(0, 100)).toBe('0')
  })

  it('has no answer for a share of nothing', () => {
    expect(ratioPercent(500, 0)).toBeNull()
    // Nor of a negative total, which would read backwards.
    expect(ratioPercent(500, -100)).toBeNull()
  })

  it('handles amounts beyond the exact range of a float', () => {
    expect(ratioPercent(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe('100')
  })
})

describe('margin', () => {
  it('is what is left of every dollar billed', () => {
    // Billed 1,000.00, cost 690.00: 31% margin.
    expect(marginPercent(310_00, 1000_00)).toBe('31')
  })

  it('is negative when the work cost more than it earned', () => {
    expect(marginPercent(-250_00, 1000_00)).toBe('-25')
  })

  it('has no answer before anything is billed', () => {
    // A project with cost and no invoice yet: the page shows a dash, not -infinity.
    expect(marginPercent(-500_00, 0)).toBeNull()
  })
})

describe('utilisation', () => {
  it('is the billable share of tracked time', () => {
    expect(utilisationPercent(6 * 3600, 8 * 3600)).toBe('75')
  })

  it('has no answer before any time is tracked', () => {
    expect(utilisationPercent(0, 0)).toBeNull()
  })
})

describe('what an hour actually earned', () => {
  it('counts every hour, billable or not', () => {
    // 1,000.00 billed over 10 hours tracked, of which some were not billable.
    expect(effectiveHourlyMinor(1000_00, 10 * 3600)).toBe(100_00)
  })

  it('rounds to the minor unit', () => {
    // 100.00 over 3 hours: 33.3333 an hour.
    expect(effectiveHourlyMinor(100_00, 3 * 3600)).toBe(33_33)
  })

  it('has no answer before any time is tracked', () => {
    expect(effectiveHourlyMinor(1000_00, 0)).toBeNull()
  })
})

describe('a budget', () => {
  it('is used up in proportion to what has been spent', () => {
    expect(budgetUsedPercent(750_00, 1000_00)).toBe('75')
    expect(budgetUsedPercent(1200_00, 1000_00)).toBe('120')
  })

  it('is absent when the project has none', () => {
    expect(budgetUsedPercent(750_00, null)).toBeNull()
  })
})
