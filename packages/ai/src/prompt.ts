import { receiptReadingSchema, type ReceiptHints, type ReceiptReading } from '@workloom/core/modules'
import { z } from 'zod'

/**
 * What every provider is asked, and the shape every answer must take. One
 * prompt and one schema for all of them, so a receipt reads the same whichever
 * reads it -- and whatever comes back is checked against the same schema.
 */

export const INSTRUCTIONS = `You read photographed or scanned receipts and invoices for an agency's bookkeeping.

Report what the document itself shows. Do not guess: leave a field null when the document does not show it clearly.
- isReceipt: false when the image is not a receipt, bill, or invoice for something bought.
- supplier: the business that was paid, as it names itself.
- description: a few plain words on what was bought, such as "Web hosting, 12 months" or "Taxi to client meeting".
- date: the date of purchase as YYYY-MM-DD. Receipts may write dates day-first; use the country and currency to decide.
- currency: the ISO 4217 code. If the receipt only shows a symbol or "Rs", use the organization's currency when it fits.
- total: the amount actually paid, tax included, as a plain decimal with a full stop, no symbols or separators: 12500.00.
- tax: the tax or VAT included in that total, in the same form, only if the receipt states it.
- category: the key of the one category that fits best, from the list given, or null.
- paymentMethod: one of the payment methods given, only if the receipt says how it was paid.

Answer with JSON only.`

const PAYMENT_METHODS = 'bank_transfer, card, direct_debit, cash, cheque, paypal, stripe, other, personal_card'

/** The part of the request that changes per organization, after the fixed instructions. */
export function receiptContext(hints: ReceiptHints): string {
  return [
    `The organization's currency is ${hints.baseCurrency}. Today is ${hints.today}.`,
    `Categories (key: name): ${hints.categories.map((c) => `${c.key}: ${c.name}`).join('; ')}.`,
    `Payment methods: ${PAYMENT_METHODS}.`,
    'Read this receipt.',
  ].join('\n')
}

/**
 * The reading schema as plain JSON Schema: every field required (null when
 * unknown) and nothing extra, which is what strict structured output asks for.
 */
export const RECEIPT_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(receiptReadingSchema) as Record<string, unknown>
  return { ...schema, additionalProperties: false, required: Object.keys(receiptReadingSchema.shape) }
})()

/** Parses an answer that should be the schema's JSON. Null when it is not: the draft stays blank. */
export function parseReading(text: string | null | undefined): ReceiptReading | null {
  if (!text) return null
  // Some models wrap JSON in a fence even when asked not to.
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = receiptReadingSchema.safeParse(JSON.parse(body))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
