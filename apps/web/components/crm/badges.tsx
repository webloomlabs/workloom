import { Badge } from '@workloom/ui'
import { DEAL_STAGE_LABELS, LEAD_STATUS_LABELS, LIFECYCLE_LABELS, label } from '@/lib/crm-labels'

const leadTones = { new: 'amber', contacted: 'neutral', qualified: 'green', disqualified: 'red', converted: 'green' } as const
const dealTones = { qualified: 'neutral', proposal_sent: 'neutral', negotiation: 'amber', won: 'green', lost: 'red' } as const
const lifecycleTones = { prospect: 'neutral', client: 'green', former_client: 'amber' } as const

export function LeadStatusBadge({ status }: { status: string }) {
  return <Badge tone={leadTones[status as keyof typeof leadTones] ?? 'neutral'}>{label(LEAD_STATUS_LABELS, status)}</Badge>
}

export function DealStageBadge({ stage }: { stage: string }) {
  return <Badge tone={dealTones[stage as keyof typeof dealTones] ?? 'neutral'}>{label(DEAL_STAGE_LABELS, stage)}</Badge>
}

export function LifecycleBadge({ stage }: { stage: string }) {
  return <Badge tone={lifecycleTones[stage as keyof typeof lifecycleTones] ?? 'neutral'}>{label(LIFECYCLE_LABELS, stage)}</Badge>
}

export function ArchivedBadge() {
  return <Badge tone="amber">Archived</Badge>
}
