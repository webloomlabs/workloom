import { and, count, desc, eq, gte, lte, lt, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import { actingUserId, assertMember, optionalText, pageInput, pageOutput, paginate, requiredText } from '../crm/shared.ts'
import { today } from '../finance/documents.ts'
import { loadPlan } from './plans.ts'

/**
 * Maintenance history.
 *
 * One row per piece of work done under a plan: the update applied, the backup
 * verified, the check run. It is what a client is shown when they ask what the
 * retainer buys, and what the agency reads before renewing one.
 *
 * Minutes are recorded against the plan's included hours where anyone bothers
 * to; this is not time tracking, and it does not feed profitability. A visit
 * that took real, billable effort belongs in a time entry against a project as
 * well -- the two answer different questions.
 */

export const maintenanceVisitOutput = z.object({
  id: z.uuid(),
  planId: z.uuid(),
  planName: z.string(),
  companyId: z.uuid(),
  companyName: z.string(),
  performedOn: z.iso.date(),
  kind: z.enum(schema.MAINTENANCE_VISIT_KINDS),
  summary: z.string(),
  notes: z.string().nullable(),
  minutesSpent: z.number().int().nullable(),
  performedBy: z.uuid().nullable(),
  performedByName: z.string().nullable(),
  createdAt: z.date(),
})

export type MaintenanceVisit = z.infer<typeof maintenanceVisitOutput>

function selectVisits(ctx: ActorContext) {
  return ctx.tx
    .select({
      visit: schema.maintenanceVisits,
      planName: schema.maintenancePlans.name,
      companyId: schema.maintenancePlans.companyId,
      companyName: schema.companies.name,
      performedByName: schema.user.name,
    })
    .from(schema.maintenanceVisits)
    .innerJoin(schema.maintenancePlans, eq(schema.maintenancePlans.id, schema.maintenanceVisits.planId))
    .innerJoin(schema.companies, eq(schema.companies.id, schema.maintenancePlans.companyId))
    .leftJoin(schema.user, eq(schema.user.id, schema.maintenanceVisits.performedBy))
}

type VisitJoin = Awaited<ReturnType<ReturnType<typeof selectVisits>['execute']>>[number]

function presentVisit(row: VisitJoin): MaintenanceVisit {
  const v = row.visit
  return {
    id: v.id,
    planId: v.planId,
    planName: row.planName,
    companyId: row.companyId,
    companyName: row.companyName,
    performedOn: v.performedOn,
    kind: v.kind as MaintenanceVisit['kind'],
    summary: v.summary,
    notes: v.notes,
    minutesSpent: v.minutesSpent,
    performedBy: v.performedBy,
    performedByName: row.performedByName,
    createdAt: v.createdAt,
  }
}

export const maintenanceVisitList = defineProcedure({
  name: 'maintenanceVisit.list',
  summary: 'Maintenance performed, most recent first, for a plan or a client',
  permission: 'maintenancePlan:read',
  readOnly: true,
  input: z.object({
    planId: z.uuid().optional(),
    companyId: z.uuid().optional(),
    kind: z.enum(schema.MAINTENANCE_VISIT_KINDS).optional(),
    /** Inclusive calendar dates against the day the work was done. */
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    ...pageInput,
  }),
  output: pageOutput(maintenanceVisitOutput),
  http: { method: 'GET', path: '/maintenance-visits' },
  async handler(ctx, input) {
    const v = schema.maintenanceVisits
    if (input.planId) await loadPlan(ctx, input.planId)
    if (input.companyId) await loadCompany(ctx, input.companyId)
    const conditions: Array<SQL | undefined> = [
      input.planId ? eq(v.planId, input.planId) : undefined,
      input.companyId ? eq(schema.maintenancePlans.companyId, input.companyId) : undefined,
      input.kind ? eq(v.kind, input.kind) : undefined,
      input.from ? gte(v.performedOn, input.from) : undefined,
      input.to ? lte(v.performedOn, input.to) : undefined,
      input.cursor ? lt(v.id, input.cursor) : undefined,
    ]
    const rows = await selectVisits(ctx)
      .where(and(...conditions))
      .orderBy(desc(v.performedOn), desc(v.id))
      .limit(input.limit + 1)
    return paginate(rows.map(presentVisit), input.limit)
  },
})

export const maintenanceVisitCreate = defineProcedure({
  name: 'maintenanceVisit.create',
  summary: 'Record maintenance performed under a plan',
  permission: 'maintenancePlan:update',
  input: z.object({
    planId: z.uuid(),
    summary: requiredText(500, 'Summary'),
    /** Defaults to today where the organization is. */
    performedOn: z.iso.date().optional(),
    kind: z.enum(schema.MAINTENANCE_VISIT_KINDS).optional(),
    notes: optionalText(10_000),
    minutesSpent: z.number().int().min(1).max(10_000).nullish(),
    /** Who did it. Defaults to whoever is recording it. */
    performedBy: z.uuid().nullish(),
  }),
  output: maintenanceVisitOutput,
  http: { method: 'POST', path: '/maintenance-visits', successStatus: 201 },
  emits: ['maintenance_visit.logged'],
  async handler(ctx, input) {
    const plan = await loadPlan(ctx, input.planId)
    const performedBy = input.performedBy !== undefined ? input.performedBy : actingUserId(ctx)
    await assertMember(ctx, performedBy)

    const id = newId()
    await ctx.tx.insert(schema.maintenanceVisits).values({
      id,
      organizationId: ctx.organizationId,
      planId: plan.id,
      performedOn: input.performedOn ?? (await today(ctx)),
      kind: input.kind ?? 'other',
      summary: input.summary,
      notes: input.notes ?? null,
      minutesSpent: input.minutesSpent ?? null,
      performedBy: performedBy ?? null,
      createdBy: actingUserId(ctx),
    })

    const [row] = await selectVisits(ctx).where(eq(schema.maintenanceVisits.id, id)).limit(1)
    const visit = presentVisit(row!)
    await ctx.audit({ action: 'maintenance_visit.logged', entityType: 'maintenance_visit', entityId: id, entityLabel: visit.summary })
    await ctx.emit('maintenance_visit.logged', visit)
    return visit
  },
})

export const maintenanceVisitDelete = defineProcedure({
  name: 'maintenanceVisit.delete',
  summary: 'Delete a recorded visit',
  permission: 'maintenancePlan:update',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/maintenance-visits/{id}' },
  emits: ['maintenance_visit.deleted'],
  async handler(ctx, input) {
    const [row] = await selectVisits(ctx).where(eq(schema.maintenanceVisits.id, input.id)).limit(1)
    if (!row) throw new NotFoundError('Maintenance visit', input.id)
    const visit = presentVisit(row)
    await ctx.tx.delete(schema.maintenanceVisits).where(eq(schema.maintenanceVisits.id, input.id))
    await ctx.audit({ action: 'maintenance_visit.deleted', entityType: 'maintenance_visit', entityId: visit.id, entityLabel: visit.summary })
    await ctx.emit('maintenance_visit.deleted', visit)
    return { deleted: true }
  },
})

/** Visits recorded for a client in a window, for the plan's included-hours view. */
export async function minutesUnderPlan(ctx: ActorContext, planId: string, from: string, to: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ minutes: sql<number>`coalesce(sum(${schema.maintenanceVisits.minutesSpent}), 0)::int` })
    .from(schema.maintenanceVisits)
    .where(
      and(
        eq(schema.maintenanceVisits.planId, planId),
        gte(schema.maintenanceVisits.performedOn, from),
        lte(schema.maintenanceVisits.performedOn, to),
      ),
    )
  return row?.minutes ?? 0
}

/** Visits recorded against a client, whichever plan they were under. */
export async function countVisits(ctx: ActorContext, companyId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: count() })
    .from(schema.maintenanceVisits)
    .innerJoin(schema.maintenancePlans, eq(schema.maintenancePlans.id, schema.maintenanceVisits.planId))
    .where(eq(schema.maintenancePlans.companyId, companyId))
  return row?.n ?? 0
}
