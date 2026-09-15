/**
 * Golden fixtures: the specification of how a quote or invoice adds up.
 *
 * Written by hand, before the calculator, and run against both the pure
 * calculator and a document stored in Postgres and read back. If the
 * calculator disagrees with a fixture, the calculator is wrong until someone
 * shows the fixture is. Change an expected value only with a reason recorded
 * in the commit.
 *
 * The rules the numbers follow:
 *
 *  1. A line's amount is quantity × unit amount, rounded to the minor unit.
 *  2. A line discount is a percentage of the line's amount, rounded. Net is
 *     amount minus line discount. The subtotal is the sum of nets.
 *  3. A document discount is a percentage of the subtotal (rounded) or a fixed
 *     amount. It is shared among lines with a positive net, in proportion to
 *     their nets.
 *  4. Tax is rounded once per tax rate, on the sum of that rate's taxable
 *     amounts -- not once per line, which would drift by a cent per line.
 *     Exclusive: taxable × rate. Inclusive: taxable × rate ÷ (100 + rate).
 *  5. Shares of a rounded total (rules 3 and 4) are apportioned by largest
 *     remainder against each line's exact share; ties go to the earlier line.
 *  6. All rounding is half away from zero.
 *  7. Exclusive: total = subtotal − discount + tax. Inclusive: total =
 *     subtotal − discount, with tax included. Line totals always sum to the total.
 *
 * Amounts are integer minor units: cents for AUD, yen for JPY, fils for KWD.
 */

export type FixtureLine = {
  quantity: string
  unitAmountMinor: number
  discountPercent?: string
  /** A percentage. Absent means the line is not taxed at all. */
  taxRate?: string
}

export type GoldenFixture = {
  name: string
  document: {
    currency: string
    taxMode: 'exclusive' | 'inclusive'
    discount?: { percent: string } | { amountMinor: number }
    lines: FixtureLine[]
  }
  expected: {
    subtotalMinor: number
    discountMinor: number
    taxMinor: number
    totalMinor: number
    /** Per line: net after its own discount, its share of the document discount, its tax, and its total. */
    lines: Array<{ netMinor: number; documentDiscountMinor: number; taxMinor: number; totalMinor: number }>
    /** Per tax rate, in order of first use. */
    taxes?: Array<{ rate: string; amountMinor: number; taxMinor: number }>
  }
}

const line = (netMinor: number, documentDiscountMinor: number, taxMinor: number, totalMinor: number) => ({
  netMinor,
  documentDiscountMinor,
  taxMinor,
  totalMinor,
})
const aud = (lines: FixtureLine[], rest: Partial<GoldenFixture['document']> = {}): GoldenFixture['document'] => ({
  currency: 'AUD',
  taxMode: 'exclusive',
  lines,
  ...rest,
})

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  // Basics
  {
    name: 'one untaxed line',
    document: aud([{ quantity: '1', unitAmountMinor: 10000 }]),
    expected: { subtotalMinor: 10000, discountMinor: 0, taxMinor: 0, totalMinor: 10000, lines: [line(10000, 0, 0, 10000)] },
  },
  {
    name: 'one line at 10% exclusive',
    document: aud([{ quantity: '1', unitAmountMinor: 10000, taxRate: '10' }]),
    expected: { subtotalMinor: 10000, discountMinor: 0, taxMinor: 1000, totalMinor: 11000, lines: [line(10000, 0, 1000, 11000)] },
  },
  {
    name: 'whole quantity',
    document: aud([{ quantity: '2', unitAmountMinor: 12345, taxRate: '10' }]),
    expected: { subtotalMinor: 24690, discountMinor: 0, taxMinor: 2469, totalMinor: 27159, lines: [line(24690, 0, 2469, 27159)] },
  },
  {
    name: 'fractional hours: 7.33 h at 150.00',
    document: aud([{ quantity: '7.33', unitAmountMinor: 15000, taxRate: '10' }]),
    expected: { subtotalMinor: 109950, discountMinor: 0, taxMinor: 10995, totalMinor: 120945, lines: [line(109950, 0, 10995, 120945)] },
  },
  {
    name: 'four-place quantity rounds the line amount',
    document: aud([{ quantity: '1.3333', unitAmountMinor: 1000, taxRate: '10' }]),
    // 1333.3 -> 1333; tax 133.3 -> 133
    expected: { subtotalMinor: 1333, discountMinor: 0, taxMinor: 133, totalMinor: 1466, lines: [line(1333, 0, 133, 1466)] },
  },

  // Half a minor unit
  {
    name: 'a line amount of exactly half a cent rounds up',
    document: aud([{ quantity: '0.5', unitAmountMinor: 1 }]),
    expected: { subtotalMinor: 1, discountMinor: 0, taxMinor: 0, totalMinor: 1, lines: [line(1, 0, 0, 1)] },
  },
  {
    name: 'a line amount ending in half a cent',
    document: aud([{ quantity: '1.5', unitAmountMinor: 333, taxRate: '10' }]),
    // 499.5 -> 500
    expected: { subtotalMinor: 500, discountMinor: 0, taxMinor: 50, totalMinor: 550, lines: [line(500, 0, 50, 550)] },
  },
  {
    name: 'tax of exactly half a cent rounds up',
    document: aud([{ quantity: '1', unitAmountMinor: 5, taxRate: '10' }]),
    expected: { subtotalMinor: 5, discountMinor: 0, taxMinor: 1, totalMinor: 6, lines: [line(5, 0, 1, 6)] },
  },
  {
    name: 'tax rounds once per rate, not once per line',
    document: aud([
      { quantity: '1', unitAmountMinor: 5, taxRate: '10' },
      { quantity: '1', unitAmountMinor: 5, taxRate: '10' },
      { quantity: '1', unitAmountMinor: 5, taxRate: '10' },
    ]),
    // Per line would be 1 + 1 + 1 = 3. On the total, 1.5 -> 2, apportioned to the first two lines.
    expected: {
      subtotalMinor: 15,
      discountMinor: 0,
      taxMinor: 2,
      totalMinor: 17,
      lines: [line(5, 0, 1, 6), line(5, 0, 1, 6), line(5, 0, 0, 5)],
      taxes: [{ rate: '10', amountMinor: 15, taxMinor: 2 }],
    },
  },
  {
    name: 'a float trap: 0.285 × 100 is 28.5, not 28.499999999999996',
    document: aud([{ quantity: '0.285', unitAmountMinor: 100 }]),
    expected: { subtotalMinor: 29, discountMinor: 0, taxMinor: 0, totalMinor: 29, lines: [line(29, 0, 0, 29)] },
  },

  // Several tax rates
  {
    name: 'several rates on one document, with a zero-rated and an untaxed line',
    document: aud([
      { quantity: '1', unitAmountMinor: 10000, taxRate: '10' },
      { quantity: '1', unitAmountMinor: 5000, taxRate: '0' },
      { quantity: '1', unitAmountMinor: 2000, taxRate: '20' },
      { quantity: '1', unitAmountMinor: 100 },
    ]),
    expected: {
      subtotalMinor: 17100,
      discountMinor: 0,
      taxMinor: 1400,
      totalMinor: 18500,
      lines: [line(10000, 0, 1000, 11000), line(5000, 0, 0, 5000), line(2000, 0, 400, 2400), line(100, 0, 0, 100)],
      taxes: [
        { rate: '10', amountMinor: 10000, taxMinor: 1000 },
        { rate: '0', amountMinor: 5000, taxMinor: 0 },
        { rate: '20', amountMinor: 2000, taxMinor: 400 },
      ],
    },
  },
  {
    name: 'a rate with three decimal places',
    document: aud([{ quantity: '1', unitAmountMinor: 10000, taxRate: '8.875' }]),
    // 887.5 -> 888
    expected: { subtotalMinor: 10000, discountMinor: 0, taxMinor: 888, totalMinor: 10888, lines: [line(10000, 0, 888, 10888)] },
  },
  {
    name: 'a fractional rate on an awkward amount',
    document: aud([{ quantity: '3', unitAmountMinor: 333, taxRate: '8.875' }]),
    // 999 × 8.875% = 88.66125 -> 89
    expected: { subtotalMinor: 999, discountMinor: 0, taxMinor: 89, totalMinor: 1088, lines: [line(999, 0, 89, 1088)] },
  },

  // Line discounts
  {
    name: 'a line discount',
    document: aud([{ quantity: '1', unitAmountMinor: 10000, discountPercent: '10', taxRate: '10' }]),
    expected: { subtotalMinor: 9000, discountMinor: 0, taxMinor: 900, totalMinor: 9900, lines: [line(9000, 0, 900, 9900)] },
  },
  {
    name: 'a line discount that rounds',
    document: aud([{ quantity: '1', unitAmountMinor: 999, discountPercent: '12.5', taxRate: '10' }]),
    // discount 124.875 -> 125; net 874; tax 87.4 -> 87
    expected: { subtotalMinor: 874, discountMinor: 0, taxMinor: 87, totalMinor: 961, lines: [line(874, 0, 87, 961)] },
  },
  {
    name: 'a 100% line discount',
    document: aud([
      { quantity: '3', unitAmountMinor: 2500, discountPercent: '100', taxRate: '10' },
      { quantity: '1', unitAmountMinor: 1000, taxRate: '10' },
    ]),
    expected: { subtotalMinor: 1000, discountMinor: 0, taxMinor: 100, totalMinor: 1100, lines: [line(0, 0, 0, 0), line(1000, 0, 100, 1100)] },
  },

  // Document discounts
  {
    name: 'a percentage document discount',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 10000, taxRate: '10' },
        { quantity: '1', unitAmountMinor: 5000, taxRate: '10' },
      ],
      { discount: { percent: '10' } },
    ),
    expected: {
      subtotalMinor: 15000,
      discountMinor: 1500,
      taxMinor: 1350,
      totalMinor: 14850,
      lines: [line(10000, 1000, 900, 9900), line(5000, 500, 450, 4950)],
    },
  },
  {
    name: 'a fixed document discount across two tax rates',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 6000, taxRate: '10' },
        { quantity: '1', unitAmountMinor: 4000, taxRate: '0' },
      ],
      { discount: { amountMinor: 1000 } },
    ),
    // Discount shared 600/400, so the 10% rate is charged on 5400.
    expected: {
      subtotalMinor: 10000,
      discountMinor: 1000,
      taxMinor: 540,
      totalMinor: 9540,
      lines: [line(6000, 600, 540, 5940), line(4000, 400, 0, 3600)],
      taxes: [
        { rate: '10', amountMinor: 5400, taxMinor: 540 },
        { rate: '0', amountMinor: 3600, taxMinor: 0 },
      ],
    },
  },
  {
    name: 'a fixed discount that does not divide evenly',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 1000 },
        { quantity: '1', unitAmountMinor: 1000 },
        { quantity: '1', unitAmountMinor: 1000 },
      ],
      { discount: { amountMinor: 100 } },
    ),
    // 33.33 each; the spare cent goes to the first line.
    expected: {
      subtotalMinor: 3000,
      discountMinor: 100,
      taxMinor: 0,
      totalMinor: 2900,
      lines: [line(1000, 34, 0, 966), line(1000, 33, 0, 967), line(1000, 33, 0, 967)],
    },
  },
  {
    name: 'uneven discount shares, then uneven tax shares',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 1000, taxRate: '10' },
        { quantity: '1', unitAmountMinor: 1000, taxRate: '10' },
        { quantity: '1', unitAmountMinor: 1000, taxRate: '10' },
      ],
      { discount: { percent: '3.3333' } },
    ),
    // discount 99.999 -> 100, shared 34/33/33. Taxable 966/967/967 = 2900, tax 290.
    // Exact tax shares 96.6/96.7/96.7: floors 288, the two spare cents to the largest remainders.
    expected: {
      subtotalMinor: 3000,
      discountMinor: 100,
      taxMinor: 290,
      totalMinor: 3190,
      lines: [line(1000, 34, 96, 1062), line(1000, 33, 97, 1064), line(1000, 33, 97, 1064)],
    },
  },
  {
    name: 'a 100% document discount',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 5000, taxRate: '10' },
        { quantity: '2', unitAmountMinor: 2500, taxRate: '10' },
      ],
      { discount: { percent: '100' } },
    ),
    expected: { subtotalMinor: 10000, discountMinor: 10000, taxMinor: 0, totalMinor: 0, lines: [line(5000, 5000, 0, 0), line(5000, 5000, 0, 0)] },
  },
  {
    name: 'a document discount rounding half up',
    document: aud([{ quantity: '1', unitAmountMinor: 1005 }], { discount: { percent: '10' } }),
    // 100.5 -> 101
    expected: { subtotalMinor: 1005, discountMinor: 101, taxMinor: 0, totalMinor: 904, lines: [line(1005, 101, 0, 904)] },
  },
  {
    name: 'a fixed discount on untaxed lines',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 700 },
        { quantity: '1', unitAmountMinor: 300 },
      ],
      { discount: { amountMinor: 500 } },
    ),
    expected: { subtotalMinor: 1000, discountMinor: 500, taxMinor: 0, totalMinor: 500, lines: [line(700, 350, 0, 350), line(300, 150, 0, 150)] },
  },
  {
    name: 'a percentage discount across a taxed and an untaxed line',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 3333, taxRate: '10' },
        { quantity: '1', unitAmountMinor: 6667 },
      ],
      { discount: { percent: '15' } },
    ),
    // Discount 1500, exact shares 499.95/1000.05 -> 500/1000. Tax on 2833 = 283.3 -> 283.
    expected: { subtotalMinor: 10000, discountMinor: 1500, taxMinor: 283, totalMinor: 8783, lines: [line(3333, 500, 283, 3116), line(6667, 1000, 0, 5667)] },
  },
  {
    name: 'line discount, document discount, and two rates together',
    document: aud(
      [
        { quantity: '4', unitAmountMinor: 2500, discountPercent: '25', taxRate: '10' },
        { quantity: '1', unitAmountMinor: 2500, taxRate: '20' },
      ],
      { discount: { amountMinor: 1000 } },
    ),
    expected: {
      subtotalMinor: 10000,
      discountMinor: 1000,
      taxMinor: 1125,
      totalMinor: 10125,
      lines: [line(7500, 750, 675, 7425), line(2500, 250, 450, 2700)],
    },
  },

  // Tax-inclusive prices
  {
    name: 'inclusive: one line at 10%',
    document: aud([{ quantity: '1', unitAmountMinor: 11000, taxRate: '10' }], { taxMode: 'inclusive' }),
    expected: { subtotalMinor: 11000, discountMinor: 0, taxMinor: 1000, totalMinor: 11000, lines: [line(11000, 0, 1000, 11000)] },
  },
  {
    name: 'inclusive: tax that rounds',
    document: aud([{ quantity: '1', unitAmountMinor: 1000, taxRate: '10' }], { taxMode: 'inclusive' }),
    // 1000 × 10/110 = 90.909 -> 91
    expected: { subtotalMinor: 1000, discountMinor: 0, taxMinor: 91, totalMinor: 1000, lines: [line(1000, 0, 91, 1000)] },
  },
  {
    name: 'inclusive: tax rounded on the rate total',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 100, taxRate: '10' },
        { quantity: '1', unitAmountMinor: 100, taxRate: '10' },
        { quantity: '1', unitAmountMinor: 100, taxRate: '10' },
      ],
      { taxMode: 'inclusive' },
    ),
    // 300 × 10/110 = 27.27 -> 27; exact shares 9.09 each.
    expected: { subtotalMinor: 300, discountMinor: 0, taxMinor: 27, totalMinor: 300, lines: [line(100, 0, 9, 100), line(100, 0, 9, 100), line(100, 0, 9, 100)] },
  },
  {
    name: 'inclusive: two rates and a line discount',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 11000, discountPercent: '50', taxRate: '10' },
        { quantity: '1', unitAmountMinor: 2400, taxRate: '20' },
      ],
      { taxMode: 'inclusive' },
    ),
    expected: {
      subtotalMinor: 7900,
      discountMinor: 0,
      taxMinor: 900,
      totalMinor: 7900,
      lines: [line(5500, 0, 500, 5500), line(2400, 0, 400, 2400)],
      taxes: [
        { rate: '10', amountMinor: 5500, taxMinor: 500 },
        { rate: '20', amountMinor: 2400, taxMinor: 400 },
      ],
    },
  },
  {
    name: 'inclusive: a document discount',
    document: aud(
      [
        { quantity: '1', unitAmountMinor: 2200, taxRate: '10' },
        { quantity: '1', unitAmountMinor: 1100, taxRate: '10' },
      ],
      { taxMode: 'inclusive', discount: { percent: '10' } },
    ),
    expected: { subtotalMinor: 3300, discountMinor: 330, taxMinor: 270, totalMinor: 2970, lines: [line(2200, 220, 180, 1980), line(1100, 110, 90, 990)] },
  },
  {
    name: 'inclusive: zero-rated',
    document: aud([{ quantity: '1', unitAmountMinor: 5000, taxRate: '0' }], { taxMode: 'inclusive' }),
    expected: {
      subtotalMinor: 5000,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: 5000,
      lines: [line(5000, 0, 0, 5000)],
      taxes: [{ rate: '0', amountMinor: 5000, taxMinor: 0 }],
    },
  },
  {
    name: 'inclusive: a credit line',
    document: aud([{ quantity: '1', unitAmountMinor: -1100, taxRate: '10' }], { taxMode: 'inclusive' }),
    expected: { subtotalMinor: -1100, discountMinor: 0, taxMinor: -100, totalMinor: -1100, lines: [line(-1100, 0, -100, -1100)] },
  },

  // Currencies with other minor units
  {
    name: 'JPY, which has no minor unit',
    document: { currency: 'JPY', taxMode: 'exclusive', lines: [{ quantity: '3', unitAmountMinor: 1234, taxRate: '10' }] },
    // tax 370.2 -> 370
    expected: { subtotalMinor: 3702, discountMinor: 0, taxMinor: 370, totalMinor: 4072, lines: [line(3702, 0, 370, 4072)] },
  },
  {
    name: 'JPY with a fractional quantity',
    document: { currency: 'JPY', taxMode: 'exclusive', lines: [{ quantity: '1.5', unitAmountMinor: 999, taxRate: '8' }] },
    // 1498.5 -> 1499; tax 119.92 -> 120
    expected: { subtotalMinor: 1499, discountMinor: 0, taxMinor: 120, totalMinor: 1619, lines: [line(1499, 0, 120, 1619)] },
  },
  {
    name: 'KWD, which has three decimal places',
    document: { currency: 'KWD', taxMode: 'exclusive', lines: [{ quantity: '2', unitAmountMinor: 12345, taxRate: '5' }] },
    // 24.690 KWD; tax 1234.5 fils -> 1235
    expected: { subtotalMinor: 24690, discountMinor: 0, taxMinor: 1235, totalMinor: 25925, lines: [line(24690, 0, 1235, 25925)] },
  },
  {
    name: 'KWD with a four-place quantity',
    document: { currency: 'KWD', taxMode: 'exclusive', lines: [{ quantity: '0.3333', unitAmountMinor: 1000 }] },
    expected: { subtotalMinor: 333, discountMinor: 0, taxMinor: 0, totalMinor: 333, lines: [line(333, 0, 0, 333)] },
  },

  // Credits
  {
    name: 'a credit line with a negative unit amount',
    document: aud([
      { quantity: '1', unitAmountMinor: 10000, taxRate: '10' },
      { quantity: '1', unitAmountMinor: -2000, taxRate: '10' },
    ]),
    expected: { subtotalMinor: 8000, discountMinor: 0, taxMinor: 800, totalMinor: 8800, lines: [line(10000, 0, 1000, 11000), line(-2000, 0, -200, -2200)] },
  },
  {
    name: 'a credit line with a negative quantity',
    document: aud([
      { quantity: '1', unitAmountMinor: 5000, taxRate: '10' },
      { quantity: '-2', unitAmountMinor: 1500, taxRate: '10' },
    ]),
    expected: { subtotalMinor: 2000, discountMinor: 0, taxMinor: 200, totalMinor: 2200, lines: [line(5000, 0, 500, 5500), line(-3000, 0, -300, -3300)] },
  },
  {
    name: 'a wholly negative document rounds tax away from zero',
    document: aud([{ quantity: '1', unitAmountMinor: -1005, taxRate: '10' }]),
    // -100.5 -> -101
    expected: { subtotalMinor: -1005, discountMinor: 0, taxMinor: -101, totalMinor: -1106, lines: [line(-1005, 0, -101, -1106)] },
  },
  {
    name: 'minus half a cent rounds away from zero',
    document: aud([{ quantity: '-0.5', unitAmountMinor: 1 }]),
    expected: { subtotalMinor: -1, discountMinor: 0, taxMinor: 0, totalMinor: -1, lines: [line(-1, 0, 0, -1)] },
  },

  // Edges
  {
    name: 'no lines',
    document: aud([]),
    expected: { subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0, lines: [] },
  },
  {
    name: 'amounts beyond float precision for cents, still exact',
    document: aud([{ quantity: '10000', unitAmountMinor: 99999999999, taxRate: '10' }]),
    expected: {
      subtotalMinor: 999999999990000,
      discountMinor: 0,
      taxMinor: 99999999999000,
      totalMinor: 1099999999989000,
      lines: [line(999999999990000, 0, 99999999999000, 1099999999989000)],
    },
  },
]
