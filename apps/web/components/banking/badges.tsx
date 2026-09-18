import { Badge, type BadgeTone } from '@workloom/ui'
import { label } from '@/lib/crm-labels'
import { BANK_TRANSACTION_STATUS_LABELS } from '@/lib/banking-labels'

/**
 * Unexplained is the state this module exists to clear, so it is the one that
 * draws the eye. Reconciled is deliberately quiet: a closed period is settled,
 * and a page full of loud badges says nothing needs doing when something does.
 */
const statusTones: Record<string, BadgeTone> = {
  unexplained: 'caution',
  part_explained: 'caution',
  explained: 'positive',
  reconciled: 'neutral',
  ignored: 'neutral',
}

export function BankStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={statusTones[status] ?? 'neutral'} dot={status === 'unexplained' || status === 'part_explained'}>
      {label(BANK_TRANSACTION_STATUS_LABELS, status)}
    </Badge>
  )
}

/**
 * How many lines an account is waiting on. Absent when there are none, because
 * a zero here is the normal state and does not need announcing.
 */
export function UnexplainedBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <Badge tone="caution" dot>
      {count} to explain
    </Badge>
  )
}
