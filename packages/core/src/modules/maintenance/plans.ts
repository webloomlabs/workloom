import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, max, or, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import {
  actingUserId,
  assertMember,
  contains,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  requiredText,
  searchInput,
} from '../crm/shared.ts'
import { today } from '../finance/documents.ts'

/**
 * Maintenance plans.
 *
 * The agreement that follows a project: what the agency looks after, what it
 * promises to answer in, and which billing schedule pays for it. The plan
 * points at the schedule rather than restating its price, so a retainer's cost
 * has exactly one home -- ./billing-schedules.ts -- and a plan cannot disagree
 * with the invoices raised under it.
 *
 * Ending a plan is a status, not a deletion. What was done under it is history
 * a client may ask about years later, and the visits that record it hang off
 * the plan.
 */

type PlanRow = typeof schema.maintenancePlans.$inferSelect

export const maintenancePlanOutput = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  companyName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(schema.MAINTENANCE_PLAN_STATUSES),
  startedOn: z.iso.date(),
  endedOn: z.iso.date().nullable(),
  /** Hours promised, overriding the defaults for a ticket's priority. */
  responseHours: z.number().int().nullable(),
  resolutionHours: z.number().int().nullable(),
  /** Support hours included each billing period, where the plan caps them. */
  includedHours: z.string().nullable(),
  /** What it covers, in the order it is presented to the client. */
  items: z.array(z.object({ id: z.uuid(), label: z.string(), position: z.number().int() })),
  billingScheduleId: z.uuid().nullable(),
  billingScheduleName: z.string().nullable(),
  /** The period the schedule bills next. Null when nothing bills this plan. */
  nextInvoiceOn: z.iso.date().nullable(),
  ownerId: z.uuid().nullable(),
  ownerName: z.string().nullable(),
  notes: z.string().nullable(),
  visitCount: z.number().int(),
  lastVisitOn: z.iso.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type MaintenancePlan = z.infer<typeof maintenancePlanOutput>

type PlanJoin = {
  plan: PlanRow
  companyName: string
  ownerName: string | null
  scheduleName: string | null
  nextRunOn: string | null
  visitCount: number
  lastVisitOn: string | null
}

function selectPlans(ctx: ActorContext) {
  const visits = ctx.tx
    .select({
      planId: schema.maintenanceVisits.planId,
      n: count().as('n'),
      last: max(schema.maintenanceVisits.performedOn).as('last'),
    })
    .from(schema.maintenanceVisits)
    .groupBy(schema.maintenanceVisits.planId)
    .as('plan_visits')

  return ctx.tx
    .select({
      plan: schema.maintenancePlans,
      companyName: schema.companies.name,
      ownerName: schema.user.name,
      scheduleName: schema.billingSchedules.name,
      nextRunOn: schema.billingSchedules.nextRunOn,
      visitCount: sql<number>`coalesce(${visits.n}, 0)::int`,
      lastVisitOn: sql<string | null>`${visits.last}`,
    })
    .from(schema.maintenancePlans)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.maintenancePlans.companyId))
    .leftJoin(schema.user, eq(schema.user.id, schema.maintenancePlans.ownerId))
    .leftJoin(schema.billingSchedules, eq(schema.billingSchedules.id, schema.maintenancePlans.billingScheduleId))
    .leftJoin(visits, eq(visits.planId, schema.maintenancePlans.id))
}

/** The inclusions of several plans at once, so a list is two queries, not N. */
async function itemsFor(ctx: ActorContext, planIds: string[]): Promise<Map<string, MaintenancePlan['items']>> {
  const grouped = new Map<string, MaintenancePlan['items']>()
  if (planIds.length === 0) return grouped
  const rows = await ctx.tx
    .select({
      planId: schema.maintenancePlanItems.planId,
      id: schema.maintenancePlanItems.id,
      label: schema.maintenancePlanItems.label,
      position: schema.maintenancePlanItems.position,
    })
    .from(schema.maintenancePlanItems)
    .where(inArray(schema.maintenancePlanItems.planId, planIds))
    .orderBy(asc(schema.maintenancePlanItems.position))
  for (const row of rows) {
    const list = grouped.get(row.planId) ?? []
    list.push({ id: row.id, label: row.label, position: row.position })
    grouped.set(row.planId, list)
  }
  return grouped
}

async function itemsOf(ctx: ActorContext, planId: string): Promise<MaintenancePlan['items']> {
  return (await itemsFor(ctx, [planId])).get(planId) ?? []
}

function presentPlan(row: PlanJoin, items: MaintenancePlan['items']): MaintenancePlan {
  const p = row.plan
  return {
    id: p.id,
    companyId: p.companyId,
    companyName: row.companyName,
    name: p.name,
    description: p.description,
    status: p.status as MaintenancePlan['status'],
    startedOn: p.startedOn,
    endedOn: p.endedOn,
    responseHours: p.responseHours,
    resolutionHours: p.resolutionHours,
    includedHours: p.includedHours,
    items,
    billingScheduleId: p.billingScheduleId,
    billingScheduleName: row.scheduleName,
    nextInvoiceOn: row.nextRunOn,
    ownerId: p.ownerId,
    ownerName: row.ownerName,
    notes: p.notes,
    visitCount: row.visitCount,
    lastVisitOn: row.lastVisitOn,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

export async function getPlan(ctx: ActorContext, id: string): Promise<MaintenancePlan> {
  const [row] = await selectPlans(ctx).where(eq(schema.maintenancePlans.id, id)).limit(1)
  if (!row) throw new NotFoundError('Maintenance plan', id)
  return presentPlan(row, await itemsOf(ctx, id))
}

export async function loadPlan(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<PlanRow> {
  const query = ctx.tx.select().from(schema.maintenancePlans).where(eq(schema.maintenancePlans.id, id)).limit(1)
  const [row] = await (options.lock ? query.for('update') : query)
  if (!row) throw new NotFoundError('Maintenance plan', id)
  return row
}

/** The schedule a plan may point at must be the same client's, or it bills the wrong one. */
async function assertSchedule(ctx: ActorContext, companyId: string, scheduleId: string | null | undefined) {
  if (!scheduleId) return
  const [row] = await ctx.tx
    .select({ companyId: schema.billingSchedules.companyId })
    .from(schema.billingSchedules)
    .where(eq(schema.billingSchedules.id, scheduleId))
    .limit(1)
  if (!row) throw new NotFoundError('Billing schedule', scheduleId)
  if (row.companyId !== companyId) {
    throw new DomainError('That billing schedule is for a different client.', 'schedule_company_mismatch', 'billingScheduleId')
  }
}

/** Replaces the plan's inclusions with the list given, keeping their order. */
async function replaceItems(ctx: ActorContext, planId: string, labels: string[]): Promise<void> {
  await ctx.tx.delete(schema.maintenancePlanItems).where(eq(schema.maintenancePlanItems.planId, planId))
  for (const [i, label] of labels.entries()) {
    await ctx.tx.insert(schema.maintenancePlanItems).values({
      id: newId(),
      organizationId: ctx.organizationId,
      planId,
      label,
      position: i + 1,
    })
  }
}

// Reads

export const maintenancePlanList = defineProcedure({
  name: 'maintenancePlan.list',
  summary: 'Maintenance plans, newest first, filtered by client or status',
  permission: 'maintenancePlan:read',
  readOnly: true,
  input: z.object({
    companyId: z.uuid().optional(),
    status: z.enum(schema.MAINTENANCE_PLAN_STATUSES).optional(),
    q: searchInput,
    ...pageInput,
  }),
  output: pageOutput(maintenancePlanOutput),
  http: { method: 'GET', path: '/maintenance-plans' },
  async handler(ctx, input) {
    const p = schema.maintenancePlans
    if (input.companyId) await loadCompany(ctx, input.companyId)
    const conditions: Array<SQL | undefined> = [
      input.companyId ? eq(p.companyId, input.companyId) : undefined,
      input.status ? eq(p.status, input.status) : undefined,
      input.q ? or(ilike(p.name, contains(input.q)), ilike(schema.companies.name, contains(input.q))) : undefined,
      input.cursor ? lt(p.id, input.cursor) : undefined,
    ]
    const rows = await selectPlans(ctx).where(and(...conditions)).orderBy(desc(p.id)).limit(input.limit + 1)
    const items = await itemsFor(ctx, rows.map((row) => row.plan.id))
    return paginate(
      rows.map((row) => presentPlan(row, items.get(row.plan.id) ?? [])),
      input.limit,
    )
  },
})

export const maintenancePlanGet = defineProcedure({
  name: 'maintenancePlan.get',
  summary: 'One maintenance plan, with what it includes',
  permission: 'maintenancePlan:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: maintenancePlanOutput,
  http: { method: 'GET', path: '/maintenance-plans/{id}' },
  async handler(ctx, input) {
    return getPlan(ctx, input.id)
  },
})

// Writes

const planFields = {
  description: optionalText(10_000),
  responseHours: z.number().int().min(1).max(8760).nullish(),
  resolutionHours: z.number().int().min(1).max(8760).nullish(),
  includedHours: z
    .union([z.number(), z.string()])
    .transform((v) => String(v))
    .refine((v) => /^\d{1,6}(\.\d{1,2})?$/.test(v) && Number(v) > 0, 'Enter the hours included, such as 4 or 7.5.')
    .nullish(),
  /** What the plan covers, replacing whatever it covered before. */
  items: z.array(requiredText(200, 'Inclusion')).max(50).optional(),
  billingScheduleId: z.uuid().nullish(),
  ownerId: z.uuid().nullish(),
  notes: optionalText(10_000),
}

export const maintenancePlanCreate = defineProcedure({
  name: 'maintenancePlan.create',
  summary: 'Put a client on a maintenance plan',
  permission: 'maintenancePlan:create',
  input: z.object({
    companyId: z.uuid(),
    name: requiredText(200, 'Name'),
    /** Defaults to today where the organization is. */
    startedOn: z.iso.date().optional(),
    ...planFields,
  }),
  output: maintenancePlanOutput,
  http: { method: 'POST', path: '/maintenance-plans', successStatus: 201 },
  emits: ['maintenance_plan.created'],
  async handler(ctx, input) {
    const company = await loadCompany(ctx, input.companyId)
    await assertMember(ctx, input.ownerId)
    await assertSchedule(ctx, company.id, input.billingScheduleId)

    const id = newId()
    await ctx.tx.insert(schema.maintenancePlans).values({
      id,
      organizationId: ctx.organizationId,
      companyId: company.id,
      name: input.name,
      description: input.description ?? null,
      status: 'active',
      startedOn: input.startedOn ?? (await today(ctx)),
      responseHours: input.responseHours ?? null,
      resolutionHours: input.resolutionHours ?? null,
      includedHours: input.includedHours ?? null,
      billingScheduleId: input.billingScheduleId ?? null,
      ownerId: input.ownerId ?? null,
      notes: input.notes ?? null,
      createdBy: actingUserId(ctx),
    })
    await replaceItems(ctx, id, input.items ?? [])

    const plan = await getPlan(ctx, id)
    await ctx.audit({ action: 'maintenance_plan.created', entityType: 'maintenance_plan', entityId: id, entityLabel: plan.name })
    await ctx.emit('maintenance_plan.created', plan)
    return plan
  },
})

export const maintenancePlanUpdate = defineProcedure({
  name: 'maintenancePlan.update',
  summary: "Change a plan's terms, or what it includes",
  permission: 'maintenancePlan:update',
  input: z.object({
    id: z.uuid(),
    name: requiredText(200, 'Name').optional(),
    startedOn: z.iso.date().optional(),
    ...planFields,
  }),
  output: maintenancePlanOutput,
  http: { method: 'PATCH', path: '/maintenance-plans/{id}' },
  emits: ['maintenance_plan.updated'],
  async handler(ctx, input) {
    const { id, items, ...fields } = input
    const before = await loadPlan(ctx, id, { lock: true })
    await assertMember(ctx, fields.ownerId)
    if (fields.billingScheduleId !== undefined) await assertSchedule(ctx, before.companyId, fields.billingScheduleId)

    const patch = provided(fields) as Partial<PlanRow>
    const changes = diff(before as unknown as Record<string, unknown>, patch)
    if (items) await replaceItems(ctx, id, items)
    if (!changes && !items) return getPlan(ctx, id)

    await ctx.tx.update(schema.maintenancePlans).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.maintenancePlans.id, id))
    const plan = await getPlan(ctx, id)
    await ctx.audit({
      action: 'maintenance_plan.updated',
      entityType: 'maintenance_plan',
      entityId: id,
      entityLabel: plan.name,
      ...(changes ? { changes } : {}),
    })
    await ctx.emit('maintenance_plan.updated', plan)
    return plan
  },
})

export const maintenancePlanChangeStatus = defineProcedure({
  name: 'maintenancePlan.changeStatus',
  summary: 'Pause, resume, or end a plan. Ending it stops nothing else: pause its billing schedule too if that is what you mean.',
  permission: 'maintenancePlan:update',
  input: z.object({
    id: z.uuid(),
    status: z.enum(schema.MAINTENANCE_PLAN_STATUSES),
    /** The day it ended. Defaults to today when ending. */
    endedOn: z.iso.date().optional(),
  }),
  output: maintenancePlanOutput,
  http: { method: 'POST', path: '/maintenance-plans/{id}/status' },
  emits: ['maintenance_plan.status_changed'],
  async handler(ctx, input) {
    const before = await loadPlan(ctx, input.id, { lock: true })
    if (before.status === input.status && !input.endedOn) return getPlan(ctx, input.id)

    const endedOn = input.status === 'ended' ? (input.endedOn ?? before.endedOn ?? (await today(ctx))) : (input.endedOn ?? before.endedOn)
    if (endedOn && endedOn < before.startedOn) {
      throw new DomainError('A plan cannot end before it started.', 'ended_before_started', 'endedOn')
    }

    await ctx.tx
      .update(schema.maintenancePlans)
      .set({ status: input.status, endedOn: endedOn ?? null, updatedAt: ctx.now })
      .where(eq(schema.maintenancePlans.id, input.id))

    const plan = await getPlan(ctx, input.id)
    await ctx.audit({
      action: 'maintenance_plan.status_changed',
      entityType: 'maintenance_plan',
      entityId: plan.id,
      entityLabel: plan.name,
      changes: { status: { from: before.status, to: input.status } },
    })
    await ctx.emit('maintenance_plan.status_changed', plan)
    return plan
  },
})

export const maintenancePlanDelete = defineProcedure({
  name: 'maintenancePlan.delete',
  summary: 'Delete a plan and the visits recorded under it. End it instead to keep the history.',
  permission: 'maintenancePlan:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/maintenance-plans/{id}' },
  emits: ['maintenance_plan.deleted'],
  async handler(ctx, input) {
    const plan = await getPlan(ctx, input.id)
    await ctx.tx.delete(schema.maintenancePlans).where(eq(schema.maintenancePlans.id, input.id))
    await ctx.audit({ action: 'maintenance_plan.deleted', entityType: 'maintenance_plan', entityId: plan.id, entityLabel: plan.name })
    await ctx.emit('maintenance_plan.deleted', plan)
    return { deleted: true }
  },
})

/** Active plans for a client, for the client view's Maintenance tab. */
export async function countActivePlans(ctx: ActorContext, companyId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: count() })
    .from(schema.maintenancePlans)
    .where(and(eq(schema.maintenancePlans.companyId, companyId), isNull(schema.maintenancePlans.endedOn)))
  return row?.n ?? 0
}
