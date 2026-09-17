import { and, desc, eq, schema } from '@workloom/db'
import type { ActorContext } from '../../context.ts'

/**
 * What the agency promised, and whether it kept it.
 *
 * Two hours are promised on every ticket: how long until someone answers, and
 * how long until it is fixed. Where the client holds a maintenance plan the
 * plan decides; otherwise the priority does.
 *
 * The targets are stored on the ticket when it is raised, never recomputed.
 * A plan renegotiated in March cannot move the target that January's ticket
 * was measured against, for the same reason an edited tax rate cannot change
 * what an issued invoice said.
 *
 * Hours are wall-clock, not business hours. An agency that promises "four
 * business hours" and an agency that promises "four hours" mean different
 * things, and inventing a working calendar here -- with its holidays, its time
 * zones, and its per-client variations -- would be inventing an answer nobody
 * asked for. The defaults below are set slack enough to be honest overnight.
 */

export type ServiceLevel = { responseHours: number | null; resolutionHours: number | null }

export const SLA_DEFAULTS: Record<(typeof schema.TICKET_PRIORITIES)[number], ServiceLevel> = {
  urgent: { responseHours: 2, resolutionHours: 8 },
  high: { responseHours: 4, resolutionHours: 24 },
  normal: { responseHours: 8, resolutionHours: 72 },
  low: { responseHours: 24, resolutionHours: 168 },
}

/**
 * The service level for a new ticket: the client's active plan if it sets one,
 * otherwise the default for the priority.
 */
export async function serviceLevelFor(
  ctx: ActorContext,
  companyId: string | null,
  priority: (typeof schema.TICKET_PRIORITIES)[number],
): Promise<ServiceLevel> {
  const fallback = SLA_DEFAULTS[priority] ?? SLA_DEFAULTS.normal
  if (!companyId) return fallback

  const [plan] = await ctx.tx
    .select({ responseHours: schema.maintenancePlans.responseHours, resolutionHours: schema.maintenancePlans.resolutionHours })
    .from(schema.maintenancePlans)
    .where(and(eq(schema.maintenancePlans.companyId, companyId), eq(schema.maintenancePlans.status, 'active')))
    // Newest plan wins where a client somehow holds two.
    .orderBy(desc(schema.maintenancePlans.startedOn), desc(schema.maintenancePlans.id))
    .limit(1)

  if (!plan) return fallback
  return {
    responseHours: plan.responseHours ?? fallback.responseHours,
    resolutionHours: plan.resolutionHours ?? fallback.resolutionHours,
  }
}

export function dueAt(from: Date, hours: number | null): Date | null {
  return hours === null ? null : new Date(from.getTime() + hours * 60 * 60 * 1000)
}

/** Where a clock stands: nothing promised, still running, met, or missed. */
export type SlaState = 'none' | 'due' | 'met' | 'breached'

/**
 * One clock's state.
 *
 * `met` and `breached` are decided by comparing the stamp against the target,
 * so they stay true forever. `due` is the only state that depends on now.
 */
export function slaState(target: Date | null, happenedAt: Date | null, now: Date): SlaState {
  if (!target) return 'none'
  if (happenedAt) return happenedAt <= target ? 'met' : 'breached'
  return now > target ? 'breached' : 'due'
}
