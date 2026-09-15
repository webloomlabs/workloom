import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { calculate, CalculationError, type CalculationInput } from './calculate.ts'
import { GOLDEN_FIXTURES, type GoldenFixture } from './fixtures.ts'

/** A fixture as calculator input: each distinct rate is one tax. */
export function fixtureInput(document: GoldenFixture['document']): CalculationInput {
  return {
    currency: document.currency,
    taxMode: document.taxMode,
    discount: document.discount ?? null,
    lines: document.lines.map((l) => ({
      quantity: l.quantity,
      unitAmountMinor: l.unitAmountMinor,
      discountPercent: l.discountPercent ?? null,
      tax: l.taxRate === undefined ? null : { key: l.taxRate, rate: l.taxRate },
    })),
  }
}

describe('golden fixtures', () => {
  it('cover the cases the plan names', () => {
    expect(GOLDEN_FIXTURES.length).toBeGreaterThanOrEqual(40)
    const names = GOLDEN_FIXTURES.map((f) => f.name).join('\n')
    for (const topic of ['inclusive', 'JPY', 'KWD', 'credit', 'half a cent', '100%', '7.33', 'several rates', 'document discount', 'line discount']) {
      expect(names, topic).toContain(topic)
    }
  })

  it.each(GOLDEN_FIXTURES.map((f) => [f.name, f] as const))('%s', (_, fixture) => {
    const result = calculate(fixtureInput(fixture.document))
    const { lines, taxes, ...totals } = fixture.expected
    expect({
      subtotalMinor: result.subtotalMinor,
      discountMinor: result.discountMinor,
      taxMinor: result.taxMinor,
      totalMinor: result.totalMinor,
    }).toEqual(totals)
    expect(result.lines.map((l) => ({ netMinor: l.netMinor, documentDiscountMinor: l.documentDiscountMinor, taxMinor: l.taxMinor, totalMinor: l.totalMinor }))).toEqual(lines)
    if (taxes) expect(result.taxes.map(({ rate, amountMinor, taxMinor }) => ({ rate, amountMinor, taxMinor }))).toEqual(taxes)
  })
})

const lineArbitrary = fc.record({
  quantity: fc.integer({ min: -99_999, max: 999_999 }).filter((q) => q !== 0).map((q) => (q / 100).toFixed(2)),
  unitAmountMinor: fc.integer({ min: -1_000_000, max: 10_000_000 }),
  discountPercent: fc.option(fc.integer({ min: 0, max: 1_000_000 }).map((p) => (p / 10_000).toFixed(4)), { nil: null }),
  tax: fc.option(fc.constantFrom('0', '5', '8.875', '10', '20', '33.3333').map((rate) => ({ key: rate, rate })), { nil: null }),
})

const documentArbitrary = fc.record({
  currency: fc.constantFrom('AUD', 'JPY', 'KWD'),
  taxMode: fc.constantFrom('exclusive' as const, 'inclusive' as const),
  lines: fc.array(lineArbitrary, { maxLength: 12 }),
  discountPercent: fc.option(fc.integer({ min: 0, max: 1_000_000 }).map((p) => (p / 10_000).toFixed(4)), { nil: null }),
})

describe('invariants, for any document', () => {
  it('line totals, discount shares, and tax shares add up exactly', () => {
    fc.assert(
      fc.property(documentArbitrary, (doc) => {
        const subtotalPositive = calculate({ ...doc, discount: null }).subtotalMinor > 0
        const result = calculate({ ...doc, discount: doc.discountPercent && subtotalPositive ? { percent: doc.discountPercent } : null })
        const sum = (f: (l: (typeof result.lines)[number]) => number) => result.lines.reduce((s, l) => s + f(l), 0)

        expect(sum((l) => l.totalMinor)).toBe(result.totalMinor)
        expect(sum((l) => l.netMinor)).toBe(result.subtotalMinor)
        expect(sum((l) => l.documentDiscountMinor)).toBe(result.discountMinor)
        expect(sum((l) => l.taxMinor)).toBe(result.taxMinor)
        expect(result.taxes.reduce((s, t) => s + t.taxMinor, 0)).toBe(result.taxMinor)
        const tax = doc.taxMode === 'exclusive' ? result.taxMinor : 0
        expect(result.totalMinor).toBe(result.subtotalMinor - result.discountMinor + tax)
        for (const l of result.lines) {
          expect(l.netMinor).toBe(l.amountMinor - l.lineDiscountMinor)
          expect(l.taxableMinor).toBe(l.netMinor - l.documentDiscountMinor)
          // A discount share never takes a line past zero.
          if (l.netMinor > 0) expect(l.taxableMinor).toBeGreaterThanOrEqual(0)
        }
      }),
      { numRuns: 500 },
    )
  })

  it('is deterministic', () => {
    fc.assert(fc.property(documentArbitrary, (doc) => {
      expect(calculate(doc)).toEqual(calculate(doc))
    }), { numRuns: 100 })
  })
})

describe('refusals', () => {
  const doc = (overrides: Partial<CalculationInput>): CalculationInput => ({
    currency: 'AUD',
    taxMode: 'exclusive',
    lines: [{ quantity: '1', unitAmountMinor: 1000 }],
    ...overrides,
  })
  const refused = (input: CalculationInput) => {
    try {
      calculate(input)
    } catch (error) {
      expect(error).toBeInstanceOf(CalculationError)
      return error as CalculationError
    }
    throw new Error('expected a refusal')
  }

  it('a zero, malformed, or over-precise quantity, naming the line', () => {
    expect(refused(doc({ lines: [{ quantity: '1', unitAmountMinor: 1 }, { quantity: '0', unitAmountMinor: 1 }] }))).toMatchObject({ code: 'zero_quantity', line: 1, field: 'quantity' })
    expect(refused(doc({ lines: [{ quantity: '1.23456', unitAmountMinor: 1 }] }))).toMatchObject({ code: 'too_many_decimals' })
    expect(refused(doc({ lines: [{ quantity: '1e3', unitAmountMinor: 1 }] }))).toMatchObject({ code: 'invalid_decimal' })
    expect(refused(doc({ lines: [{ quantity: '12345678901', unitAmountMinor: 1 }] }))).toMatchObject({ code: 'decimal_too_large' })
  })

  it('percentages outside 0–100', () => {
    expect(refused(doc({ lines: [{ quantity: '1', unitAmountMinor: 1, discountPercent: '101' }] }))).toMatchObject({ code: 'percent_out_of_range' })
    expect(refused(doc({ lines: [{ quantity: '1', unitAmountMinor: 1, tax: { key: 'x', rate: '-5' } }] }))).toMatchObject({ code: 'percent_out_of_range' })
    expect(refused(doc({ discount: { percent: '100.0001' } }))).toMatchObject({ code: 'percent_out_of_range', field: 'discount' })
  })

  it('a discount larger than the subtotal, or on nothing', () => {
    expect(refused(doc({ discount: { amountMinor: 1001 } }))).toMatchObject({ code: 'discount_exceeds_subtotal' })
    expect(refused(doc({ lines: [{ quantity: '1', unitAmountMinor: -1000 }], discount: { amountMinor: 1 } }))).toMatchObject({ code: 'discount_without_subtotal' })
    expect(refused(doc({ discount: { amountMinor: -1 } }))).toMatchObject({ code: 'invalid_amount' })
  })

  it('one tax with two rates, an unknown currency, and totals beyond safe integers', () => {
    expect(
      refused(doc({ lines: [{ quantity: '1', unitAmountMinor: 1, tax: { key: 'gst', rate: '10' } }, { quantity: '1', unitAmountMinor: 1, tax: { key: 'gst', rate: '15' } }] })),
    ).toMatchObject({ code: 'tax_rate_conflict', line: 1 })
    expect(refused(doc({ currency: 'XYZ' }))).toMatchObject({ code: 'invalid_currency' })
    expect(refused(doc({ lines: [{ quantity: '9999999999', unitAmountMinor: Number.MAX_SAFE_INTEGER }] }))).toMatchObject({ code: 'amount_too_large' })
  })
})
