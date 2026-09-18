import { describe, expect, it } from 'vitest'
import {
  addDays,
  applyFixedFee,
  dateIn,
  formatDuration,
  formatElapsed,
  parseDuration,
  resolveRates,
  secondsToHours,
  valueOf,
  weekDays,
  weekStart,
} from './index.ts'

describe('parseDuration', () => {
  it.each([
    ['1:30', 5400],
    ['0:05', 300],
    ['1.5', 5400],
    ['1,5', 5400],
    ['.25', 900],
    ['2h', 7200],
    ['1.5 hours', 5400],
    ['90m', 5400],
    ['45 min', 2700],
    ['1h 30m', 5400],
    ['1h30', 5400],
    ['  3  ', 10800],
  ])('reads %j as %i seconds', (input, seconds) => {
    expect(parseDuration(input)).toBe(seconds)
  })

  it.each(['', 'abc', '1:75', '1:3', '-1', '1h-30m', '1..5'])('refuses %j', (input) => {
    expect(parseDuration(input)).toBeNull()
  })
})

describe('formatting', () => {
  it('shows hours and minutes, rounded to the minute', () => {
    expect(formatDuration(5400)).toBe('1:30')
    expect(formatDuration(29)).toBe('0:00')
    expect(formatDuration(30)).toBe('0:01')
    expect(formatDuration(36_000)).toBe('10:00')
  })

  it('shows a running timer to the second', () => {
    expect(formatElapsed(3725)).toBe('1:02:05')
    expect(formatElapsed(-4)).toBe('0:00:00')
  })

  it('converts to decimal hours', () => {
    expect(secondsToHours(5400)).toBe(1.5)
    expect(secondsToHours(1200)).toBe(0.33)
  })
})

describe('calendar weeks', () => {
  it('start on Monday', () => {
    expect(weekStart('2026-09-14')).toBe('2026-09-14') // Monday
    expect(weekStart('2026-09-20')).toBe('2026-09-14') // Sunday
    expect(weekStart('2026-09-15')).toBe('2026-09-14')
    expect(weekStart('2027-01-01')).toBe('2026-12-28') // across a year
  })

  it('list seven days', () => {
    expect(weekDays('2026-03-01')).toEqual(['2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01'])
  })

  it('move by calendar days, unaffected by daylight saving', () => {
    expect(addDays('2026-10-04', 1)).toBe('2026-10-05')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(() => addDays('14/09/2026', 1)).toThrow(RangeError)
  })

  it('find the local date of an instant', () => {
    const instant = new Date('2026-09-14T13:30:00Z')
    expect(dateIn(instant, 'UTC')).toBe('2026-09-14')
    expect(dateIn(instant, 'Pacific/Auckland')).toBe('2026-09-15')
    expect(dateIn(instant, 'America/Los_Angeles')).toBe('2026-09-14')
  })
})

describe('resolveRates', () => {
  const level = (billableRateMinor: number | null, costRateMinor: number | null) => ({ billableRateMinor, costRateMinor })

  it('prefers the project override, then the person, then the organization', () => {
    expect(resolveRates({ project_member: level(200_00, 90_00), member: level(150_00, 80_00), organization: level(120_00, 60_00) })).toEqual({
      billableRateMinor: 200_00,
      billableRateSource: 'project_member',
      costRateMinor: 90_00,
      costRateSource: 'project_member',
    })
    expect(resolveRates({ member: level(150_00, 80_00), organization: level(120_00, 60_00) })).toMatchObject({
      billableRateSource: 'member',
      costRateSource: 'member',
    })
    expect(resolveRates({ organization: level(120_00, 60_00) })).toMatchObject({ billableRateMinor: 120_00, costRateMinor: 60_00 })
  })

  it('resolves billable and cost independently', () => {
    expect(resolveRates({ project_member: level(200_00, null), member: level(null, 80_00), organization: level(120_00, 60_00) })).toEqual({
      billableRateMinor: 200_00,
      billableRateSource: 'project_member',
      costRateMinor: 80_00,
      costRateSource: 'member',
    })
  })

  it('treats zero as a rate, not as missing', () => {
    expect(resolveRates({ project_member: level(0, null), organization: level(120_00, 60_00) })).toMatchObject({
      billableRateMinor: 0,
      billableRateSource: 'project_member',
    })
  })

  it('leaves a rate unset when nothing defines it', () => {
    expect(resolveRates({})).toEqual({ billableRateMinor: null, billableRateSource: null, costRateMinor: null, costRateSource: null })
  })
})

describe('applyFixedFee', () => {
  const snapshot = {
    billableRateMinor: 200_00,
    billableRateSource: 'project_member' as const,
    costRateMinor: 90_00,
    costRateSource: 'project_member' as const,
  }

  it('leaves an hourly member alone', () => {
    expect(applyFixedFee(snapshot, null)).toEqual(snapshot)
  })

  it('costs a fixed-fee member nothing per hour, and says why', () => {
    expect(applyFixedFee(snapshot, 4_000_00)).toEqual({
      billableRateMinor: 200_00,
      billableRateSource: 'project_member',
      costRateMinor: 0,
      costRateSource: 'project_member_fixed',
    })
  })

  it('never touches what the client is charged', () => {
    // The fee is what the person costs us. It says nothing about the price.
    expect(applyFixedFee(snapshot, 4_000_00).billableRateMinor).toBe(200_00)
    expect(applyFixedFee({ ...snapshot, billableRateMinor: null, billableRateSource: null }, 4_000_00)).toMatchObject({
      billableRateMinor: null,
      billableRateSource: null,
    })
  })

  it('applies to a fee of zero, which is a fee and not an absence', () => {
    expect(applyFixedFee(snapshot, 0)).toMatchObject({ costRateMinor: 0, costRateSource: 'project_member_fixed' })
  })

  it('overrides a cost rate that had resolved from anywhere', () => {
    const fromOrg = { ...snapshot, costRateMinor: 60_00, costRateSource: 'organization' as const }
    expect(applyFixedFee(fromOrg, 4_000_00)).toMatchObject({ costRateMinor: 0, costRateSource: 'project_member_fixed' })
    const unset = { ...snapshot, costRateMinor: null, costRateSource: null }
    expect(applyFixedFee(unset, 4_000_00)).toMatchObject({ costRateMinor: 0, costRateSource: 'project_member_fixed' })
  })
})

describe('valueOf', () => {
  it('prices time at an hourly rate, rounding once per entry', () => {
    expect(valueOf(3600, 150_00)).toBe(150_00)
    expect(valueOf(1200, 100_00)).toBe(33_33)
    expect(valueOf(2400, 100_00)).toBe(66_67)
    // Exactly half a minor unit rounds away from zero.
    expect(valueOf(18, 100)).toBe(1) // 0.5
    expect(valueOf(0, 150_00)).toBe(0)
  })
})
