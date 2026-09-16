/** Display names for finance vocabularies. Safe for client components. */

export const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
}

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  partially_paid: 'Part paid',
  paid: 'Paid',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
}

export const TAX_MODE_LABELS: Record<string, string> = {
  exclusive: 'Prices exclude tax',
  inclusive: 'Prices include tax',
}

export const PRICING_MODEL_LABELS: Record<string, string> = {
  fixed: 'Fixed price',
  hourly: 'Hourly',
  per_unit: 'Per unit',
}

export const BILLING_TYPE_LABELS: Record<string, string> = {
  one_off: 'One-off',
  recurring: 'Recurring',
}
