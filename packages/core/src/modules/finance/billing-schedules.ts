import { and, asc, count, desc, eq, ilike, inArray, isNotNull, lt, lte, max, or, schema, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from '../crm/companies.ts'
import { loadContact } from '../crm/contacts.ts'
import {
  actingUserId,
  assertMember,
  baseCurrency,
  contains,
  currencyCode,
  optionalText,
  pageInput,
  pageOutput,
  paginate,
  provided,
  requiredText,
  searchInput,
} from '../crm/shared.ts'
import { loadProject } from '../projects/projects.ts'
import { lineInput, newLineValues, today, type LineInput } from './documents.ts'
import { getInvoice, recalculate, type Invoice } from './invoices.ts'
import { periodEnd, periodIndexOf, periodStart, type Interval } from './recurrence.ts'
import { fromNumeric } from './shared.ts'

/**
 * Recurring billing.
 *
 * A schedule is an invoice that has not happened yet, plus a calendar. When a
 * period comes due the schedule raises a **draft** invoice and stops: an
 * invoice is a statement to a client, and the last thing to read one before it
 * goes out should be a person. Issuing it is the same `invoice.send` as any
 * other, with the same numbering, the same email, and the same audit entry.
 *
 * Two things make double-billing impossible rather than unlikely. The period is
 * recorded in `billing_schedule_invoices` with a unique key on
 * `(schedule, period_start)`, so a retried job inserting the same period fails
 * on the constraint; and `next_run_on` advances in the same transaction that
 * raises the invoice, so if either half rolls back, both do.
 */

type ScheduleRow = typeof schema.billingSchedules.$inferSelect
type ScheduleLineRow = typeof schema.billingScheduleLines.$inferSelect

/** How many periods one sweep will catch up, for a schedule that starts in the past. */
const MAX_CATCH_UP = 12

/**
 * Why a schedule cannot raise its next invoice.
 *
 * Checked before anything is attempted rather than caught afterwards: the
 * sweep runs every schedule in one transaction, and an exception halfway
 * through would abort the ones behind it. Each reason is reported on the
 * schedule itself, so the person who set it up sees why nothing is being
 * billed instead of wondering.
 */
export const SCHEDULE_BLOCKERS = ['no_lines', 'client_archived', 'service_archived', 'tax_rate_archived'] as const
export type ScheduleBlocker = (typeof SCHEDULE_BLOCKERS)[number]

export const BLOCKER_MESSAGES: Record<ScheduleBlocker, string> = {
  no_lines: 'This schedule has no lines, so there is nothing to bill.',
  client_archived: 'This client is archived. Restore them, or end the schedule.',
  service_archived: 'A service on this schedule has been archived. Replace the line or restore the service.',
  tax_rate_archived: 'A tax rate on this schedule has been archived. Replace the line or restore the tax rate.',
}

/** The first reason this schedule cannot bill, or null when it can. */
export async function scheduleBlocker(ctx: ActorContext, scheduleId: string): Promise<ScheduleBlocker | null> {
  const lines = await ctx.tx
    .select({
      serviceArchived: schema.services.archivedAt,
      taxArchived: schema.taxRates.archivedAt,
      serviceId: schema.billingScheduleLines.serviceId,
      taxRateId: schema.billingScheduleLines.taxRateId,
    })
    .from(schema.billingScheduleLines)
    .leftJoin(schema.services, eq(schema.services.id, schema.billingScheduleLines.serviceId))
    .leftJoin(schema.taxRates, eq(schema.taxRates.id, schema.billingScheduleLines.taxRateId))
    .where(eq(schema.billingScheduleLines.scheduleId, scheduleId))
  if (lines.length === 0) return 'no_lines'
  if (lines.some((line) => line.serviceId && line.serviceArchived)) return 'service_archived'
  if (lines.some((line) => line.taxRateId && line.taxArchived)) return 'tax_rate_archived'

  const [company] = await ctx.tx
    .select({ archivedAt: schema.companies.archivedAt })
    .from(schema.billingSchedules)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.billingSchedules.companyId))
    .where(eq(schema.billingSchedules.id, scheduleId))
    .limit(1)
  return company?.archivedAt ? 'client_archived' : null
}

export const billingScheduleLineOutput = z.object({
  id: z.uuid(),
  position: z.number().int(),
  serviceId: z.uuid().nullable(),
  description: z.string(),
  quantity: z.string(),
  unitAmountMinor: z.number().int(),
  discountPercent: z.string().nullable(),
  taxRateId: z.uuid().nullable(),
})

export const billingScheduleOutput = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  companyName: z.string(),
  contactId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
  name: z.string(),
  status: z.enum(schema.BILLING_SCHEDULE_STATUSES),
  currency: z.string().length(3),
  taxMode: z.enum(schema.TAX_MODES),
  paymentTermsDays: z.number().int(),
  intervalUnit: z.enum(schema.BILLING_INTERVALS),
  intervalCount: z.number().int(),
  startOn: z.iso.date(),
  /** The first day of the period that bills next. Null once the schedule has ended. */
  nextRunOn: z.iso.date().nullable(),
  /** The last day of that period. */
  nextPeriodEndsOn: z.iso.date().nullable(),
  endOn: z.iso.date().nullable(),
  maxOccurrences: z.number().int().nullable(),
  generatedCount: z.number().int(),
  /** What one period comes to, before tax and before any document discount. */
  periodSubtotalMinor: z.number().int(),
  /** Why this schedule cannot bill, where it cannot. Null when it is fine. */
  blocker: z.enum(SCHEDULE_BLOCKERS).nullable(),
  blockerMessage: z.string().nullable(),
  lines: z.array(billingScheduleLineOutput),
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  ownerId: z.uuid().nullable(),
  ownerName: z.string().nullable(),
  lastRunAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type BillingSchedule = z.infer<typeof billingScheduleOutput>

type ScheduleJoin = { schedule: ScheduleRow; companyName: string; projectName: string | null; ownerName: string | null }

function selectSchedules(ctx: ActorContext) {
  return ctx.tx
    .select({
      schedule: schema.billingSchedules,
      companyName: schema.companies.name,
      projectName: schema.projects.name,
      ownerName: schema.user.name,
    })
    .from(schema.billingSchedules)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.billingSchedules.companyId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.billingSchedules.projectId))
    .leftJoin(schema.user, eq(schema.user.id, schema.billingSchedules.ownerId))
}

async function linesFor(ctx: ActorContext, scheduleIds: string[]): Promise<Map<string, ScheduleLineRow[]>> {
  const grouped = new Map<string, ScheduleLineRow[]>()
  if (scheduleIds.length === 0) return grouped
  const rows = await ctx.tx
    .select()
    .from(schema.billingScheduleLines)
    .where(inArray(schema.billingScheduleLines.scheduleId, scheduleIds))
    .orderBy(asc(schema.billingScheduleLines.position))
  for (const row of rows) {
    const list = grouped.get(row.scheduleId) ?? []
    list.push(row)
    grouped.set(row.scheduleId, list)
  }
  return grouped
}

/** What one period costs, before tax: the figure a retainer is described by. */
function subtotal(lines: ScheduleLineRow[]): number {
  return lines.reduce((total, line) => {
    const gross = Math.round(Number(line.quantity) * line.unitAmountMinor)
    const discount = line.discountPercent ? Math.round((gross * Number(line.discountPercent)) / 100) : 0
    return total + gross - discount
  }, 0)
}

function presentSchedule(row: ScheduleJoin, lines: ScheduleLineRow[], blocker: ScheduleBlocker | null): BillingSchedule {
  const s = row.schedule
  const unit = s.intervalUnit as Interval
  const index = s.nextRunOn ? periodIndexOf(s.startOn, unit, s.intervalCount, s.nextRunOn) : null
  return {
    id: s.id,
    companyId: s.companyId,
    companyName: row.companyName,
    contactId: s.contactId,
    projectId: s.projectId,
    projectName: row.projectName,
    name: s.name,
    status: s.status as BillingSchedule['status'],
    currency: s.currency,
    taxMode: s.taxMode as BillingSchedule['taxMode'],
    paymentTermsDays: s.paymentTermsDays,
    intervalUnit: unit,
    intervalCount: s.intervalCount,
    startOn: s.startOn,
    nextRunOn: s.nextRunOn,
    nextPeriodEndsOn: index === null ? null : periodEnd(s.startOn, unit, s.intervalCount, index),
    endOn: s.endOn,
    maxOccurrences: s.maxOccurrences,
    generatedCount: s.generatedCount,
    periodSubtotalMinor: subtotal(lines),
    blocker,
    blockerMessage: blocker ? BLOCKER_MESSAGES[blocker] : null,
    lines: lines.map((line) => ({
      id: line.id,
      position: line.position,
      serviceId: line.serviceId,
      description: line.description,
      quantity: fromNumeric(line.quantity) ?? '1',
      unitAmountMinor: line.unitAmountMinor,
      discountPercent: fromNumeric(line.discountPercent),
      taxRateId: line.taxRateId,
    })),
    notes: s.notes,
    terms: s.terms,
    ownerId: s.ownerId,
    ownerName: row.ownerName,
    lastRunAt: s.lastRunAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

export async function getSchedule(ctx: ActorContext, id: string): Promise<BillingSchedule> {
  const [row] = await selectSchedules(ctx).where(eq(schema.billingSchedules.id, id)).limit(1)
  if (!row) throw new NotFoundError('Billing schedule', id)
  return presentSchedule(row, (await linesFor(ctx, [id])).get(id) ?? [], await scheduleBlocker(ctx, id))
}

export async function loadSchedule(ctx: ActorContext, id: string, options: { lock?: boolean } = {}): Promise<ScheduleRow> {
  const query = ctx.tx.select().from(schema.billingSchedules).where(eq(schema.billingSchedules.id, id)).limit(1)
  const [row] = await (options.lock ? query.for('update') : query)
  if (!row) throw new NotFoundError('Billing schedule', id)
  return row
}

// Reads

export const billingScheduleList = defineProcedure({
  name: 'billingSchedule.list',
  summary: 'Recurring billing schedules, newest first, filtered by client or status',
  permission: 'billingSchedule:read',
  readOnly: true,
  input: z.object({
    companyId: z.uuid().optional(),
    status: z.enum(schema.BILLING_SCHEDULE_STATUSES).optional(),
    /** Schedules whose next period has already arrived. */
    due: z.coerce.boolean().optional(),
    q: searchInput,
    ...pageInput,
  }),
  output: pageOutput(billingScheduleOutput),
  http: { method: 'GET', path: '/billing-schedules' },
  async handler(ctx, input) {
    const s = schema.billingSchedules
    if (input.companyId) await loadCompany(ctx, input.companyId)
    const conditions: Array<SQL | undefined> = [
      input.companyId ? eq(s.companyId, input.companyId) : undefined,
      input.status ? eq(s.status, input.status) : undefined,
      input.due ? and(eq(s.status, 'active'), isNotNull(s.nextRunOn), lte(s.nextRunOn, await today(ctx))) : undefined,
      input.q ? or(ilike(s.name, contains(input.q)), ilike(schema.companies.name, contains(input.q))) : undefined,
      input.cursor ? lt(s.id, input.cursor) : undefined,
    ]
    const rows = await selectSchedules(ctx).where(and(...conditions)).orderBy(desc(s.id)).limit(input.limit + 1)
    const lines = await linesFor(ctx, rows.map((row) => row.schedule.id))
    const blockers = new Map(
      await Promise.all(rows.map(async (row) => [row.schedule.id, await scheduleBlocker(ctx, row.schedule.id)] as const)),
    )
    return paginate(
      rows.map((row) => presentSchedule(row, lines.get(row.schedule.id) ?? [], blockers.get(row.schedule.id) ?? null)),
      input.limit,
    )
  },
})

export const billingScheduleGet = defineProcedure({
  name: 'billingSchedule.get',
  summary: 'One schedule, with the lines each period bills',
  permission: 'billingSchedule:read',
  readOnly: true,
  input: z.object({ id: z.uuid() }),
  output: billingScheduleOutput,
  http: { method: 'GET', path: '/billing-schedules/{id}' },
  async handler(ctx, input) {
    return getSchedule(ctx, input.id)
  },
})

export const billingScheduleInvoiceList = defineProcedure({
  name: 'billingSchedule.invoices',
  summary: 'The invoices a schedule has raised, and the period each one bills',
  permission: 'billingSchedule:read',
  readOnly: true,
  input: z.object({ id: z.uuid(), ...pageInput }),
  output: pageOutput(
    z.object({
      id: z.uuid(),
      invoiceId: z.uuid(),
      invoiceNumber: z.string().nullable(),
      invoiceStatus: z.enum(schema.INVOICE_STATUSES),
      totalMinor: z.number().int(),
      currency: z.string().length(3),
      periodStart: z.iso.date(),
      periodEnd: z.iso.date(),
      createdAt: z.date(),
    }),
  ),
  http: { method: 'GET', path: '/billing-schedules/{id}/invoices' },
  async handler(ctx, input) {
    await loadSchedule(ctx, input.id)
    const b = schema.billingScheduleInvoices
    const rows = await ctx.tx
      .select({
        id: b.id,
        invoiceId: b.invoiceId,
        invoiceNumber: schema.invoices.number,
        invoiceStatus: schema.invoices.status,
        totalMinor: schema.invoices.totalMinor,
        currency: schema.invoices.currency,
        periodStart: b.periodStart,
        periodEnd: b.periodEnd,
        createdAt: b.createdAt,
      })
      .from(b)
      .innerJoin(schema.invoices, eq(schema.invoices.id, b.invoiceId))
      .where(and(eq(b.scheduleId, input.id), input.cursor ? lt(b.id, input.cursor) : undefined))
      .orderBy(desc(b.periodStart))
      .limit(input.limit + 1)
    return paginate(rows as Array<(typeof rows)[number] & { invoiceStatus: (typeof schema.INVOICE_STATUSES)[number] }>, input.limit)
  },
})

// Writes

const scheduleFields = {
  contactId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  taxMode: z.enum(schema.TAX_MODES).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  /** Stops on or before this date. */
  endOn: z.iso.date().nullish(),
  /** Stops after this many invoices. */
  maxOccurrences: z.number().int().min(1).max(1000).nullish(),
  notes: optionalText(10_000),
  terms: optionalText(10_000),
  ownerId: z.uuid().nullish(),
}

async function resolveScheduleLinks(
  ctx: ActorContext,
  companyId: string,
  input: { contactId?: string | null | undefined; projectId?: string | null | undefined },
) {
  if (input.contactId) {
    const contact = await loadContact(ctx, input.contactId)
    if (contact.companyId !== companyId) throw new DomainError('That contact works for a different client.', 'contact_company_mismatch', 'contactId')
  }
  if (input.projectId) {
    const project = await loadProject(ctx, input.projectId)
    if (project.companyId !== companyId) throw new DomainError('That project is for a different client.', 'project_company_mismatch', 'projectId')
  }
}

export const billingScheduleCreate = defineProcedure({
  name: 'billingSchedule.create',
  summary: 'Set up recurring billing for a client. It raises a draft invoice each period; nobody sends anything automatically.',
  permission: 'billingSchedule:create',
  input: z.object({
    companyId: z.uuid(),
    name: requiredText(200, 'Name'),
    /** Defaults to the organization's base currency. */
    currency: currencyCode.optional(),
    intervalUnit: z.enum(schema.BILLING_INTERVALS).optional(),
    intervalCount: z.number().int().min(1).max(52).optional(),
    /** The first day the schedule bills for. Defaults to today. */
    startOn: z.iso.date().optional(),
    lines: z.array(lineInput).max(100).default([]),
    ...scheduleFields,
  }),
  output: billingScheduleOutput,
  http: { method: 'POST', path: '/billing-schedules', successStatus: 201 },
  emits: ['billing_schedule.created'],
  async handler(ctx, input) {
    const company = await loadCompany(ctx, input.companyId)
    await resolveScheduleLinks(ctx, company.id, input)
    await assertMember(ctx, input.ownerId)

    const startOn = input.startOn ?? (await today(ctx))
    if (input.endOn && input.endOn < startOn) {
      throw new DomainError('The end date is before the schedule starts.', 'ends_before_start', 'endOn')
    }

    const id = newId()
    const currency = input.currency ?? (await baseCurrency(ctx))
    await ctx.tx.insert(schema.billingSchedules).values({
      id,
      organizationId: ctx.organizationId,
      companyId: company.id,
      contactId: input.contactId ?? null,
      projectId: input.projectId ?? null,
      name: input.name,
      status: 'active',
      currency,
      taxMode: input.taxMode ?? 'exclusive',
      paymentTermsDays: input.paymentTermsDays ?? 14,
      intervalUnit: input.intervalUnit ?? 'month',
      intervalCount: input.intervalCount ?? 1,
      startOn,
      nextRunOn: startOn,
      endOn: input.endOn ?? null,
      maxOccurrences: input.maxOccurrences ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      ownerId: input.ownerId ?? null,
      createdBy: actingUserId(ctx),
    })

    for (const [i, line] of input.lines.entries()) {
      await insertLine(ctx, { id, currency }, line, i + 1, `lines.${i}.`)
    }

    const schedule = await getSchedule(ctx, id)
    await ctx.audit({ action: 'billing_schedule.created', entityType: 'billing_schedule', entityId: id, entityLabel: schedule.name })
    await ctx.emit('billing_schedule.created', schedule)
    return schedule
  },
})

/** One line, priced from the catalogue where the input leaves gaps. */
async function insertLine(ctx: ActorContext, schedule: { id: string; currency: string }, line: LineInput, position: number, field = '') {
  const values = await newLineValues(ctx, schedule, line, field)
  const id = newId()
  await ctx.tx.insert(schema.billingScheduleLines).values({
    id,
    organizationId: ctx.organizationId,
    scheduleId: schedule.id,
    position,
    serviceId: values.serviceId,
    description: values.description,
    quantity: values.quantity,
    unitAmountMinor: values.unitAmountMinor,
    discountPercent: values.discountPercent,
    taxRateId: values.taxRateId,
  })
  return id
}

export const billingScheduleUpdate = defineProcedure({
  name: 'billingSchedule.update',
  summary: "Change a schedule. Invoices already raised are untouched -- they are statements that were already made.",
  permission: 'billingSchedule:update',
  input: z.object({
    id: z.uuid(),
    name: requiredText(200, 'Name').optional(),
    /** Only while nothing has been billed: prices are in the currency they were entered in. */
    currency: currencyCode.optional(),
    intervalUnit: z.enum(schema.BILLING_INTERVALS).optional(),
    intervalCount: z.number().int().min(1).max(52).optional(),
    /** Moves the anchor, and with it every future period. */
    startOn: z.iso.date().optional(),
    ...scheduleFields,
  }),
  output: billingScheduleOutput,
  http: { method: 'PATCH', path: '/billing-schedules/{id}' },
  emits: ['billing_schedule.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadSchedule(ctx, id, { lock: true })
    await resolveScheduleLinks(ctx, before.companyId, fields)
    await assertMember(ctx, fields.ownerId)

    if (fields.currency && fields.currency !== before.currency && before.generatedCount > 0) {
      throw new DomainError('This schedule has already billed. Its currency can no longer change.', 'currency_locked', 'currency')
    }

    const patch = provided(fields) as Partial<ScheduleRow>
    // Re-anchoring the calendar has to leave the next run on a real period
    // boundary, or every later period would be measured from nothing.
    const startOn = patch.startOn ?? before.startOn
    const unit = (patch.intervalUnit ?? before.intervalUnit) as Interval
    const countPer = patch.intervalCount ?? before.intervalCount
    if (before.status !== 'ended' && (patch.startOn || patch.intervalUnit || patch.intervalCount)) {
      const from = before.nextRunOn ?? startOn
      const index = from <= startOn ? 0 : periodIndexOf(startOn, unit, countPer, from) + 1
      patch.nextRunOn = periodStart(startOn, unit, countPer, index)
    }
    const endOn = patch.endOn !== undefined ? patch.endOn : before.endOn
    if (endOn && endOn < startOn) throw new DomainError('The end date is before the schedule starts.', 'ends_before_start', 'endOn')

    const changes = diff(before as unknown as Record<string, unknown>, patch)
    if (!changes) return getSchedule(ctx, id)

    await ctx.tx.update(schema.billingSchedules).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.billingSchedules.id, id))
    const schedule = await getSchedule(ctx, id)
    await ctx.audit({ action: 'billing_schedule.updated', entityType: 'billing_schedule', entityId: id, entityLabel: schedule.name, changes })
    await ctx.emit('billing_schedule.updated', schedule)
    return schedule
  },
})

export const billingScheduleChangeStatus = defineProcedure({
  name: 'billingSchedule.changeStatus',
  summary: 'Pause, resume, or end a schedule. A paused schedule bills nothing and skips no period: it resumes where it left off.',
  permission: 'billingSchedule:update',
  input: z.object({ id: z.uuid(), status: z.enum(schema.BILLING_SCHEDULE_STATUSES) }),
  output: billingScheduleOutput,
  http: { method: 'POST', path: '/billing-schedules/{id}/status' },
  emits: ['billing_schedule.status_changed'],
  async handler(ctx, input) {
    const before = await loadSchedule(ctx, input.id, { lock: true })
    if (before.status === input.status) return getSchedule(ctx, input.id)

    // Ending clears the next run; the check constraint insists the two agree.
    // Resuming an ended schedule puts it back on the next unbilled period.
    const unit = before.intervalUnit as Interval
    const nextRunOn =
      input.status === 'ended'
        ? null
        : (before.nextRunOn ?? periodStart(before.startOn, unit, before.intervalCount, before.generatedCount))

    await ctx.tx
      .update(schema.billingSchedules)
      .set({ status: input.status, nextRunOn, updatedAt: ctx.now })
      .where(eq(schema.billingSchedules.id, input.id))

    const schedule = await getSchedule(ctx, input.id)
    await ctx.audit({
      action: 'billing_schedule.status_changed',
      entityType: 'billing_schedule',
      entityId: schedule.id,
      entityLabel: schedule.name,
      changes: { status: { from: before.status, to: input.status } },
    })
    await ctx.emit('billing_schedule.status_changed', schedule)
    return schedule
  },
})

export const billingScheduleDelete = defineProcedure({
  name: 'billingSchedule.delete',
  summary: 'Delete a schedule. Invoices it raised remain; end it instead to keep the record of what was agreed.',
  permission: 'billingSchedule:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/billing-schedules/{id}' },
  emits: ['billing_schedule.deleted'],
  async handler(ctx, input) {
    const schedule = await getSchedule(ctx, input.id)
    await ctx.tx.delete(schema.billingSchedules).where(eq(schema.billingSchedules.id, input.id))
    await ctx.audit({ action: 'billing_schedule.deleted', entityType: 'billing_schedule', entityId: schedule.id, entityLabel: schedule.name })
    await ctx.emit('billing_schedule.deleted', schedule)
    return { deleted: true }
  },
})

// Lines

export const billingScheduleLineAdd = defineProcedure({
  name: 'billingScheduleLine.add',
  summary: 'Add a line to what each period bills',
  permission: 'billingSchedule:update',
  input: z.object({ scheduleId: z.uuid(), ...lineInput.shape }),
  output: billingScheduleOutput,
  http: { method: 'POST', path: '/billing-schedules/{scheduleId}/lines', successStatus: 201 },
  emits: ['billing_schedule.updated'],
  async handler(ctx, input) {
    const { scheduleId, ...line } = input
    const schedule = await loadSchedule(ctx, scheduleId, { lock: true })
    const [row] = await ctx.tx
      .select({ last: max(schema.billingScheduleLines.position) })
      .from(schema.billingScheduleLines)
      .where(eq(schema.billingScheduleLines.scheduleId, scheduleId))
    await insertLine(ctx, schedule, line, (row?.last ?? 0) + 1)

    const updated = await getSchedule(ctx, scheduleId)
    await ctx.audit({ action: 'billing_schedule.updated', entityType: 'billing_schedule', entityId: scheduleId, entityLabel: updated.name })
    await ctx.emit('billing_schedule.updated', updated)
    return updated
  },
})

export const billingScheduleLineRemove = defineProcedure({
  name: 'billingScheduleLine.remove',
  summary: 'Remove a line from a schedule',
  permission: 'billingSchedule:update',
  input: z.object({ scheduleId: z.uuid(), lineId: z.uuid() }),
  output: billingScheduleOutput,
  http: { method: 'DELETE', path: '/billing-schedules/{scheduleId}/lines/{lineId}' },
  emits: ['billing_schedule.updated'],
  async handler(ctx, input) {
    await loadSchedule(ctx, input.scheduleId, { lock: true })
    const deleted = await ctx.tx
      .delete(schema.billingScheduleLines)
      .where(and(eq(schema.billingScheduleLines.id, input.lineId), eq(schema.billingScheduleLines.scheduleId, input.scheduleId)))
      .returning({ id: schema.billingScheduleLines.id })
    if (deleted.length === 0) throw new NotFoundError('Billing schedule line', input.lineId)

    const updated = await getSchedule(ctx, input.scheduleId)
    await ctx.audit({ action: 'billing_schedule.updated', entityType: 'billing_schedule', entityId: input.scheduleId, entityLabel: updated.name })
    await ctx.emit('billing_schedule.updated', updated)
    return updated
  },
})

// Generation

/**
 * Raises the draft invoice for a schedule's current period, or returns null
 * when nothing is due.
 *
 * Called by the worker once an hour and by `billingSchedule.generate` on
 * demand. The schedule row is locked for the whole thing, so two callers
 * cannot decide at the same moment that the same period is unbilled.
 */
export async function raiseInvoiceFor(ctx: ActorContext, scheduleId: string, options: { force?: boolean } = {}): Promise<Invoice | null> {
  const schedule = await loadSchedule(ctx, scheduleId, { lock: true })
  const todayOn = await today(ctx)

  if (schedule.status !== 'active' || !schedule.nextRunOn) return null
  if (!options.force && schedule.nextRunOn > todayOn) return null
  if (schedule.maxOccurrences !== null && schedule.generatedCount >= schedule.maxOccurrences) {
    await endSchedule(ctx, schedule.id)
    return null
  }
  if (schedule.endOn && schedule.nextRunOn > schedule.endOn) {
    await endSchedule(ctx, schedule.id)
    return null
  }

  const blocker = await scheduleBlocker(ctx, schedule.id)
  if (blocker) {
    // The sweep asks first (see `generateDueInvoices`) and never gets here; a
    // person asking for it now gets told exactly what to fix.
    throw new DomainError(BLOCKER_MESSAGES[blocker], `schedule_${blocker}`, 'lines')
  }
  const lines = await ctx.tx
    .select()
    .from(schema.billingScheduleLines)
    .where(eq(schema.billingScheduleLines.scheduleId, schedule.id))
    .orderBy(asc(schema.billingScheduleLines.position))

  const unit = schedule.intervalUnit as Interval
  const index = periodIndexOf(schedule.startOn, unit, schedule.intervalCount, schedule.nextRunOn)
  const from = schedule.nextRunOn
  const to = periodEnd(schedule.startOn, unit, schedule.intervalCount, index)

  const invoiceId = newId()
  await ctx.tx.insert(schema.invoices).values({
    id: invoiceId,
    organizationId: ctx.organizationId,
    companyId: schedule.companyId,
    contactId: schedule.contactId,
    projectId: schedule.projectId,
    title: schedule.name,
    currency: schedule.currency,
    taxMode: schedule.taxMode,
    paymentTermsDays: schedule.paymentTermsDays,
    notes: schedule.notes,
    terms: schedule.terms,
    createdBy: actingUserId(ctx),
  })
  for (const [i, line] of lines.entries()) {
    await ctx.tx.insert(schema.invoiceLines).values({
      id: newId(),
      organizationId: ctx.organizationId,
      invoiceId,
      position: i + 1,
      ...(await newLineValues(
        ctx,
        { currency: schedule.currency },
        {
          serviceId: line.serviceId,
          description: line.description,
          quantity: fromNumeric(line.quantity) ?? '1',
          unitAmountMinor: line.unitAmountMinor,
          discountPercent: fromNumeric(line.discountPercent),
          taxRateId: line.taxRateId,
        },
      )),
    })
  }
  await recalculate(ctx, invoiceId)

  // The period, and the constraint that makes billing it twice impossible.
  await ctx.tx.insert(schema.billingScheduleInvoices).values({
    id: newId(),
    organizationId: ctx.organizationId,
    scheduleId: schedule.id,
    invoiceId,
    periodStart: from,
    periodEnd: to,
  })

  // Advance in the same transaction: if the invoice rolls back, so does this.
  const nextRunOn = periodStart(schedule.startOn, unit, schedule.intervalCount, index + 1)
  const billed = schedule.generatedCount + 1
  const finished =
    (schedule.maxOccurrences !== null && billed >= schedule.maxOccurrences) || (schedule.endOn !== null && nextRunOn > schedule.endOn)
  await ctx.tx
    .update(schema.billingSchedules)
    .set({
      nextRunOn: finished ? null : nextRunOn,
      status: finished ? 'ended' : schedule.status,
      lastRunAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(eq(schema.billingSchedules.id, schedule.id))

  const invoice = await getInvoice(ctx, invoiceId)
  const after = await getSchedule(ctx, schedule.id)
  await ctx.audit({
    action: 'billing_schedule.invoiced',
    entityType: 'billing_schedule',
    entityId: schedule.id,
    entityLabel: schedule.name,
    changes: { period: { from, to } },
  })
  await ctx.emit('invoice.created', invoice)
  await ctx.emit('billing_schedule.invoiced', { schedule: after, invoice, periodStart: from, periodEnd: to })
  // The last period of an agreement ends it, and that is a change an
  // automation watching for `status_changed` has to hear about.
  if (finished) await ctx.emit('billing_schedule.status_changed', after)
  return invoice
}

async function endSchedule(ctx: ActorContext, id: string): Promise<void> {
  await ctx.tx
    .update(schema.billingSchedules)
    .set({ status: 'ended', nextRunOn: null, updatedAt: ctx.now })
    .where(eq(schema.billingSchedules.id, id))
  const schedule = await getSchedule(ctx, id)
  await ctx.audit({ action: 'billing_schedule.status_changed', entityType: 'billing_schedule', entityId: id, entityLabel: schedule.name })
  await ctx.emit('billing_schedule.status_changed', schedule)
}

export const billingScheduleGenerate = defineProcedure({
  name: 'billingSchedule.generate',
  summary: 'Raise the draft invoice for the current period now, rather than waiting for the worker',
  permission: 'billingSchedule:update',
  input: z.object({
    id: z.uuid(),
    /** Bill the next period even though its start date has not arrived. */
    force: z.boolean().optional(),
  }),
  output: z.object({ invoiceId: z.uuid().nullable(), schedule: billingScheduleOutput }),
  http: { method: 'POST', path: '/billing-schedules/{id}/generate' },
  rateLimit: 'expensive',
  emits: ['invoice.created', 'billing_schedule.invoiced', 'billing_schedule.status_changed'],
  async handler(ctx, input) {
    // Raising an invoice is creating one, whoever asked for it.
    ctx.require('invoice:create')
    const invoice = await raiseInvoiceFor(ctx, input.id, { force: input.force ?? false })
    return { invoiceId: invoice?.id ?? null, schedule: await getSchedule(ctx, input.id) }
  },
})

/**
 * Every schedule whose period has arrived, for one organization. Returns how
 * many invoices were raised.
 *
 * A schedule that fails -- a deleted tax rate, an archived client -- does not
 * stop the others: it is logged and the sweep moves on, because one broken
 * retainer should not mean nobody else gets billed this month.
 */
export async function generateDueInvoices(ctx: ActorContext): Promise<number> {
  const s = schema.billingSchedules
  const todayOn = await today(ctx)
  const due = await ctx.tx
    .select({ id: s.id })
    .from(s)
    .where(and(eq(s.status, 'active'), isNotNull(s.nextRunOn), lte(s.nextRunOn, todayOn)))
    .orderBy(asc(s.nextRunOn))
    .limit(500)

  let raised = 0
  for (const { id } of due) {
    // Asked before anything is attempted: everything in this sweep shares one
    // transaction, so a schedule that threw would take the rest down with it.
    // A blocked schedule waits for a person, and says why on its own page.
    if (await scheduleBlocker(ctx, id)) continue
    // A schedule starting in the past catches up, but only so far in one pass:
    // a start date entered as 2019 should not produce sixty drafts at once.
    for (let attempt = 0; attempt < MAX_CATCH_UP; attempt++) {
      const invoice = await raiseInvoiceFor(ctx, id)
      if (!invoice) break
      raised += 1
    }
  }
  return raised
}

/** Active schedules for a client, for the client view. */
export async function countSchedules(ctx: ActorContext, companyId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: count() })
    .from(schema.billingSchedules)
    .where(and(eq(schema.billingSchedules.companyId, companyId), eq(schema.billingSchedules.status, 'active')))
  return row?.n ?? 0
}
