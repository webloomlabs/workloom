import { isCurrencyCode } from '../money/currency.ts'
import {
  allocate,
  apportion,
  DECIMAL_SCALE,
  formatDecimal,
  MoneyError,
  parseDecimal,
  parsePercent,
  roundDiv,
  toSafeNumber,
} from '../money/money.ts'

/**
 * How a quote or invoice adds up.
 *
 * The rules are specified by `fixtures.ts`, which was written first; read its
 * header before changing anything here. The calculator is pure: the same
 * function prices a draft in the browser, a document being saved, and the
 * golden fixtures.
 */

export type TaxMode = 'exclusive' | 'inclusive'
export const TAX_MODES = ['exclusive', 'inclusive'] as const

export type CalculationLine = {
  /** Up to four decimal places; may be negative for a credit. Never zero. */
  quantity: string
  /** Minor units; may be negative for a credit. */
  unitAmountMinor: number
  /** 0–100, up to four decimal places. */
  discountPercent?: string | null | undefined
  /**
   * The tax applied, or none. Lines with the same `key` are one tax: their
   * taxable amounts are added up and rounded together.
   */
  tax?: { key: string; rate: string } | null | undefined
}

export type DocumentDiscount = { percent: string } | { amountMinor: number }

export type CalculationInput = {
  currency: string
  taxMode: TaxMode
  discount?: DocumentDiscount | null | undefined
  lines: readonly CalculationLine[]
}

export type CalculatedLine = {
  /** quantity × unit amount. */
  amountMinor: number
  /** This line's own discount. */
  lineDiscountMinor: number
  /** Amount after the line's own discount. */
  netMinor: number
  /** This line's share of the document discount. */
  documentDiscountMinor: number
  /** What the tax is calculated on: net less the document discount share. */
  taxableMinor: number
  /** This line's share of its tax's rounded total. Included in `taxableMinor` for inclusive documents. */
  taxMinor: number
  /** What the line adds to the document total. */
  totalMinor: number
}

export type Calculation = {
  subtotalMinor: number
  discountMinor: number
  taxMinor: number
  totalMinor: number
  lines: CalculatedLine[]
  /** One entry per tax, in order of first use. `amountMinor` is the taxable amount. */
  taxes: Array<{ key: string; rate: string; amountMinor: number; taxMinor: number }>
}

/** A document that cannot be priced as given. `line` is the zero-based line at fault. */
export class CalculationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
    readonly line?: number,
  ) {
    super(message)
    this.name = 'CalculationError'
  }
}

const SCALE = 10n ** BigInt(DECIMAL_SCALE)
const HUNDRED_PERCENT = 100n * SCALE

/** Quantities are numeric(14,4): ten whole digits. */
export function parseQuantity(quantity: string): bigint {
  const scaled = parseDecimal(quantity, DECIMAL_SCALE, { integerDigits: 10, label: 'Quantity' })
  if (scaled === 0n) throw new MoneyError('Quantity cannot be zero.', 'zero_quantity')
  return scaled
}

/** A quantity or percentage in its shortest form: "7.3300" becomes "7.33". */
export function normalizeDecimal(value: string): string {
  return formatDecimal(parseDecimal(value, DECIMAL_SCALE), DECIMAL_SCALE)
}

function atLine<T>(index: number, field: string, fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof MoneyError) throw new CalculationError(`Line ${index + 1}: ${error.message}`, error.code, field, index)
    throw error
  }
}

export function calculate(input: CalculationInput): Calculation {
  if (!isCurrencyCode(input.currency)) throw new CalculationError(`Unknown currency: ${input.currency}`, 'invalid_currency', 'currency')
  const inclusive = input.taxMode === 'inclusive'

  // 1–2. Line amounts, line discounts, nets.
  const priced = input.lines.map((line, index) => {
    if (!Number.isSafeInteger(line.unitAmountMinor)) {
      throw new CalculationError(`Line ${index + 1}: the unit amount must be a whole number of minor units.`, 'invalid_amount', 'unitAmountMinor', index)
    }
    const quantity = atLine(index, 'quantity', () => parseQuantity(line.quantity))
    const amount = roundDiv(BigInt(line.unitAmountMinor) * quantity, SCALE)
    const discountRate = line.discountPercent ? atLine(index, 'discountPercent', () => parsePercent(line.discountPercent!, 'Discount')) : 0n
    const lineDiscount = roundDiv(amount * discountRate, HUNDRED_PERCENT)
    const taxRate = line.tax ? atLine(index, 'taxRate', () => parsePercent(line.tax!.rate, 'Tax rate')) : null
    return { amount, lineDiscount, net: amount - lineDiscount, taxRate, tax: line.tax ?? null }
  })
  const subtotal = priced.reduce((sum, l) => sum + l.net, 0n)

  // 3. The document discount, shared among lines with a positive net.
  let discount = 0n
  if (input.discount) {
    if ('percent' in input.discount) {
      const rate = parseOrThrow(() => parsePercent((input.discount as { percent: string }).percent, 'Discount'), 'discount')
      discount = roundDiv(subtotal * rate, HUNDRED_PERCENT)
    } else {
      if (!Number.isSafeInteger(input.discount.amountMinor) || input.discount.amountMinor < 0) {
        throw new CalculationError('The discount must be a whole, non-negative number of minor units.', 'invalid_amount', 'discount')
      }
      discount = BigInt(input.discount.amountMinor)
    }
    if (discount !== 0n && subtotal <= 0n) {
      throw new CalculationError('A document discount needs a subtotal above zero.', 'discount_without_subtotal', 'discount')
    }
    if (discount > subtotal) {
      throw new CalculationError('The discount cannot be more than the subtotal.', 'discount_exceeds_subtotal', 'discount')
    }
  }
  const shares = discount === 0n ? priced.map(() => 0n) : allocate(discount, priced.map((l) => (l.net > 0n ? l.net : 0n)))
  const taxable = priced.map((l, i) => l.net - shares[i]!)

  // 4–5. Tax per rate, rounded on the rate's total and apportioned to its lines.
  const lineTax = priced.map(() => 0n)
  const taxes: Calculation['taxes'] = []
  const groups = new Map<string, number[]>()
  priced.forEach((l, i) => {
    if (!l.tax) return
    const members = groups.get(l.tax.key)
    if (members) {
      if (priced[members[0]!]!.taxRate !== l.taxRate) {
        throw new CalculationError(`Line ${i + 1}: one tax cannot have two rates.`, 'tax_rate_conflict', 'taxRate', i)
      }
      members.push(i)
    } else groups.set(l.tax.key, [i])
  })
  let taxTotal = 0n
  for (const [key, members] of groups) {
    const rate = priced[members[0]!]!.taxRate!
    // Exclusive: taxable × rate. Inclusive: taxable × rate ÷ (100% + rate).
    const denominator = inclusive ? HUNDRED_PERCENT + rate : HUNDRED_PERCENT
    const exact = members.map((i) => taxable[i]! * rate)
    const amount = members.reduce((sum, i) => sum + taxable[i]!, 0n)
    const tax = roundDiv(amount * rate, denominator)
    apportion(tax, exact, denominator).forEach((part, j) => (lineTax[members[j]!] = part))
    taxes.push({ key, rate: formatDecimal(rate, DECIMAL_SCALE), amountMinor: toSafe(amount), taxMinor: toSafe(tax) })
    taxTotal += tax
  }

  // 6–7. Totals.
  const lines = priced.map((l, i) => ({
    amountMinor: toSafe(l.amount),
    lineDiscountMinor: toSafe(l.lineDiscount),
    netMinor: toSafe(l.net),
    documentDiscountMinor: toSafe(shares[i]!),
    taxableMinor: toSafe(taxable[i]!),
    taxMinor: toSafe(lineTax[i]!),
    totalMinor: toSafe(inclusive ? taxable[i]! : taxable[i]! + lineTax[i]!),
  }))
  return {
    subtotalMinor: toSafe(subtotal),
    discountMinor: toSafe(discount),
    taxMinor: toSafe(taxTotal),
    totalMinor: toSafe(subtotal - discount + (inclusive ? 0n : taxTotal)),
    lines,
    taxes,
  }
}

function parseOrThrow<T>(fn: () => T, field: string): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof MoneyError) throw new CalculationError(error.message, error.code, field)
    throw error
  }
}

function toSafe(value: bigint): number {
  try {
    return toSafeNumber(value)
  } catch (error) {
    if (error instanceof MoneyError) throw new CalculationError(error.message, error.code)
    throw error
  }
}
