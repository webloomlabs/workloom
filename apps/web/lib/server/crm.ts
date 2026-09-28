import 'server-only'
import { formatAmount } from '@workloom/core'
import { bankAccountList, memberList, organizationGet } from '@workloom/core/modules'
import type { TimelineEntry } from '@/components/crm/activity'
import type { Choice } from '@/components/crm/fields'
import { formatDateTime } from '../format.ts'
import { call } from './procedures.ts'

/** Organization members, for owner pickers and for showing who owns what. */
export async function memberChoices(): Promise<{ choices: Choice[]; nameOf: (id: string | null) => string }> {
  const { data } = await call(memberList, {})
  const choices = data.map((m) => ({ id: m.userId, name: m.name })).sort((a, b) => a.name.localeCompare(b.name))
  const names = new Map(choices.map((c) => [c.id, c.name]))
  return { choices, nameOf: (id) => (id ? (names.get(id) ?? 'Former member') : 'Unassigned') }
}

/**
 * Open accounts money can move through, for a payment or an expense in one
 * currency, and which of them to offer first.
 *
 * Narrowed to the currency because the foreign key is: money cannot be recorded
 * into an account that is not in its currency. `allowed` is passed rather than
 * inferred, so a caller without `bankAccount:read` gets an empty list and the
 * field simply does not appear.
 */
export async function accountChoices(currency: string, allowed: boolean): Promise<{ choices: Choice[]; defaultId: string | null }> {
  if (!allowed) return { choices: [], defaultId: null }
  const { data } = await call(bankAccountList, { limit: 100 })
  const usable = data.filter((a) => a.currency === currency)
  return {
    choices: usable.map((a) => ({ id: a.id, name: a.name })),
    defaultId: usable.find((a) => a.isDefault)?.id ?? null,
  }
}

/** Base currency and time zone, for defaults and display. */
export async function organizationSettings(): Promise<{ baseCurrency: string; timezone: string }> {
  const org = await call(organizationGet, {})
  return { baseCurrency: org.baseCurrency, timezone: org.timezone }
}

export function money(valueMinor: number, currency: string): string {
  return formatAmount(valueMinor, currency)
}

type ActivityLike = {
  id: string
  type: string
  body: string
  occurredAt: Date
  authorName: string | null
  dealId: string | null
  contactId: string | null
  leadId: string | null
}

/**
 * Shapes activities for the timeline, noting where else each one is filed --
 * on a company's page, a note logged on one of its deals says so.
 */
export function timeline(
  activities: ActivityLike[],
  timezone: string,
  related: { deals?: Map<string, string>; contacts?: Map<string, string>; showLead?: boolean } = {},
): TimelineEntry[] {
  return activities.map((a) => {
    const context = [
      a.dealId && related.deals?.has(a.dealId) ? `Deal: ${related.deals.get(a.dealId)}` : null,
      a.contactId && related.contacts?.has(a.contactId) ? `With ${related.contacts.get(a.contactId)}` : null,
      a.leadId && related.showLead ? 'Logged while a lead' : null,
    ].filter(Boolean)
    return {
      id: a.id,
      type: a.type,
      body: a.body,
      when: formatDateTime(a.occurredAt, timezone),
      authorName: a.authorName,
      context: context.length > 0 ? context.join(' · ') : null,
    }
  })
}
