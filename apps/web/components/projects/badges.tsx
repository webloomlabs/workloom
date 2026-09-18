import { Badge } from '@workloom/ui'
import { PROJECT_STATUS_LABELS, REVISION_STATUS_LABELS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, label } from './labels'

const projectTones = { planning: 'neutral', in_progress: 'positive', on_hold: 'caution', review: 'caution', completed: 'positive', cancelled: 'critical' } as const
const taskTones = { todo: 'neutral', in_progress: 'caution', in_review: 'caution', done: 'positive', cancelled: 'critical' } as const

export function ProjectStatusBadge({ status }: { status: string }) {
  return <Badge tone={projectTones[status as keyof typeof projectTones] ?? 'neutral'}>{label(PROJECT_STATUS_LABELS, status)}</Badge>
}

/**
 * Sent is the state that wants an answer, so it is the one that draws the eye.
 * Accepted is quiet: it is already reflected in what the project is contracted
 * for, and a loud badge on settled history says something needs doing.
 */
const revisionTones = { draft: 'neutral', sent: 'caution', accepted: 'positive', declined: 'critical', withdrawn: 'neutral' } as const

export function RevisionStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={revisionTones[status as keyof typeof revisionTones] ?? 'neutral'} dot={status === 'sent'}>
      {label(REVISION_STATUS_LABELS, status)}
    </Badge>
  )
}

export function TaskStatusBadge({ status }: { status: string }) {
  return <Badge tone={taskTones[status as keyof typeof taskTones] ?? 'neutral'}>{label(TASK_STATUS_LABELS, status)}</Badge>
}

export function PriorityBadge({ priority }: { priority: string }) {
  if (priority === 'normal') return null
  return <Badge tone={priority === 'urgent' ? 'critical' : priority === 'high' ? 'caution' : 'neutral'}>{label(TASK_PRIORITY_LABELS, priority)}</Badge>
}

export function BlockedBadge({ count }: { count: number }) {
  if (count === 0) return null
  return <Badge tone="critical">Waiting on {count}</Badge>
}

/** A progress bar with its figure beside it. Null progress is "not planned yet", not zero. */
export function ProgressBar({ percent, detail }: { percent: number | null; detail?: string | undefined }) {
  return (
    <div className="flex items-center gap-2" title={detail}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label={detail ?? 'Progress'}
        className="h-1.5 w-24 overflow-hidden rounded-full bg-raised"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted">{percent === null ? '—' : `${percent}%`}</span>
    </div>
  )
}
