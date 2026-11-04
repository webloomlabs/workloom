import { describe, expect, it } from 'vitest'
import { addMonths, periodEnd, periodIndexOf, periodStart } from './recurrence.ts'

describe('addMonths', () => {
  it('keeps the day where the month is long enough', () => {
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15')
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15')
  })

  it('clamps to the end of a shorter month rather than spilling into the next', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30')
  })

  it('goes backwards', () => {
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
  })
})

describe('periods', () => {
  it('anchors on the start date instead of drifting', () => {
    // The whole reason periods are computed by index: stepping from February's
    // clamped date would leave every later period starting on the 28th.
    const starts = [0, 1, 2, 3].map((i) => periodStart('2026-01-31', 'month', 1, i))
    expect(starts).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })

  it('ends the day before the next period starts', () => {
    expect(periodEnd('2026-01-01', 'month', 1, 0)).toBe('2026-01-31')
    expect(periodEnd('2026-01-01', 'quarter', 1, 0)).toBe('2026-03-31')
    expect(periodEnd('2026-01-01', 'year', 1, 0)).toBe('2026-12-31')
    expect(periodEnd('2026-01-05', 'week', 2, 0)).toBe('2026-01-18')
  })

  it('counts several units at a time', () => {
    expect(periodStart('2026-01-01', 'month', 3, 2)).toBe('2026-07-01')
    expect(periodStart('2026-01-01', 'week', 2, 3)).toBe('2026-02-12')
  })

  it('finds which period a date falls in', () => {
    expect(periodIndexOf('2026-01-01', 'month', 1, '2026-01-01')).toBe(0)
    expect(periodIndexOf('2026-01-01', 'month', 1, '2026-01-31')).toBe(0)
    expect(periodIndexOf('2026-01-01', 'month', 1, '2026-02-01')).toBe(1)
    expect(periodIndexOf('2026-01-01', 'month', 1, '2026-12-31')).toBe(11)
  })
})

describe('several periods at once', () => {
  it('finds the next unbilled period, stepping over ones already billed', async () => {
    const { nextUnbilledIndex, periodStart } = await import('./recurrence.ts')
    const billed = new Set([periodStart('2026-01-31', 'month', 1, 1)]) // February billed out of turn
    expect(nextUnbilledIndex('2026-01-31', 'month', 1, 0, billed)).toBe(0)
    expect(nextUnbilledIndex('2026-01-31', 'month', 1, 1, billed)).toBe(2)
  })

  it('lists the next n unbilled periods, anchored, and stops at the end date', async () => {
    const { unbilledPeriods, contiguous } = await import('./recurrence.ts')
    const three = unbilledPeriods('2026-01-31', 'month', 1, 0, 3, new Set())
    expect(three.map((p) => [p.start, p.end])).toEqual([
      ['2026-01-31', '2026-02-27'],
      ['2026-02-28', '2026-03-30'],
      ['2026-03-31', '2026-04-29'],
    ])
    expect(contiguous(three)).toBe(true)

    const gapped = unbilledPeriods('2026-01-01', 'month', 1, 0, 3, new Set(['2026-02-01']))
    expect(gapped.map((p) => p.start)).toEqual(['2026-01-01', '2026-03-01', '2026-04-01'])
    expect(contiguous(gapped)).toBe(false)

    expect(unbilledPeriods('2026-01-01', 'month', 1, 0, 6, new Set(), '2026-02-15').map((p) => p.start)).toEqual(['2026-01-01', '2026-02-01'])
  })

  it('counts what is left under an occurrence limit', async () => {
    const { remainingOccurrences } = await import('./recurrence.ts')
    expect(remainingOccurrences(null, 40)).toBeNull()
    expect(remainingOccurrences(12, 10)).toBe(2)
    expect(remainingOccurrences(12, 14)).toBe(0)
  })

  it('states a period in words', async () => {
    const { periodText, wholeMonths } = await import('./recurrence.ts')
    expect(periodText('2026-11-01', '2026-11-30')).toBe('Nov 2026')
    expect(periodText('2026-01-01', '2026-03-31')).toBe('Jan – Mar 2026')
    expect(periodText('2026-11-01', '2027-01-31')).toBe('Nov 2026 – Jan 2027')
    expect(periodText('2026-01-31', '2026-02-27')).toBe('2026-01-31 – 2026-02-27')
    expect(wholeMonths('2026-02-01', '2026-02-28')).toBe(1)
    expect(wholeMonths('2026-01-15', '2026-02-14')).toBeNull()
  })
})
