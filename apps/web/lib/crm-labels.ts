/**
 * Display names for CRM vocabularies. Safe for client components: the values
 * themselves are defined in packages/db and validated in packages/core.
 */

export const LEAD_STATUS_LABELS: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  disqualified: 'Disqualified',
  converted: 'Converted',
}

export const LEAD_SOURCE_LABELS: Record<string, string> = {
  website: 'Website',
  referral: 'Referral',
  inbound_email: 'Inbound email',
  phone: 'Phone',
  social: 'Social',
  event: 'Event',
  partner: 'Partner',
  outbound: 'Outbound',
  other: 'Other',
}

export const DEAL_STAGE_LABELS: Record<string, string> = {
  qualified: 'Qualified',
  proposal_sent: 'Proposal sent',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
}

export const LIFECYCLE_LABELS: Record<string, string> = {
  prospect: 'Prospect',
  client: 'Client',
  former_client: 'Former client',
}

export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  note: 'Note',
  call: 'Call',
  email: 'Email',
  meeting: 'Meeting',
}

export const label = (labels: Record<string, string>, value: string) => labels[value] ?? value

export type Option = { value: string; label: string }
export const options = (labels: Record<string, string>): Option[] =>
  Object.entries(labels).map(([value, text]) => ({ value, label: text }))
