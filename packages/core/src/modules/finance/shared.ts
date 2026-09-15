import { z } from 'zod'
import { DomainError } from '../../context.ts'
import { DECIMAL_SCALE, formatDecimal, MoneyError, parseDecimal, parsePercent } from '../../money/money.ts'
import { CalculationError, parseQuantity } from '../../tax/calculate.ts'

/**
 * Exact decimals over the API. Accepted as a JSON string ("8.875") or number
 * (8.875), and returned as the shortest exact string. A number is converted
 * through its shortest representation, which is exact for anything a person
 * would type; "1e-7" and the like are refused rather than guessed at.
 */
const decimal = (parse: (value: string) => bigint) =>
  z.union([z.string(), z.number()]).transform((value, ctx) => {
    try {
      return formatDecimal(parse(String(value)), DECIMAL_SCALE)
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error
      ctx.addIssue({ code: 'custom', message: error.message })
      return z.NEVER
    }
  })

/** 0–100, up to four decimal places. */
export const percentInput = decimal((value) => parsePercent(value))
/** Up to four decimal places and ten whole digits; not zero. */
export const quantityInput = decimal(parseQuantity)

/** A `numeric` column's string ("7.3300") in shortest form ("7.33"). */
export function fromNumeric(value: string): string
export function fromNumeric(value: string | null): string | null
export function fromNumeric(value: string | null): string | null {
  return value === null ? null : formatDecimal(parseDecimal(value, DECIMAL_SCALE), DECIMAL_SCALE)
}

/** Turns a calculator refusal into a message for whoever submitted the document. */
export function pricingRefusal(error: unknown): never {
  if (error instanceof CalculationError) {
    const field = error.line === undefined ? error.field : `lines.${error.line}.${error.field}`
    throw new DomainError(error.message, error.code, field)
  }
  if (error instanceof MoneyError) throw new DomainError(error.message, error.code)
  throw error
}

/** The largest amount the API accepts: 2^53 − 1 minor units, either sign. */
export const signedMinorAmount = z
  .number()
  .int('Amounts are integer minor units, e.g. 1250050 for 12,500.50.')
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
