/**
 * How API key permissions are shown: grouped by the part of the app they
 * belong to, with names a person would use. A resource missing from the map
 * still shows up, under "Other", so a new permission is never hidden.
 */

export type ScopeGroup = { key: string; title: string; resources: Array<{ resource: string; label: string; actions: string[] }> }

const GROUPS: Array<{ key: string; title: string; resources: string[] }> = [
  { key: 'sales', title: 'Sales & clients', resources: ['lead', 'deal', 'company', 'contact', 'activity', 'document'] },
  {
    key: 'finance',
    title: 'Finance',
    resources: ['quote', 'invoice', 'payment', 'expense', 'billingSchedule', 'service', 'taxRate', 'bankAccount', 'bankTransaction', 'books', 'report'],
  },
  {
    key: 'delivery',
    title: 'Delivery',
    resources: ['project', 'projectRevision', 'projectBilling', 'milestone', 'task', 'comment', 'timeEntry', 'timeEntryAll', 'rate'],
  },
  { key: 'service', title: 'Service', resources: ['ticket', 'maintenancePlan', 'infrastructure'] },
  { key: 'workspace', title: 'Workspace', resources: ['organization', 'member', 'apiKey', 'webhook', 'integration', 'auditLog'] },
]

const LABELS: Record<string, string> = {
  lead: 'Leads',
  deal: 'Deals',
  company: 'Companies',
  contact: 'Contacts',
  activity: 'Activities',
  document: 'Client documents',
  quote: 'Quotes',
  invoice: 'Invoices',
  payment: 'Payments',
  expense: 'Expenses',
  billingSchedule: 'Billing schedules',
  service: 'Services',
  taxRate: 'Tax rates',
  bankAccount: 'Bank accounts',
  bankTransaction: 'Bank transactions',
  books: 'Books',
  report: 'Reports',
  project: 'Projects',
  projectRevision: 'Project revisions',
  projectBilling: 'Project billing',
  milestone: 'Milestones',
  task: 'Tasks',
  comment: 'Comments',
  timeEntry: 'Own time entries',
  timeEntryAll: 'Everyone’s time',
  rate: 'Hourly rates',
  ticket: 'Tickets',
  maintenancePlan: 'Maintenance plans',
  infrastructure: 'Infrastructure',
  organization: 'Organization',
  member: 'Members',
  apiKey: 'API keys',
  webhook: 'Webhooks',
  integration: 'Integrations',
  auditLog: 'Audit log',
}

const words = (camel: string) => camel.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

export const resourceLabel = (resource: string) => LABELS[resource] ?? words(resource).replace(/^./, (c) => c.toUpperCase())
export const actionLabel = (action: string) => (action === 'readFinancial' ? 'read financials' : words(action))

/** Read first -- it is what most keys need -- then the rest in a steady order. */
const byAction = (a: string, b: string) => (a === 'read' ? -1 : b === 'read' ? 1 : a.localeCompare(b))

/** The permissions someone holds, as groups of resources and their actions. Empty groups are left out. */
export function groupScopes(permissions: Iterable<string>): ScopeGroup[] {
  const actions = new Map<string, string[]>()
  for (const permission of permissions) {
    const [resource, action] = permission.split(':') as [string, string]
    if (!resource || !action) continue
    actions.set(resource, [...(actions.get(resource) ?? []), action])
  }
  const placed = new Set<string>()
  const groups: ScopeGroup[] = []
  for (const group of GROUPS) {
    const resources = group.resources.filter((r) => actions.has(r))
    resources.forEach((r) => placed.add(r))
    if (resources.length > 0) groups.push({ key: group.key, title: group.title, resources: resources.map((r) => ({ resource: r, label: resourceLabel(r), actions: actions.get(r)!.sort(byAction) })) })
  }
  const rest = [...actions.keys()].filter((r) => !placed.has(r)).sort()
  if (rest.length > 0) groups.push({ key: 'other', title: 'Other', resources: rest.map((r) => ({ resource: r, label: resourceLabel(r), actions: actions.get(r)!.sort(byAction) })) })
  return groups
}
