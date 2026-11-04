import { describe, expect, it } from 'vitest'
import { expenseCost } from './expense-cost.ts'
import { netOfTax } from './expenses.ts'

describe('what an expense cost', () => {
  it('is the net amount when the tax is claimed back, and the total when it is not', () => {
    expect(expenseCost({ amountMinor: 10_000, taxMinor: 1_800 }, true)).toBe(10_000)
    expect(expenseCost({ amountMinor: 10_000, taxMinor: 1_800 }, false)).toBe(11_800)
  })
})

describe('the net of a receipt total', () => {
  it('takes the tax out of a total that includes it, so the two add back up', () => {
    expect(netOfTax(11_800, '18')).toBe(10_000)
    expect(netOfTax(10_000, null)).toBe(10_000)
    // 4,350.00 at 18%: 3,686.44 net, and 663.56 is what is left for the tax.
    const net = netOfTax(435_000, '18')
    expect(net).toBe(368_644)
    expect(435_000 - net).toBe(66_356)
  })

  it('rounds half away from zero', () => {
    // 105 / 1.05 = 100 exactly; 1 / 1.1 = 0.909 → 1.
    expect(netOfTax(105, '5')).toBe(100)
    expect(netOfTax(1, '10')).toBe(1)
  })
})
