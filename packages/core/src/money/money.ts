import { currencyExponent } from './currency.ts'

/**
 * Exact arithmetic on minor units.
 *
 * Everything here works in `bigint`. Amounts cross the API and the database as
 * safe integers, but intermediate products do not stay safe: 10,000 hours at
 * 999,999,999.99 is already past 2^53 in hundredths of a cent. Division happens
 * once, at the end, with an explicit rounding rule.
 *
 * Addition, subtraction, negation, and comparison are the native `bigint`
 * operators; wrapping them would add nothing but indirection.
 */

export class MoneyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

const abs = (n: bigint) => (n < 0n ? -n : n)

/** numerator ÷ denominator, rounded half away from zero. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero')
  if (denominator < 0n) return roundDiv(-numerator, -denominator)
  const q = abs(numerator) / denominator
  const r = abs(numerator) % denominator
  const rounded = 2n * r >= denominator ? q + 1n : q
  return numerator < 0n ? -rounded : rounded
}

/** Mathematical floor division, for negatives too. */
function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const q = numerator / denominator
  return numerator % denominator !== 0n && numerator < 0n !== denominator < 0n ? q - 1n : q
}

/** amount × numerator ÷ denominator, rounded half away from zero. */
export function multiplyByRational(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  return roundDiv(amount * numerator, denominator)
}

/** Decimal scale of percentages and quantities: four places. */
export const DECIMAL_SCALE = 4
const SCALE = 10n ** BigInt(DECIMAL_SCALE)

/**
 * A decimal string as a scaled integer: `parseDecimal("7.33", 4)` is 73300n.
 * Refuses exponents, more places than `scale`, and anything that is not a plain
 * decimal -- a person who typed 1.23456 hours made a mistake worth telling them about.
 */
export function parseDecimal(value: string, scale: number, options: { integerDigits?: number; label?: string } = {}): bigint {
  const label = options.label ?? 'Value'
  const text = value.trim()
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text)
  if (!match || text === '' || text === '-' || text === '.' || (match[2] === '' && !match[3])) {
    throw new MoneyError(`${label} must be a number, such as 1.5.`, 'invalid_decimal')
  }
  const [, sign, whole = '', fraction = ''] = match
  if (fraction.length > scale) {
    throw new MoneyError(`${label} allows at most ${scale} decimal places.`, 'too_many_decimals')
  }
  const digits = whole.replace(/^0+(?=\d)/, '')
  if (options.integerDigits !== undefined && digits.length > options.integerDigits) {
    throw new MoneyError(`${label} is too large.`, 'decimal_too_large')
  }
  const scaled = BigInt((digits || '0') + fraction.padEnd(scale, '0'))
  return sign ? -scaled : scaled
}

/** A scaled integer as its shortest decimal string: 73300n at scale 4 is "7.33". */
export function formatDecimal(scaled: bigint, scale: number): string {
  const negative = scaled < 0n
  const digits = abs(scaled).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** A percentage string ("8.875") as hundredths of a basis point, checked to lie within 0–100. */
export function parsePercent(value: string, label = 'Percentage'): bigint {
  const scaled = parseDecimal(value, DECIMAL_SCALE, { label })
  if (scaled < 0n || scaled > 100n * SCALE) throw new MoneyError(`${label} must be between 0 and 100.`, 'percent_out_of_range')
  return scaled
}

/** `percent`% of an amount, rounded half away from zero. */
export function percentage(amount: bigint, percent: string): bigint {
  return multiplyByRational(amount, parsePercent(percent), 100n * SCALE)
}

/**
 * Splits `total` into integer parts whose exact values are `numerators[i] ÷
 * denominator`, by largest remainder: each part starts at the floor of its
 * exact value, and the units left over go to the largest remainders, earlier
 * parts first on a tie.
 *
 * The parts always sum to `total`, and each is within one unit of its exact
 * value -- provided `total` is itself a rounding of the exact sum, which is
 * how every caller uses it. Signs may be mixed.
 */
export function apportion(total: bigint, numerators: readonly bigint[], denominator: bigint): bigint[] {
  if (denominator <= 0n) throw new RangeError('denominator must be positive')
  const floors = numerators.map((n) => floorDiv(n, denominator))
  let spare = total - floors.reduce((sum, f) => sum + f, 0n)
  if (spare < 0n || spare > BigInt(numerators.length)) {
    throw new RangeError(`cannot apportion ${total} over shares summing to ${floors.reduce((s, f) => s + f, 0n)}`)
  }
  const order = numerators
    .map((n, index) => ({ index, remainder: n - floors[index]! * denominator }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1))
  const parts = [...floors]
  for (const { index } of order) {
    if (spare === 0n) break
    parts[index]! += 1n
    spare -= 1n
  }
  return parts
}

/**
 * Splits `total` in proportion to non-negative `weights`, exactly: the parts sum
 * to `total`, each within one unit of its exact share. Equal weights when they
 * are all zero. The basis of splitting a discount across lines.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) {
    if (total !== 0n) throw new RangeError('cannot allocate a non-zero total across nothing')
    return []
  }
  if (weights.some((w) => w < 0n)) throw new RangeError('weights must not be negative')
  const sum = weights.reduce((s, w) => s + w, 0n)
  const effective = sum === 0n ? weights.map(() => 1n) : weights
  const denominator = sum === 0n ? BigInt(weights.length) : sum
  if (total >= 0n) return apportion(total, effective.map((w) => total * w), denominator)
  // Apportion the magnitude, so a negative total rounds the same way as its positive.
  return apportion(-total, effective.map((w) => -total * w), denominator).map((part) => -part)
}

/** Decimal scale of exchange rates: numeric(18,8). */
export const RATE_SCALE = 8

/**
 * An amount converted at an exchange rate ("1 unit of `from` is `rate` units of
 * `to`"), rounded half away from zero in the target currency's minor unit.
 * Minor units differ between currencies: 1000 JPY at 0.0105 is 1050 AUD cents.
 */
export function convert(amountMinor: bigint, from: string, to: string, rate: string): bigint {
  const scaledRate = parseDecimal(rate, RATE_SCALE, { integerDigits: 10, label: 'Exchange rate' })
  if (scaledRate <= 0n) throw new MoneyError('Exchange rate must be greater than zero.', 'invalid_exchange_rate')
  const shift = currencyExponent(to) - currencyExponent(from)
  const numerator = amountMinor * scaledRate * 10n ** BigInt(Math.max(shift, 0))
  const denominator = 10n ** BigInt(RATE_SCALE) * 10n ** BigInt(Math.max(-shift, 0))
  return roundDiv(numerator, denominator)
}

/** A bigint amount as a JavaScript number, refusing anything that would lose precision. */
export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError('That amount is too large.', 'amount_too_large')
  }
  return Number(value)
}
