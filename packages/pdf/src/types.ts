/**
 * What a printed quote or invoice contains.
 *
 * Plain data, already formatted by the caller: this package decides layout, not
 * what an amount or a date looks like.
 */

export type DocumentParty = {
  name: string
  addressLines?: string[]
  taxNumber?: string | null
  email?: string | null
  phone?: string | null
}

/** A raster image, passed as bytes: the renderer never fetches anything. */
export type DocumentImage = { data: Uint8Array; format: 'png' | 'jpg' }

export type DocumentPdfLine = {
  /** The line's title, in bold. */
  title: string
  /** A quieter second line: "Initially quoted project fee", "Additional scope". */
  subtitle?: string | null
  /** "One-time", "Monthly", "3 months · Jan–Mar 2026". Shown when the billing column is. */
  billing?: string | null
  quantity: string
  unitAmount?: string | null
  /** "10%", or nothing. */
  discount?: string | null
  /** "GST 10%", or nothing. */
  tax?: string | null
  amount: string
}

export type DocumentPdfTotalRow = {
  label: string
  amount: string
  /** `strong` for a total that matters, `muted` for a note under one. */
  style?: 'normal' | 'strong' | 'muted'
}

export type DocumentPdfInput = {
  kind: 'quote' | 'invoice'
  /** "WL-2026-0144", or nothing for a draft. */
  number?: string | null
  title: string
  /** Shown as a banner when it is not simply issued: "DRAFT", "CANCELLED", "PAID". */
  marker?: string | null
  issuer: DocumentParty & { logo?: DocumentImage | null }
  client: DocumentParty
  /** Label and value pairs under the number: the date, when it is due, how long it is valid. */
  facts: Array<{ label: string; value: string }>
  /** The accent colour, "#0b8a5e". Defaults to a dark green. */
  accentColor?: string | null
  /** The figure printed large beside the client: "BALANCE DUE  LKR 54,000.00", with a caption under it. */
  headline?: { label: string; amount: string; caption?: string | null } | null
  /** The currency code the amount column is headed with: "AMOUNT (LKR)". */
  currency: string
  /** Which optional columns the table has. Description, quantity, and amount always print. */
  columns: { billing: boolean; unitPrice: boolean; discount: boolean; tax: boolean }
  taxIncluded: boolean
  lines: DocumentPdfLine[]
  totals: {
    /** Rows above the bar: Subtotal, taxes; or Project total, Already paid. */
    rows: DocumentPdfTotalRow[]
    /** The highlighted last line: "Balance Due  LKR 54,000.00", or "Total". */
    bar: { label: string; amount: string }
    /** Notes under the bar: "Includes VAT 18%", the total in the base currency. */
    after?: DocumentPdfTotalRow[]
  }
  /** Bank details as label/value rows: Account Name, Account Number, Bank, Branch. */
  paymentDetails?: Array<{ label: string; value: string }>
  /** Free-text payment instructions, printed when there are no structured details, or under them. */
  paymentInstructions?: string | null
  notes?: string | null
  terms?: string | null
  /** A closing line in the accent colour: "Thank you for your business." */
  closing?: string | null
  /** The last line of every page: "This is a computer-generated invoice and is valid without a signature." */
  footer?: string | null
}
