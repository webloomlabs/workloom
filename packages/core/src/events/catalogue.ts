/**
 * The event catalogue.
 *
 * Event names are a public contract from the moment someone points an
 * automation at them. Add new types freely; never rename or remove one. A
 * payload change that would break consumers ships as a new `version` of the
 * same type, alongside the old one.
 *
 * The whole MVP catalogue is declared now, including events whose modules
 * arrive in later slices. An integrator can subscribe to `invoice.*` today and
 * start receiving events the day invoicing ships, with nothing to reconfigure.
 */

type Definition = { description: string; /** The slice that starts emitting it. */ since: string }

const definitions = {
  'organization.updated': { description: 'Organization settings changed', since: 'S2' },

  'member.invited': { description: 'Someone was invited to the organization', since: 'S2' },
  'member.joined': { description: 'An invitation was accepted', since: 'S2' },
  'member.role_changed': { description: "A member's role changed", since: 'S2' },
  'member.removed': { description: 'A member was removed', since: 'S2' },
  'invitation.cancelled': { description: 'A pending invitation was cancelled', since: 'S2' },

  'api_key.created': { description: 'An API key was issued', since: 'S2' },
  'api_key.revoked': { description: 'An API key was revoked', since: 'S2' },

  'webhook.test': { description: 'Sent on request, to one endpoint, to check it works', since: 'S2' },

  'lead.created': { description: 'A lead was captured', since: 'S3' },
  'lead.status_changed': { description: "A lead's status changed", since: 'S3' },
  'lead.converted': { description: 'A lead became a client', since: 'S3' },
  'company.created': { description: 'A company was added', since: 'S3' },
  'company.became_client': { description: 'A company became a client', since: 'S3' },
  'contact.created': { description: 'A contact was added', since: 'S3' },
  'deal.created': { description: 'A deal was opened', since: 'S3' },
  'deal.stage_changed': { description: 'A deal moved stage', since: 'S3' },
  'deal.won': { description: 'A deal was won', since: 'S3' },
  'deal.lost': { description: 'A deal was lost', since: 'S3' },

  'project.created': { description: 'A project was created', since: 'S5' },
  'project.status_changed': { description: "A project's status changed", since: 'S5' },
  'project.completed': { description: 'A project was completed', since: 'S5' },
  'milestone.completed': { description: 'A milestone was completed', since: 'S5' },
  'task.created': { description: 'A task was created', since: 'S5' },
  'task.assigned': { description: 'A task was assigned', since: 'S5' },
  'task.completed': { description: 'A task was completed', since: 'S5' },

  'quote.sent': { description: 'A quote was sent', since: 'S7' },
  'quote.accepted': { description: 'A quote was accepted', since: 'S7' },
  'quote.declined': { description: 'A quote was declined', since: 'S7' },
  'quote.expired': { description: 'A quote passed its validity date', since: 'S7' },
  'invoice.created': { description: 'An invoice was created', since: 'S7' },
  'invoice.sent': { description: 'An invoice was sent', since: 'S7' },
  'invoice.viewed': { description: 'A client opened an invoice', since: 'S7' },
  'invoice.partially_paid': { description: 'A payment covered part of an invoice', since: 'S7' },
  'invoice.paid': { description: 'An invoice was paid in full', since: 'S7' },
  'invoice.overdue': { description: 'An invoice passed its due date unpaid', since: 'S7' },
  'invoice.cancelled': { description: 'An invoice was cancelled', since: 'S7' },
  'payment.recorded': { description: 'A payment was recorded', since: 'S7' },
  'expense.created': { description: 'An expense was recorded', since: 'S7' },
} as const satisfies Record<string, Definition>

export type EventType = keyof typeof definitions

export const EVENT_CATALOGUE: ReadonlyArray<{ type: EventType } & Definition> = Object.entries(
  definitions,
).map(([type, d]) => ({ type: type as EventType, ...d }))

export const EVENT_TYPES = EVENT_CATALOGUE.map((e) => e.type)

const TYPES = new Set<string>(EVENT_TYPES)
const FAMILIES = new Set(EVENT_TYPES.map((t) => t.split('.')[0]!))

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && TYPES.has(value)
}

/**
 * A subscription pattern is an exact type, a family (`invoice.*`), or `*`.
 * Unknown types and families are rejected when a subscription is saved --
 * a typo there would otherwise mean an endpoint that silently never fires.
 */
export function isValidPattern(pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return FAMILIES.has(pattern.slice(0, -2))
  return TYPES.has(pattern)
}

export function matchesAny(type: string, patterns: readonly string[]): boolean {
  return patterns.some(
    (p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))),
  )
}
