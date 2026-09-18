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

import { isShipped } from '../release.ts'

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
  'lead.updated': { description: "A lead's details changed", since: 'S3' },
  'lead.status_changed': { description: "A lead's status changed", since: 'S3' },
  'lead.converted': { description: 'A lead was converted into a company, contact, and deal', since: 'S3' },
  'lead.archived': { description: 'A lead was archived', since: 'S3' },
  'lead.restored': { description: 'An archived lead was restored', since: 'S3' },
  'company.created': { description: 'A company was added', since: 'S3' },
  'company.updated': { description: "A company's details changed", since: 'S3' },
  'company.became_client': { description: 'A company became a client', since: 'S3' },
  'company.archived': { description: 'A company was archived', since: 'S3' },
  'company.restored': { description: 'An archived company was restored', since: 'S3' },
  'contact.created': { description: 'A contact was added', since: 'S3' },
  'contact.updated': { description: "A contact's details changed", since: 'S3' },
  'contact.archived': { description: 'A contact was archived', since: 'S3' },
  'contact.restored': { description: 'An archived contact was restored', since: 'S3' },
  'deal.created': { description: 'A deal was opened', since: 'S3' },
  'deal.updated': { description: "A deal's details changed", since: 'S3' },
  'deal.stage_changed': { description: 'A deal moved stage, including to won or lost', since: 'S3' },
  'deal.won': { description: 'A deal was won', since: 'S3' },
  'deal.lost': { description: 'A deal was lost', since: 'S3' },
  'deal.archived': { description: 'A deal was archived', since: 'S3' },
  'deal.restored': { description: 'An archived deal was restored', since: 'S3' },
  'activity.logged': { description: 'A note, call, email, or meeting was recorded', since: 'S3' },
  'activity.updated': { description: 'A recorded activity was edited', since: 'S3' },
  'activity.deleted': { description: 'A recorded activity was deleted', since: 'S3' },

  'project.created': { description: 'A project was created', since: 'S5' },
  'project.updated': { description: "A project's details changed", since: 'S5' },
  'project.status_changed': { description: "A project's status changed", since: 'S5' },
  'project.completed': { description: 'A project was completed', since: 'S5' },
  'project.archived': { description: 'A project was archived', since: 'S5' },
  'project.restored': { description: 'An archived project was restored', since: 'S5' },
  'project_member.added': { description: 'Someone was added to a project', since: 'S5' },
  'project_member.updated': { description: "A project member's role changed", since: 'S5' },
  'project_member.removed': { description: 'Someone was removed from a project', since: 'S5' },
  'milestone.created': { description: 'A milestone was added', since: 'S5' },
  'milestone.updated': { description: "A milestone's details changed", since: 'S5' },
  'milestone.completed': { description: 'A milestone was completed', since: 'S5' },
  'milestone.reopened': { description: 'A completed milestone was reopened', since: 'S5' },
  'milestone.deleted': { description: 'A milestone was deleted', since: 'S5' },
  'task.created': { description: 'A task was created', since: 'S5' },
  'task.updated': { description: "A task's details changed", since: 'S5' },
  'task.assigned': { description: 'A task was assigned', since: 'S5' },
  'task.status_changed': { description: "A task's status changed", since: 'S5' },
  'task.completed': { description: 'A task was completed', since: 'S5' },
  'task.deleted': { description: 'A task was deleted', since: 'S5' },
  'task_dependency.added': { description: 'A task was made to wait on another', since: 'S5' },
  'task_dependency.removed': { description: 'A task dependency was removed', since: 'S5' },
  'comment.created': { description: 'A comment or project update was posted', since: 'S5' },
  'comment.updated': { description: 'A comment was edited', since: 'S5' },
  'comment.deleted': { description: 'A comment was deleted', since: 'S5' },
  'attachment.added': { description: 'A file was attached', since: 'S5' },
  'attachment.deleted': { description: 'An attached file was deleted', since: 'S5' },
  'time_entry.created': { description: 'Time was logged by hand', since: 'S6' },
  'time_entry.started': { description: 'A timer was started', since: 'S6' },
  'time_entry.stopped': { description: 'A running timer was stopped', since: 'S6' },
  'time_entry.updated': { description: 'A time entry was edited', since: 'S6' },
  'time_entry.deleted': { description: 'A time entry was deleted', since: 'S6' },

  'tax_rate.created': { description: 'A tax rate was added', since: 'S7a' },
  'tax_rate.updated': { description: "A tax rate's details changed", since: 'S7a' },
  'tax_rate.archived': { description: 'A tax rate was archived', since: 'S7a' },
  'tax_rate.restored': { description: 'An archived tax rate was restored', since: 'S7a' },
  'service.created': { description: 'A service was added to the catalogue', since: 'S7a' },
  'service.updated': { description: "A service's details changed", since: 'S7a' },
  'service.archived': { description: 'A service was archived', since: 'S7a' },
  'service.restored': { description: 'An archived service was restored', since: 'S7a' },
  'quote.created': { description: 'A draft quote was created', since: 'S7a' },
  'quote.updated': { description: 'A draft quote or its lines changed', since: 'S7a' },
  'quote.deleted': { description: 'A draft quote was deleted', since: 'S7a' },
  'quote.sent': { description: 'A quote was sent', since: 'S7a' },
  'quote.accepted': { description: 'A quote was accepted', since: 'S7a' },
  'quote.declined': { description: 'A quote was declined', since: 'S7a' },
  'quote.expired': { description: 'A quote passed its validity date', since: 'S7a' },
  'invoice.created': { description: 'A draft invoice was created', since: 'S7b' },
  'invoice.updated': { description: 'A draft invoice or its lines changed', since: 'S7b' },
  'invoice.deleted': { description: 'A draft invoice was deleted', since: 'S7b' },
  'invoice.sent': { description: 'An invoice was issued and sent', since: 'S7b' },
  'invoice.viewed': { description: 'A client opened an invoice', since: 'S7b' },
  'invoice.partially_paid': { description: 'A payment covered part of an invoice', since: 'S7c' },
  'invoice.paid': { description: 'An invoice was paid in full', since: 'S7c' },
  'invoice.overdue': { description: 'An invoice passed its due date unpaid', since: 'S7c' },
  'invoice.cancelled': { description: 'An invoice was cancelled', since: 'S7b' },
  'invoice.refunded': { description: 'An invoice was refunded in full', since: 'S7c' },
  'payment.recorded': { description: 'A payment or a refund was recorded', since: 'S7c' },
  'payment.updated': { description: 'A recorded payment was corrected, or its allocations changed', since: 'S7c' },
  'payment.deleted': { description: 'A recorded payment was deleted', since: 'S7c' },
  'expense.created': { description: 'An expense was recorded', since: 'S7c' },
  'expense.updated': { description: 'An expense was edited', since: 'S7c' },
  'expense.deleted': { description: 'An expense was deleted', since: 'S7c' },

  'ticket.created': { description: 'A support ticket was raised', since: 'S11' },
  'ticket.updated': { description: "A ticket's details changed", since: 'S11' },
  'ticket.assigned': { description: 'A ticket was assigned to someone', since: 'S11' },
  'ticket.status_changed': { description: "A ticket's status changed", since: 'S11' },
  'ticket.replied': { description: 'A reply was posted on a ticket. Internal notes do not emit.', since: 'S11' },
  'ticket.resolved': { description: 'A ticket was resolved', since: 'S11' },
  'ticket.reopened': { description: 'A resolved or closed ticket was reopened', since: 'S11' },
  'ticket.closed': { description: 'A ticket was closed', since: 'S11' },
  'ticket.deleted': { description: 'A ticket was deleted', since: 'S11' },

  'maintenance_plan.created': { description: 'A maintenance plan was created', since: 'S11' },
  'maintenance_plan.updated': { description: "A maintenance plan's details or inclusions changed", since: 'S11' },
  'maintenance_plan.status_changed': { description: 'A maintenance plan was paused, resumed, or ended', since: 'S11' },
  'maintenance_plan.deleted': { description: 'A maintenance plan was deleted', since: 'S11' },
  'maintenance_visit.logged': { description: 'Maintenance work was recorded against a plan', since: 'S11' },
  'maintenance_visit.deleted': { description: 'A recorded maintenance visit was deleted', since: 'S11' },

  'infrastructure_asset.created': { description: 'A domain, host, server, or application was recorded', since: 'S11' },
  'infrastructure_asset.updated': { description: "An asset's details changed", since: 'S11' },
  'infrastructure_asset.deleted': { description: 'An asset was deleted', since: 'S11' },
  'infrastructure_asset.expiring': { description: 'An asset is approaching its renewal date', since: 'S11' },
  'infrastructure_asset.expired': { description: 'An asset passed its renewal date', since: 'S11' },

  'document.uploaded': { description: 'A document was filed against a client', since: 'S11' },
  'document.updated': { description: "A document's details changed", since: 'S11' },
  'document.deleted': { description: 'A document was deleted', since: 'S11' },

  'billing_schedule.created': { description: 'A recurring billing schedule was created', since: 'S11' },
  'billing_schedule.updated': { description: 'A schedule or its lines changed', since: 'S11' },
  'billing_schedule.status_changed': { description: 'A schedule was paused, resumed, or ended', since: 'S11' },
  'billing_schedule.invoiced': { description: 'A schedule raised a draft invoice for a period', since: 'S11' },
  'billing_schedule.deleted': { description: 'A schedule was deleted', since: 'S11' },

  'bank_account.created': { description: 'A bank, card, or cash account was added', since: 'S12' },
  'bank_account.updated': { description: "An account's details changed", since: 'S12' },
  'bank_account.archived': { description: 'An account was archived', since: 'S12' },
  'bank_account.restored': { description: 'An archived account was restored', since: 'S12' },
  'bank_account.unreconciled': { description: 'An account has statement lines nobody has explained', since: 'S12' },

  // One event per import, not one per line: a two-thousand-row statement must
  // not put two thousand rows in the outbox. The payload carries the counts.
  'bank_transaction.imported': { description: 'Statement lines were imported from a file', since: 'S12' },
  'bank_transaction.created': { description: 'A statement line was entered by hand', since: 'S12' },
  'bank_transaction.updated': { description: 'A statement line was corrected', since: 'S12' },
  'bank_transaction.deleted': { description: 'A statement line was deleted', since: 'S12' },
  'bank_transaction.matched': { description: 'A statement line was explained by a payment or an expense', since: 'S12' },
  'bank_transaction.unmatched': { description: 'An explanation was removed from a statement line', since: 'S12' },
  'bank_transaction.ignored': { description: 'A statement line was set aside with a reason', since: 'S12' },

  'bank_reconciliation.completed': { description: 'An account was reconciled to a statement', since: 'S12' },
  'bank_reconciliation.undone': { description: 'A completed reconciliation was re-opened', since: 'S12' },
} as const satisfies Record<string, Definition>

export type EventType = keyof typeof definitions

export const EVENT_CATALOGUE: ReadonlyArray<{ type: EventType; emitted: boolean } & Definition> =
  Object.entries(definitions).map(([type, d]) => ({
    type: type as EventType,
    ...d,
    // Types from later slices can be subscribed to, but nothing emits them yet.
    emitted: isShipped(d.since),
  }))

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
