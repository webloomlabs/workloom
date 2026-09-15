import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { allocate, apportion, convert, formatDecimal, MoneyError, multiplyByRational, parseDecimal, percentage, roundDiv } from './money.ts'

describe('roundDiv', () => {
  it('rounds half away from zero', () => {
    expect(roundDiv(5n, 2n)).toBe(3n)
    expect(roundDiv(-5n, 2n)).toBe(-3n)
    expect(roundDiv(4n, 3n)).toBe(1n)
    expect(roundDiv(-4n, 3n)).toBe(-1n)
    expect(roundDiv(7n, -2n)).toBe(-4n)
    expect(() => roundDiv(1n, 0n)).toThrow(RangeError)
  })

  it('is symmetric in sign, for any fraction', () => {
    fc.assert(fc.property(fc.bigInt(), fc.bigInt({ min: 1n, max: 10n ** 12n }), (n, d) => {
      expect(roundDiv(-n, d)).toBe(-roundDiv(n, d))
    }))
  })

  it('stays within half a unit of the exact quotient', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), (n, d) => {
        const error = roundDiv(n, d) * d - n
        expect(2n * (error < 0n ? -error : error) <= d).toBe(true)
      }),
    )
  })
})

describe('decimals', () => {
  it('parse exactly and format in shortest form', () => {
    expect(parseDecimal('7.33', 4)).toBe(73300n)
    expect(parseDecimal('-0.5', 4)).toBe(-5000n)
    expect(parseDecimal('.25', 4)).toBe(2500n)
    expect(parseDecimal('007', 4)).toBe(70000n)
    expect(formatDecimal(73300n, 4)).toBe('7.33')
    expect(formatDecimal(-5000n, 4)).toBe('-0.5')
    expect(formatDecimal(100000n, 4)).toBe('10')
  })

  it.each(['', '-', '.', 'abc', '1e5', '1,5', '1.2.3', ' - 1'])('refuse %j', (value) => {
    expect(() => parseDecimal(value, 4)).toThrow(MoneyError)
  })

  it('round-trip', () => {
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 14n), max: 10n ** 14n }), (n) => {
      expect(parseDecimal(formatDecimal(n, 4), 4)).toBe(n)
    }))
  })
})

describe('percentage and multiplyByRational', () => {
  it('price exactly', () => {
    expect(percentage(10000n, '8.875')).toBe(888n)
    expect(percentage(999n, '12.5')).toBe(125n)
    expect(multiplyByRational(15000n, 73300n, 10000n)).toBe(109950n)
    expect(() => percentage(1n, '100.5')).toThrow(MoneyError)
  })
})

describe('allocate', () => {
  it('splits a remainder to the earliest largest shares', () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n])
    expect(allocate(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n])
    expect(allocate(10n, [0n, 0n])).toEqual([5n, 5n])
    expect(allocate(0n, [])).toEqual([])
    expect(allocate(5n, [3n, 0n, 1n])).toEqual([4n, 0n, 1n])
    expect(() => allocate(1n, [1n, -1n])).toThrow(RangeError)
  })

  const weights = fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { minLength: 1, maxLength: 30 })

  it('always sums exactly to the total', () => {
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), weights, (total, w) => {
      expect(allocate(total, w).reduce((s, p) => s + p, 0n)).toBe(total)
    }))
  })

  it('gives each share within one unit of its exact proportion', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), weights, (total, w) => {
      const sum = w.reduce((s, x) => s + x, 0n)
      const effective = sum === 0n ? w.map(() => 1n) : w
      const denominator = sum === 0n ? BigInt(w.length) : sum
      allocate(total, w).forEach((part, i) => {
        const error = part * denominator - total * effective[i]!
        expect((error < 0n ? -error : error) < denominator).toBe(true)
      })
    }))
  })

  it('never gives a zero weight anything, unless every weight is zero', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), weights, (total, w) => {
      if (w.every((x) => x === 0n)) return
      allocate(total, w).forEach((part, i) => {
        if (w[i] === 0n) expect(part).toBe(0n)
        else expect(part >= 0n).toBe(true)
      })
    }))
  })
})

describe('apportion', () => {
  it('handles shares of mixed sign', () => {
    // Exact shares 10 and -10 of a zero total.
    expect(apportion(0n, [100n, -100n], 10n)).toEqual([10n, -10n])
    // Exact shares -100.5 of -101.
    expect(apportion(-101n, [-1005n], 10n)).toEqual([-101n])
  })

  it('refuses a total that is not a rounding of the shares', () => {
    expect(() => apportion(10n, [10n, 10n], 10n)).toThrow(RangeError)
  })
})

describe('convert', () => {
  it('converts between currencies with different minor units', () => {
    expect(convert(100000n, 'USD', 'AUD', '1.5')).toBe(150000n)
    expect(convert(1000n, 'JPY', 'AUD', '0.0105')).toBe(1050n) // 1000 yen = 10.50 AUD
    expect(convert(1050n, 'AUD', 'JPY', '95.23809524')).toBe(1000n)
    expect(convert(12345n, 'KWD', 'AUD', '4.9')).toBe(6049n) // 12.345 KWD = 60.4905 AUD -> 60.49
    expect(convert(333n, 'AUD', 'AUD', '1')).toBe(333n)
  })

  it('refuses a rate that is zero, negative, or too precise', () => {
    for (const rate of ['0', '-1', '1.123456789']) expect(() => convert(1n, 'AUD', 'USD', rate)).toThrow(MoneyError)
  })
})
