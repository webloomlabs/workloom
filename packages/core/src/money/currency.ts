/**
 * Currencies and minor units.
 *
 * Money is stored as an integer count of a currency's minor unit: cents for
 * AUD, yen for JPY (which has none), fils for KWD (which has three). Converting
 * between that and what a person types is string arithmetic here, never
 * floating point -- `19.99 * 100` is 1998.9999999999998.
 *
 * S7a builds the rest of the money primitives on top of this.
 */

/** ISO 4217 codes whose minor unit is not two digits. */
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0,
  UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
}

/** Active ISO 4217 currency codes. */
export const CURRENCY_CODES = [
  'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BHD',
  'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP',
  'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR',
  'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF',
  'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW',
  'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD',
  'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK',
  'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB',
  'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SYP',
  'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU',
  'UZS', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWG',
] as const

const CODES = new Set<string>(CURRENCY_CODES)

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CODES.has(value)
}

/** Digits after the decimal point in the currency's minor unit. */
export function currencyExponent(currency: string): number {
  return EXPONENTS[currency] ?? 2
}

export class AmountFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmountFormatError'
  }
}

/**
 * "12,500.50" in AUD -> 1250050. Accepts digits, one decimal point, and
 * thousands separators (commas, spaces, underscores). Rejects negative amounts
 * and more decimal places than the currency has, rather than rounding: a
 * person who typed 10.005 dollars made a mistake worth telling them about.
 */
export function parseAmount(input: string, currency: string): number {
  const exponent = currencyExponent(currency)
  const cleaned = input.trim().replace(/[,\s_]/g, '')
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(cleaned)) {
    throw new AmountFormatError('Enter an amount such as 1250 or 1,250.00.')
  }
  const [whole = '', fraction = ''] = cleaned.split('.')
  if (fraction.length > exponent) {
    throw new AmountFormatError(
      exponent === 0
        ? `${currency} has no minor unit; enter a whole number.`
        : `${currency} allows at most ${exponent} decimal places.`,
    )
  }
  const minor = BigInt((whole || '0') + fraction.padEnd(exponent, '0'))
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new AmountFormatError('That amount is too large.')
  return Number(minor)
}

/** 1250050 in AUD -> "12500.50". Exact, for form fields and APIs. */
export function minorToDecimalString(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`not a safe integer amount: ${minor}`)
  const exponent = currencyExponent(currency)
  const negative = minor < 0
  const digits = Math.abs(minor).toString().padStart(exponent + 1, '0')
  const whole = digits.slice(0, digits.length - exponent)
  const fraction = digits.slice(digits.length - exponent)
  return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`
}

/**
 * 1250050 in AUD -> "A$12,500.50" (locale-dependent). The decimal string is
 * passed to Intl as a string, which formats it exactly rather than going
 * through a float.
 */
export function formatAmount(minor: number, currency: string, locale = 'en-AU'): string {
  const exponent = currencyExponent(currency)
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minorToDecimalString(minor, currency) as unknown as number)
}
