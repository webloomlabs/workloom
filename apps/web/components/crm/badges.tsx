import { Badge } from '@workloom/ui'
import { DEAL_STAGE_LABELS, LEAD_STATUS_LABELS, LIFECYCLE_LABELS, label } from '@/lib/crm-labels'

const leadTones = { new: 'caution', contacted: 'neutral', qualified: 'positive', disqualified: 'critical', converted: 'positive' } as const
const dealTones = { qualified: 'neutral', proposal_sent: 'neutral', negotiation: 'caution', won: 'positive', lost: 'critical' } as const
const lifecycleTones = { prospect: 'neutral', client: 'positive', former_client: 'caution' } as const

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
  return <Badge tone="caution">Archived</Badge>
}
