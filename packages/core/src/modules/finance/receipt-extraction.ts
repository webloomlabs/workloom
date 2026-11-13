import { schema } from '@workloom/db'
import { z } from 'zod'
import { isCurrencyCode, parseAmount } from '../../money/currency.ts'

/**
 * Reading a receipt: what a reader is asked for, and how its answer becomes
 * the start of an expense.
 *
 * The reader itself lives outside core (`@workloom/ai` reads with Claude, OpenAI, Gemini, or Groq), so
 * nothing here depends on a model or an SDK. Whatever it returns is a
 * suggestion: it fills a *draft* that a person confirms, and every value is
 * checked here before it gets that far -- an amount that does not parse, a
 * date in the future, or a category the organization does not have is
 * dropped, not trusted.
 */

/** What a reader returns. Amounts are decimal strings as printed, so nothing is lost to floating point. */
export const receiptReadingSchema = z.object({
  /** False when the image is not a receipt or invoice at all. */
  isReceipt: z.boolean(),
  /** Who was paid: the shop, the supplier, the service. */
  supplier: z.string().nullable(),
  /** A few words on what was bought, for the expense's description. */
  description: z.string().nullable(),
  /** The date of the purchase, YYYY-MM-DD. */
  date: z.string().nullable(),
  /** ISO 4217, e.g. LKR. */
  currency: z.string().nullable(),
  /** What was paid in total, tax included, as a plain decimal such as 1250.00. */
  total: z.string().nullable(),
  /** The tax within the total, if the receipt shows it, as a plain decimal. */
  tax: z.string().nullable(),
  /** One of the category keys offered. */
  category: z.string().nullable(),
  /** One of the payment methods offered, if the receipt says how it was paid. */
  paymentMethod: z.string().nullable(),
})

export type ReceiptReading = z.infer<typeof receiptReadingSchema>

export type ReceiptFile = { bytes: Buffer; contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf' }

export type ReceiptHints = {
  /** The organization's own currency: the likely one when a receipt does not say. */
  baseCurrency: string
  /** Today in the organization's time zone. A receipt is never dated after it. */
  today: string
  categories: ReadonlyArray<{ key: string; name: string }>
}

/** Something that reads receipts. Returns null when it could not -- a refusal, an error, a timeout. */
export interface ReceiptExtractor {
  readonly name: string
  read(file: ReceiptFile, hints: ReceiptHints): Promise<ReceiptReading | null>
}

/** The types a reader can be shown. HEIC is kept as a receipt but not read. */
export const READABLE_RECEIPT_TYPES: ReadonlyArray<ReceiptFile['contentType']> = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']

/** What reading suggests for the draft expense, every value checked. */
export const receiptDraftSchema = z.object({
  supplier: z.string().max(200).nullable(),
  description: z.string().max(500).nullable(),
  incurredOn: z.iso.date().nullable(),
  currency: z.string().length(3).nullable(),
  /** The total paid, tax included, in minor units. */
  amountMinor: z.number().int().nonnegative().nullable(),
  taxMinor: z.number().int().nonnegative().nullable(),
  category: z.string().nullable(),
  paymentMethod: z.enum(schema.EXPENSE_PAYMENT_METHODS).nullable(),
  /** Who read it, for the record kept on the expense. */
  reader: z.string(),
})

export type ReceiptDraft = z.infer<typeof receiptDraftSchema>

const text = (value: string | null, max: number): string | null => {
  const cleaned = value?.replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, max) : null
}

/** "LKR 1,250.00" or "Rs. 1250" -> 125000, in the currency given; null if it is not an amount. */
export function readAmount(value: string | null, currency: string): number | null {
  if (!value) return null
  // The number itself, from its first digit to its last: "Rs." must not lend it a decimal point.
  const digits = (value.match(/\d[\d.,\s]*\d|\d/)?.[0] ?? '').replace(/\s/g, '')
  // A comma followed by exactly two digits at the end is a decimal comma ("1.250,00").
  const normal = /,\d{2}$/.test(digits) && !/\.\d{2}$/.test(digits) ? digits.replace(/\./g, '').replace(',', '.') : digits.replace(/,/g, '')
  try {
    return parseAmount(normal, currency)
  } catch {
    return null
  }
}

export function receiptDate(value: string | null, today: string): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null
  // Not after today, and not absurdly old: a misread year is more likely than a ten-year-old receipt.
  if (value > today || value < `${Number(today.slice(0, 4)) - 10}${today.slice(4)}`) return null
  return value
}

/**
 * Turns a reader's answer into what a draft expense may take. Pure: tested
 * on its own, and the only path from a reader to the database.
 */
export function normaliseReading(reading: ReceiptReading | null, hints: ReceiptHints, reader: string): ReceiptDraft | null {
  if (!reading || !reading.isReceipt) return null
  const said = reading.currency?.trim().toUpperCase() ?? null
  const currency = said && isCurrencyCode(said) ? said : hints.baseCurrency
  const total = readAmount(reading.total, currency)
  const tax = readAmount(reading.tax, currency)
  const category = reading.category && hints.categories.some((c) => c.key === reading.category) ? reading.category : null
  const method = (schema.EXPENSE_PAYMENT_METHODS as readonly string[]).includes(reading.paymentMethod ?? '') ? (reading.paymentMethod as ReceiptDraft['paymentMethod']) : null
  return {
    supplier: text(reading.supplier, 200),
    description: text(reading.description, 500),
    incurredOn: receiptDate(reading.date, hints.today),
    currency,
    amountMinor: total,
    // Tax cannot be more than what was paid.
    taxMinor: tax !== null && total !== null && tax <= total ? tax : null,
    category,
    paymentMethod: method,
    reader,
  }
}

let installed: ReceiptExtractor | null = null

/** Installs the reader for this process. The worker and the web app do it at start when a key is configured; tests install a fake. */
export function setReceiptExtractor(extractor: ReceiptExtractor | null): void {
  installed = extractor
}

export function receiptExtractor(): ReceiptExtractor | null {
  return installed
}

/** Runs the reader, never throwing: a reader that fails leaves a blank draft. */
export async function readReceipt(file: { bytes: Buffer; contentType: string }, hints: ReceiptHints, extractor = installed): Promise<ReceiptDraft | null> {
  if (!extractor || !(READABLE_RECEIPT_TYPES as readonly string[]).includes(file.contentType)) return null
  try {
    return normaliseReading(await extractor.read(file as ReceiptFile, hints), hints, extractor.name)
  } catch (error) {
    console.error(`receipt reading: ${extractor.name} failed`, error instanceof Error ? error.message : error)
    return null
  }
}

/** A reader for tests: answers what it is told to, records what it was shown, or fails on cue. */
export class FakeReceiptExtractor implements ReceiptExtractor {
  readonly name = 'fake'
  readonly calls: Array<{ contentType: string; size: number; hints: ReceiptHints }> = []
  constructor(public answer: ReceiptReading | null | Error = null) {}
  async read(file: ReceiptFile, hints: ReceiptHints): Promise<ReceiptReading | null> {
    this.calls.push({ contentType: file.contentType, size: file.bytes.byteLength, hints })
    if (this.answer instanceof Error) throw this.answer
    return this.answer
  }
}
