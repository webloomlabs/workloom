/**
 * Display names for support, maintenance, infrastructure, documents, and
 * recurring billing. Safe for client components: the values themselves are
 * defined in packages/db and validated in packages/core.
 */

export const TICKET_TYPE_LABELS: Record<string, string> = {
  bug: 'Bug',
  incident: 'Incident',
  question: 'Question',
  feature_request: 'Feature request',
  change_request: 'Change request',
  other: 'Other',
}

export const TICKET_PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

export const TICKET_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_on_client: 'Waiting on client',
  resolved: 'Resolved',
  closed: 'Closed',
}

export const SLA_STATE_LABELS: Record<string, string> = {
  none: 'No target',
  due: 'Running',
  met: 'Met',
  breached: 'Missed',
}

export const MAINTENANCE_PLAN_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
}

export const MAINTENANCE_VISIT_KIND_LABELS: Record<string, string> = {
  security_update: 'Security update',
  backup: 'Backup',
  performance_check: 'Performance check',
  uptime_check: 'Uptime check',
  content_update: 'Content update',
  review: 'Review',
  incident: 'Incident',
  other: 'Other',
}

export const ASSET_KIND_LABELS: Record<string, string> = {
  domain: 'Domain',
  hosting: 'Hosting',
  server: 'Server',
  application: 'Application',
  ssl_certificate: 'SSL certificate',
  email: 'Email',
  saas: 'SaaS',
  other: 'Other',
}

export const ASSET_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  pending: 'Pending',
  suspended: 'Suspended',
  expired: 'Expired',
  decommissioned: 'Decommissioned',
}

export const ASSET_ENVIRONMENT_LABELS: Record<string, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
  other: 'Other',
}

export const DOCUMENT_CATEGORY_LABELS: Record<string, string> = {
  contract: 'Contract',
  proposal: 'Proposal',
  brief: 'Brief',
  specification: 'Specification',
  report: 'Report',
  policy: 'Policy',
  identification: 'Identification',
  other: 'Other',
}

export const BILLING_INTERVAL_LABELS: Record<string, string> = {
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
}

export const BILLING_SCHEDULE_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
}

/** "Every month", "Every 2 weeks" -- how a schedule describes its calendar. */
export function describeInterval(unit: string, count: number): string {
  const noun = (BILLING_INTERVAL_LABELS[unit] ?? unit).toLowerCase()
  return count === 1 ? `Every ${noun}` : `Every ${count} ${noun}s`
}
