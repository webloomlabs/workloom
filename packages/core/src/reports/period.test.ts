import { describe, expect, it } from 'vitest'
import { changePercent, daysBetween, periodEnd, periodRange, periodStart, previousPeriodStart } from './period.ts'

describe('where a period starts and ends', () => {
  it('runs a month from the first to the last', () => {
    expect(periodStart('month', '2026-09-16')).toBe('2026-09-01')
    expect(periodEnd('month', '2026-09-16')).toBe('2026-09-30')
  })

  it('knows February in a leap year and out of one', () => {
    expect(periodEnd('month', '2024-02-10')).toBe('2024-02-29')
    expect(periodEnd('month', '2026-02-10')).toBe('2026-02-28')
  })

  it('runs a quarter over its three months', () => {
    expect(periodStart('quarter', '2026-01-01')).toBe('2026-01-01')
    expect(periodStart('quarter', '2026-05-20')).toBe('2026-04-01')
    expect(periodStart('quarter', '2026-09-16')).toBe('2026-07-01')
    expect(periodStart('quarter', '2026-12-31')).toBe('2026-10-01')
    expect(periodEnd('quarter', '2026-09-16')).toBe('2026-09-30')
    expect(periodEnd('quarter', '2026-02-01')).toBe('2026-03-31')
  })

  it('runs a year from January to December', () => {
    expect(periodStart('year', '2026-09-16')).toBe('2026-01-01')
    expect(periodEnd('year', '2026-09-16')).toBe('2026-12-31')
  })

  it('steps back a whole period, across a year boundary', () => {
    expect(previousPeriodStart('month', '2026-09-16')).toBe('2026-08-01')
    expect(previousPeriodStart('month', '2026-01-09')).toBe('2025-12-01')
    expect(previousPeriodStart('quarter', '2026-01-09')).toBe('2025-10-01')
    expect(previousPeriodStart('year', '2026-01-09')).toBe('2025-01-01')
  })
})

describe('counting days', () => {
  it('counts both ends', () => {
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(1)
    expect(daysBetween('2026-09-01', '2026-09-16')).toBe(16)
  })

  it('is unmoved by daylight saving', () => {
    // Sydney moves its clocks on 5 October 2025; these are calendar days, not
    // 24-hour blocks, so the count does not blink.
    expect(daysBetween('2025-10-01', '2025-10-31')).toBe(31)
  })
})

describe('the period compared against', () => {
  it('compares like for like, not against a whole month', () => {
    // Six days into September against the first six days of August.
    const range = periodRange('month', '2026-09-06')
    expect(range).toEqual({ from: '2026-09-01', to: '2026-09-06', previousFrom: '2026-08-01', previousTo: '2026-08-06' })
  })

  it('never runs past the end of the period before', () => {
    // 31 days of March against the whole of February, not three days of March.
    const range = periodRange('month', '2026-03-31')
    expect(range.previousFrom).toBe('2026-02-01')
    expect(range.previousTo).toBe('2026-02-28')
  })

  it('compares a quarter with the quarter before it', () => {
    // 1 July to 15 August is 46 days; 46 days from 1 April is 16 May, because
    // April is shorter than July. Days elapsed, not the same date.
    const range = periodRange('quarter', '2026-08-15')
    expect(range).toEqual({ from: '2026-07-01', to: '2026-08-15', previousFrom: '2026-04-01', previousTo: '2026-05-16' })
  })

  it('compares a year with the year before it', () => {
    const range = periodRange('year', '2026-03-01')
    expect(range).toEqual({ from: '2026-01-01', to: '2026-03-01', previousFrom: '2025-01-01', previousTo: '2025-03-01' })
  })

  it('is a single day on the first of the month', () => {
    const range = periodRange('month', '2026-09-01')
    expect(range).toEqual({ from: '2026-09-01', to: '2026-09-01', previousFrom: '2026-08-01', previousTo: '2026-08-01' })
  })
})

describe('how far a figure has moved', () => {
  it('is the change measured against what it was', () => {
    expect(changePercent(150, 100)).toBe('50')
    expect(changePercent(50, 100)).toBe('-50')
    expect(changePercent(100, 100)).toBe('0')
  })

  it('reads a shrinking loss as an improvement', () => {
    // From 100 in the red to 50 in the red is better, not worse.
    expect(changePercent(-50, -100)).toBe('50')
    expect(changePercent(-150, -100)).toBe('-50')
  })

  it('has nothing to say without a baseline', () => {
    // A rise from nothing is not a percentage, and a card claiming one lies.
    expect(changePercent(500, 0)).toBeNull()
    expect(changePercent(0, 0)).toBeNull()
  })

  it('is exact to two places', () => {
    expect(changePercent(1, 3)).toBe('-66.67')
  })
})
