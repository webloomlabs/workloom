import { describe, expect, it } from 'vitest'
import {
  AmountFormatError,
  currencyExponent,
  formatAmount,
  isCurrencyCode,
  minorToDecimalString,
  parseAmount,
} from './currency.ts'

describe('currency exponents', () => {
  it('knows the currencies that break naive /100 code', () => {
    expect(currencyExponent('AUD')).toBe(2)
    expect(currencyExponent('JPY')).toBe(0)
    expect(currencyExponent('KWD')).toBe(3)
  })

  it('recognises only real codes', () => {
    expect(isCurrencyCode('AUD')).toBe(true)
    expect(isCurrencyCode('aud')).toBe(false)
    expect(isCurrencyCode('XYZ')).toBe(false)
  })
})

describe('parseAmount', () => {
  it.each([
    ['12500.50', 'AUD', 1250050],
    ['12,500.5', 'AUD', 1250050],
    ['12 500', 'AUD', 1250000],
    ['.5', 'AUD', 50],
    ['0', 'AUD', 0],
    ['19.99', 'USD', 1999],
    ['150000', 'JPY', 150000],
    ['1.234', 'KWD', 1234],
    ['1', 'KWD', 1000],
  ])('%s %s -> %i', (input, currency, expected) => {
    expect(parseAmount(input, currency)).toBe(expected)
  })

  it('does not go through floating point', () => {
    // 1.15 * 100 === 114.99999999999999 in IEEE 754.
    expect(parseAmount('1.15', 'AUD')).toBe(115)
    expect(parseAmount('4.35', 'AUD')).toBe(435)
  })

  it.each([
    ['10.005', 'AUD', /at most 2 decimal places/],
    ['10.5', 'JPY', /no minor unit/],
    ['-5', 'AUD', /Enter an amount/],
    ['1e5', 'AUD', /Enter an amount/],
    ['', 'AUD', /Enter an amount/],
    ['abc', 'AUD', /Enter an amount/],
    ['99999999999999999', 'AUD', /too large/],
  ])('refuses %j in %s', (input, currency, message) => {
    expect(() => parseAmount(input, currency)).toThrow(AmountFormatError)
    expect(() => parseAmount(input, currency)).toThrow(message)
  })
})

describe('minorToDecimalString', () => {
  it.each([
    [1250050, 'AUD', '12500.50'],
    [5, 'AUD', '0.05'],
    [0, 'AUD', '0.00'],
    [150000, 'JPY', '150000'],
    [1234, 'KWD', '1.234'],
    [-199, 'AUD', '-1.99'],
  ])('%i %s -> %s', (minor, currency, expected) => {
    expect(minorToDecimalString(minor, currency)).toBe(expected)
  })

  it('round-trips with parseAmount', () => {
    for (const minor of [0, 1, 99, 100, 101, 123456789]) {
      for (const currency of ['AUD', 'JPY', 'KWD']) {
        expect(parseAmount(minorToDecimalString(minor, currency), currency)).toBe(minor)
      }
    }
  })
})

describe('formatAmount', () => {
  // Intl separates a currency code from the number with a no-break space.
  const format = (minor: number, currency: string) =>
    formatAmount(minor, currency, 'en-AU').replace(/\s/g, ' ')

  it('formats with the currency and its own number of decimals', () => {
    expect(format(1250050, 'AUD')).toBe('$12,500.50')
    expect(format(150000, 'JPY')).toBe('JPY 150,000')
    expect(format(1234, 'KWD')).toBe('KWD 1.234')
  })

  it('is exact for amounts beyond float precision in the fraction', () => {
    expect(format(9007199254740991, 'AUD')).toBe('$90,071,992,547,409.91')
  })
})
