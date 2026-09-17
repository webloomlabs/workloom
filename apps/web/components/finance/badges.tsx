import { Badge } from '@workloom/ui'
import { label } from '@/lib/crm-labels'
import { INVOICE_STATUS_LABELS, QUOTE_STATUS_LABELS } from '@/lib/finance-labels'

const quoteTones = { draft: 'neutral', sent: 'caution', accepted: 'positive', declined: 'critical', expired: 'neutral' } as const

export function QuoteStatusBadge({ status }: { status: string }) {
  return <Badge tone={quoteTones[status as keyof typeof quoteTones] ?? 'neutral'}>{label(QUOTE_STATUS_LABELS, status)}</Badge>
}

const invoiceTones = {
  draft: 'neutral',
  sent: 'caution',
  viewed: 'caution',
  partially_paid: 'caution',
  paid: 'positive',
  overdue: 'critical',
  cancelled: 'neutral',
  refunded: 'neutral',
} as const

/** `overdue` marks an invoice past its due date before the worker has said so. */
export function InvoiceStatusBadge({ status, overdue = false }: { status: string; overdue?: boolean }) {
  if (overdue && status !== 'overdue') return <Badge tone="critical">Overdue</Badge>
  return <Badge tone={invoiceTones[status as keyof typeof invoiceTones] ?? 'neutral'}>{label(INVOICE_STATUS_LABELS, status)}</Badge>
}
