/** Display names for project vocabularies. Safe for client components. */

export const PROJECT_STATUS_LABELS: Record<string, string> = {
  planning: 'Planning',
  in_progress: 'In progress',
  on_hold: 'On hold',
  review: 'Review',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export const TASK_STATUS_LABELS: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
}

export const TASK_PRIORITY_LABELS: Record<string, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}

export const MEMBER_ROLE_LABELS: Record<string, string> = {
  manager: 'Manager',
  member: 'Member',
}

/** Highest first, for sorting a board. */
export const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

/** Minutes as "1.5h" for display and editing. */
export const minutesToHours = (minutes: number | null) =>
  minutes === null ? '' : String(Math.round((minutes / 60) * 100) / 100)

export const REVISION_KIND_LABELS: Record<string, string> = {
  variation: 'Variation',
  extension: 'Extension',
}

export const REVISION_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

export const PROJECT_BILLING_MODEL_LABELS: Record<string, string> = {
  fixed_price: 'Fixed price',
  retainer: 'Retainer',
  time_and_materials: 'Time and materials',
  non_billable: 'Not billed',
}

export const BUDGET_PERIOD_LABELS: Record<string, string> = {
  total: 'The whole project',
  week: 'Each week',
  month: 'Each month',
  quarter: 'Each quarter',
  year: 'Each year',
}
