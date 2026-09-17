import { Badge, type BadgeTone } from '@workloom/ui'
import { label } from '@/lib/crm-labels'
import {
  ASSET_STATUS_LABELS,
  BILLING_SCHEDULE_STATUS_LABELS,
  MAINTENANCE_PLAN_STATUS_LABELS,
  SLA_STATE_LABELS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
} from '@/lib/service-labels'

const ticketTones: Record<string, BadgeTone> = {
  open: 'info',
  in_progress: 'caution',
  waiting_on_client: 'neutral',
  resolved: 'positive',
  closed: 'neutral',
}

export function TicketStatusBadge({ status }: { status: string }) {
  return <Badge tone={ticketTones[status] ?? 'neutral'}>{label(TICKET_STATUS_LABELS, status)}</Badge>
}

const priorityTones: Record<string, BadgeTone> = { urgent: 'critical', high: 'caution', normal: 'neutral', low: 'neutral' }

/** Normal priority is the absence of a signal, so it does not draw one. */
export function TicketPriorityBadge({ priority }: { priority: string }) {
  if (priority === 'normal' || priority === 'low') return null
  return (
    <Badge tone={priorityTones[priority] ?? 'neutral'} dot>
      {label(TICKET_PRIORITY_LABELS, priority)}
    </Badge>
  )
}

const slaTones: Record<string, BadgeTone> = { met: 'positive', due: 'info', breached: 'critical', none: 'neutral' }

/** Where one of a ticket's two clocks stands. */
export function SlaBadge({ state, what }: { state: string; what: 'Response' | 'Resolution' }) {
  if (state === 'none') return null
  return (
    <Badge tone={slaTones[state] ?? 'neutral'}>
      {what} {label(SLA_STATE_LABELS, state).toLowerCase()}
    </Badge>
  )
}

const planTones: Record<string, BadgeTone> = { active: 'positive', paused: 'caution', ended: 'neutral' }

export function PlanStatusBadge({ status }: { status: string }) {
  return <Badge tone={planTones[status] ?? 'neutral'}>{label(MAINTENANCE_PLAN_STATUS_LABELS, status)}</Badge>
}

const assetTones: Record<string, BadgeTone> = {
  active: 'positive',
  pending: 'info',
  suspended: 'caution',
  expired: 'critical',
  decommissioned: 'neutral',
}

export function AssetStatusBadge({ status }: { status: string }) {
  return <Badge tone={assetTones[status] ?? 'neutral'}>{label(ASSET_STATUS_LABELS, status)}</Badge>
}

/**
 * How close a renewal is.
 *
 * Silent until it is worth saying something: an expiry a year away is not news,
 * and a badge on every row would make the two that matter invisible.
 */
export function ExpiryBadge({ days }: { days: number | null }) {
  if (days === null || days > 30) return null
  if (days < 0) return <Badge tone="critical">Expired {Math.abs(days)}d ago</Badge>
  if (days === 0) return <Badge tone="critical">Expires today</Badge>
  return <Badge tone={days <= 7 ? 'critical' : 'caution'}>{days}d left</Badge>
}

const scheduleTones: Record<string, BadgeTone> = { active: 'positive', paused: 'caution', ended: 'neutral' }

export function ScheduleStatusBadge({ status }: { status: string }) {
  return <Badge tone={scheduleTones[status] ?? 'neutral'}>{label(BILLING_SCHEDULE_STATUS_LABELS, status)}</Badge>
}
