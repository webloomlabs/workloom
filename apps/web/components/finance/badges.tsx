import { Badge } from '@workloom/ui'
import { label } from '@/lib/crm-labels'
import { QUOTE_STATUS_LABELS } from '@/lib/finance-labels'

const quoteTones = { draft: 'neutral', sent: 'amber', accepted: 'green', declined: 'red', expired: 'neutral' } as const

export function QuoteStatusBadge({ status }: { status: string }) {
  return <Badge tone={quoteTones[status as keyof typeof quoteTones] ?? 'neutral'}>{label(QUOTE_STATUS_LABELS, status)}</Badge>
}
