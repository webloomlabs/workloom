/**
 * Display names for banking. Safe for client components: the values themselves
 * are defined in packages/db and validated in packages/core.
 */

export const BANK_ACCOUNT_KIND_LABELS: Record<string, string> = {
  bank: 'Bank account',
  credit_card: 'Credit card',
  cash: 'Cash',
  paypal: 'PayPal',
  stripe: 'Stripe',
  other: 'Other',
}

export const BANK_TRANSACTION_STATUS_LABELS: Record<string, string> = {
  unexplained: 'Unexplained',
  part_explained: 'Part explained',
  explained: 'Explained',
  reconciled: 'Reconciled',
  ignored: 'Set aside',
}

export const BANK_DIRECTION_LABELS: Record<string, string> = {
  in: 'Money in',
  out: 'Money out',
}
