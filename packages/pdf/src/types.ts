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

export type DocumentPdfLine = {
  description: string
  quantity: string
  unitAmount: string
  /** "10%", or nothing. */
  discount?: string | null
  /** "GST 10%", or nothing. */
  tax?: string | null
  amount: string
}

export type DocumentPdfInput = {
  kind: 'quote' | 'invoice'
  /** "INV-0001", or nothing for a draft. */
  number?: string | null
  title: string
  /** Shown as a banner when it is not simply issued: "DRAFT", "CANCELLED", "PAID". */
  marker?: string | null
  issuer: DocumentParty
  client: DocumentParty
  /** Label and value pairs: issue date, due date, validity. */
  facts: Array<{ label: string; value: string }>
  taxIncluded: boolean
  lines: DocumentPdfLine[]
  totals: {
    subtotal: string
    discount?: { label: string; amount: string } | null
    taxes: Array<{ label: string; amount: string }>
    total: string
    /** Shown under the total: "In AUD at 1.52", the amount already paid, the amount due. */
    extras?: Array<{ label: string; amount: string }>
  }
  notes?: string | null
  terms?: string | null
  paymentInstructions?: string | null
}
