import { describe, expect, it } from 'vitest'
import { quoteSplit } from './quote-split.ts'

const line = (billingType: string | null, netMinor: number, interval: [string, number] | null = null, documentDiscountMinor = 0) => ({
  billingType,
  intervalUnit: interval?.[0] ?? null,
  intervalCount: interval?.[1] ?? null,
  netMinor,
  documentDiscountMinor,
  totalMinor: netMinor - documentDiscountMinor,
})

describe('splitting a quote', () => {
  it('separates the one-time price from each recurring part', () => {
    const split = quoteSplit([
      line('one_off', 65_000_00),
      line(null, 5_000_00),
      line('recurring', 4_000_00, ['month', 1]),
      line('recurring', 1_000_00, ['month', 1]),
      line('recurring', 12_000_00, ['year', 1]),
    ])
    expect(split.oneTimeNetMinor).toBe(70_000_00)
    expect(split.recurring.map((r) => [r.unit, r.count, r.perPeriodNetMinor, r.lines.length])).toEqual([
      ['month', 1, 5_000_00, 2],
      ['year', 1, 12_000_00, 1],
    ])
  })

  it('takes the document discount out of what becomes the contract', () => {
    expect(quoteSplit([line('one_off', 10_000, null, 1_000)]).oneTimeNetMinor).toBe(9_000)
  })

  it('treats a recurring line with no interval as one-time, since it cannot be scheduled', () => {
    expect(quoteSplit([line('recurring', 500)]).oneTimeNetMinor).toBe(500)
  })
})
