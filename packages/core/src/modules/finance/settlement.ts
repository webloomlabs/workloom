/**
 * What state an issued invoice is in.
 *
 * One pure function, because two things decide it -- recording a payment, and
 * the nightly sweep -- and they must never disagree. Everything it needs is
 * stored on the invoice, so the answer is reproducible: given the same row on
 * the same day, it is always the same status.
 *
 * The order of the rules is the product decision:
 *
 *  - Nothing owed wins. A paid invoice is not also overdue.
 *  - A fully refunded invoice reads as refunded, not as unpaid again.
 *  - Overdue outranks partly paid, because "who is late" is the list finance
 *    works from, and a client who paid a third of it late is still late.
 *  - Otherwise the invoice is where S7b left it: opened, or merely sent.
 */

export type SettlementStatus = 'sent' | 'viewed' | 'partially_paid' | 'paid' | 'overdue' | 'refunded'

export type Settlement = {
  /** What the invoice asks for. */
  totalMinor: number
  /** Payments less refunds, maintained from the allocations by the database. */
  amountPaidMinor: number
  /** What refunds have given back, whatever is left owing. */
  refundedMinor: number
  /** The day payment is due, in the organization's time zone. */
  dueDate: string | null
  /** Whether the client has opened their link. */
  viewed: boolean
  /** Today, in the organization's time zone. Both dates are `YYYY-MM-DD`. */
  today: string
}

export function settlementStatus(s: Settlement): SettlementStatus {
  if (s.refundedMinor > 0 && s.amountPaidMinor <= 0) return 'refunded'
  // Also covers an invoice that asks for nothing: there is nothing to chase.
  if (s.totalMinor - s.amountPaidMinor <= 0) return 'paid'
  if (s.dueDate !== null && s.dueDate < s.today) return 'overdue'
  if (s.amountPaidMinor > 0) return 'partially_paid'
  return s.viewed ? 'viewed' : 'sent'
}

/** The event a move to this status announces, if any. Reaching `sent` or `viewed` again announces nothing. */
const ANNOUNCES = {
  partially_paid: 'invoice.partially_paid',
  paid: 'invoice.paid',
  overdue: 'invoice.overdue',
  refunded: 'invoice.refunded',
} as const

export function settlementEvent(from: string, to: SettlementStatus): (typeof ANNOUNCES)[keyof typeof ANNOUNCES] | null {
  if (from === to) return null
  return ANNOUNCES[to as keyof typeof ANNOUNCES] ?? null
}

/**
 * When the invoice was paid in full.
 *
 * Kept once reached and through a refund -- it is a fact about the past -- and
 * cleared only if the invoice goes back to owing something, which happens when
 * an allocation is corrected.
 */
export function paidAt(status: SettlementStatus, existing: Date | null, now: Date): Date | null {
  if (status === 'paid') return existing ?? now
  if (status === 'refunded') return existing
  return null
}
