import { Badge } from '@workloom/ui'
import { PROJECT_STATUS_LABELS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, label } from './labels'

const projectTones = { planning: 'neutral', in_progress: 'green', on_hold: 'amber', review: 'amber', completed: 'green', cancelled: 'red' } as const
const taskTones = { todo: 'neutral', in_progress: 'amber', in_review: 'amber', done: 'green', cancelled: 'red' } as const

export function ProjectStatusBadge({ status }: { status: string }) {
  return <Badge tone={projectTones[status as keyof typeof projectTones] ?? 'neutral'}>{label(PROJECT_STATUS_LABELS, status)}</Badge>
}

export function TaskStatusBadge({ status }: { status: string }) {
  return <Badge tone={taskTones[status as keyof typeof taskTones] ?? 'neutral'}>{label(TASK_STATUS_LABELS, status)}</Badge>
}

export function PriorityBadge({ priority }: { priority: string }) {
  if (priority === 'normal') return null
  return <Badge tone={priority === 'urgent' ? 'red' : priority === 'high' ? 'amber' : 'neutral'}>{label(TASK_PRIORITY_LABELS, priority)}</Badge>
}

export function BlockedBadge({ count }: { count: number }) {
  if (count === 0) return null
  return <Badge tone="red">Waiting on {count}</Badge>
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
        className="h-1.5 w-24 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
      >
        <div className="h-full rounded-full bg-neutral-900 dark:bg-neutral-100" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <span className="text-xs tabular-nums text-neutral-500">{percent === null ? '—' : `${percent}%`}</span>
    </div>
  )
}
