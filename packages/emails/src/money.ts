/**
 * Formatting an amount for an email.
 *
 * A copy of the rule in packages/core, not an import: this package is about
 * messages, and must not pull the domain into every mail send. Both go through
 * Intl with an exact decimal string, so they agree.
 */
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0,
  UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

export function formatAmount(minor: number, currency: string, locale = 'en-AU'): string {
  const exponent = EXPONENTS[currency] ?? 2
  const digits = Math.abs(minor).toString().padStart(exponent + 1, '0')
  const whole = digits.slice(0, digits.length - exponent)
  const fraction = digits.slice(digits.length - exponent)
  const decimal = `${minor < 0 ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(
    decimal as unknown as number,
  )
}
