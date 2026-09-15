import { and, desc, eq, isNull, or, schema, sql, type SQL } from '@workloom/db'
import { z } from 'zod'
import { diff } from '../../audit.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { loadCompany } from './companies.ts'
import { loadContact } from './contacts.ts'
import { loadDeal } from './deals.ts'
import { loadLead } from './leads.ts'
import { actingUserId, provided, requiredText } from './shared.ts'

export const activityOutput = z.object({
  id: z.uuid(),
  type: z.enum(schema.ACTIVITY_TYPES),
  body: z.string(),
  occurredAt: z.date(),
  authorId: z.uuid().nullable(),
  authorName: z.string().nullable(),
  companyId: z.uuid().nullable(),
  contactId: z.uuid().nullable(),
  leadId: z.uuid().nullable(),
  dealId: z.uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Activity = z.infer<typeof activityOutput>
type ActivityRow = typeof schema.activities.$inferSelect

function selectActivities(ctx: ActorContext) {
  // `user` is outside row-level security; the join only ever reaches authors
  // of activities that row-level security already let through.
  return ctx.tx
    .select({ activity: schema.activities, authorName: schema.user.name })
    .from(schema.activities)
    .leftJoin(schema.user, eq(schema.user.id, schema.activities.authorId))
}

function present({ activity, authorName }: { activity: ActivityRow; authorName: string | null }): Activity {
  return {
    id: activity.id,
    type: activity.type as Activity['type'],
    body: activity.body,
    occurredAt: activity.occurredAt,
    authorId: activity.authorId,
    authorName,
    companyId: activity.companyId,
    contactId: activity.contactId,
    leadId: activity.leadId,
    dealId: activity.dealId,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
  }
}

async function getActivity(ctx: ActorContext, id: string): Promise<Activity> {
  const [row] = await selectActivities(ctx).where(eq(schema.activities.id, id)).limit(1)
  if (!row) throw new NotFoundError('Activity', id)
  return present(row)
}

const TARGETS = ['companyId', 'contactId', 'leadId', 'dealId'] as const
type Resolved = { [K in (typeof TARGETS)[number]]: string | null }
type Targets = { [K in (typeof TARGETS)[number]]?: string | null | undefined }

const PERMISSION_FOR = {
  companyId: 'company:read',
  contactId: 'contact:read',
  leadId: 'lead:read',
  dealId: 'deal:read',
} as const

const LOADERS = { companyId: loadCompany, contactId: loadContact, leadId: loadLead, dealId: loadDeal }

/**
 * An activity is only as visible as the records it is attached to.
 *
 * A developer can read companies but not deals, so a note logged on a deal --
 * which also carries the deal's company -- must not surface on the company's
 * timeline for them. Negotiation notes are commercial terms.
 */
export function visibleTo(ctx: ActorContext): SQL | undefined {
  const a = schema.activities
  return and(
    ...TARGETS.filter((t) => !ctx.has(PERMISSION_FOR[t])).map((t) => isNull(a[t])),
  )
}

/** Opaque to callers: the timeline is ordered by when things happened, not when they were logged. */
function encodeCursor(activity: Activity): string {
  return Buffer.from(`${activity.occurredAt.toISOString()}|${activity.id}`).toString('base64url')
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|')
  const occurredAt = new Date(iso ?? '')
  if (Number.isNaN(occurredAt.getTime()) || !z.uuid().safeParse(id).success) {
    throw new DomainError('That cursor is not valid. Start again from the first page.', 'invalid_cursor', 'cursor')
  }
  return { occurredAt, id: id! }
}

export const activityList = defineProcedure({
  name: 'activity.list',
  summary: 'The activity timeline for one company, contact, lead, or deal, most recent first',
  permission: 'activity:read',
  readOnly: true,
  input: z
    .object({
      companyId: z.uuid().optional(),
      contactId: z.uuid().optional(),
      leadId: z.uuid().optional(),
      dealId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().max(200).optional(),
    })
    .refine((v) => TARGETS.filter((t) => v[t]).length === 1, {
      message: 'Give exactly one of companyId, contactId, leadId, or dealId.',
      path: ['companyId'],
    }),
  output: z.object({ data: z.array(activityOutput), nextCursor: z.string().nullable() }),
  http: { method: 'GET', path: '/activities' },
  async handler(ctx, input) {
    const target = TARGETS.find((t) => input[t])!
    ctx.require(PERMISSION_FOR[target])
    // A timeline for a record that is not here is "not found", like the record
    // itself -- not an empty list that reads as "exists, nothing logged".
    await LOADERS[target](ctx, input[target]!)
    const a = schema.activities
    const after = input.cursor ? decodeCursor(input.cursor) : undefined

    const rows = await selectActivities(ctx)
      .where(
        and(
          eq(a[target], input[target]!),
          visibleTo(ctx),
          after
            ? or(
                sql`${a.occurredAt} < ${after.occurredAt}`,
                and(sql`${a.occurredAt} = ${after.occurredAt}`, sql`${a.id} < ${after.id}::uuid`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(a.occurredAt), desc(a.id))
      .limit(input.limit + 1)

    const hasMore = rows.length > input.limit
    const data = (hasMore ? rows.slice(0, input.limit) : rows).map(present)
    return { data, nextCursor: hasMore ? encodeCursor(data.at(-1)!) : null }
  },
})

/**
 * Resolves the records an activity attaches to, filling in the ones implied by
 * the target: a note on a deal belongs in its company's history too.
 */
async function resolveTargets(ctx: ActorContext, given: Targets): Promise<Resolved> {
  const targets: Resolved = {
    companyId: given.companyId ?? null,
    contactId: given.contactId ?? null,
    leadId: given.leadId ?? null,
    dealId: given.dealId ?? null,
  }

  for (const t of TARGETS) if (targets[t]) ctx.require(PERMISSION_FOR[t])

  if (targets.leadId) {
    const lead = await loadLead(ctx, targets.leadId)
    // A converted lead's history now lives with what it became.
    targets.companyId ??= lead.convertedCompanyId
    targets.contactId ??= lead.convertedContactId
    targets.dealId ??= lead.convertedDealId
  }
  if (targets.dealId) {
    const deal = await loadDeal(ctx, targets.dealId)
    targets.companyId ??= deal.companyId
    targets.contactId ??= deal.contactId
  }
  if (targets.contactId) {
    const contact = await loadContact(ctx, targets.contactId)
    targets.companyId ??= contact.companyId
  }
  if (targets.companyId) await loadCompany(ctx, targets.companyId)
  return targets
}

/** Stamps `last_activity_at` on each linked record. A future-dated meeting counts from now, not from then. */
async function touch(ctx: ActorContext, targets: Resolved, occurredAt: Date) {
  const at = occurredAt > ctx.now ? ctx.now : occurredAt
  const stamp = <T extends typeof schema.companies | typeof schema.contacts | typeof schema.leads | typeof schema.deals>(
    table: T,
    id: string | null,
  ) =>
    id
      ? ctx.tx
          .update(table)
          .set({ lastActivityAt: sql`greatest(${table.lastActivityAt}, ${at})` } as never)
          .where(eq(table.id, id))
      : undefined
  await stamp(schema.companies, targets.companyId)
  await stamp(schema.contacts, targets.contactId)
  await stamp(schema.leads, targets.leadId)
  await stamp(schema.deals, targets.dealId)
}

export const activityCreate = defineProcedure({
  name: 'activity.create',
  summary: 'Log a note, call, email, or meeting against a company, contact, lead, or deal',
  permission: 'activity:create',
  input: z
    .object({
      type: z.enum(schema.ACTIVITY_TYPES).default('note'),
      body: requiredText(20_000, 'Text'),
      /** When it happened. Defaults to now. */
      occurredAt: z.coerce.date().optional(),
      companyId: z.uuid().nullish(),
      contactId: z.uuid().nullish(),
      leadId: z.uuid().nullish(),
      dealId: z.uuid().nullish(),
    })
    .refine((v) => TARGETS.some((t) => v[t]), {
      message: 'Attach the activity to a company, contact, lead, or deal.',
      path: ['companyId'],
    }),
  output: activityOutput,
  http: { method: 'POST', path: '/activities', successStatus: 201 },
  emits: ['activity.logged'],
  async handler(ctx, input) {
    const targets = await resolveTargets(ctx, input)
    const id = newId()
    const occurredAt = input.occurredAt ?? ctx.now
    await ctx.tx.insert(schema.activities).values({
      id,
      organizationId: ctx.organizationId,
      type: input.type,
      body: input.body,
      occurredAt,
      authorId: actingUserId(ctx),
      ...targets,
    })
    await touch(ctx, targets, occurredAt)

    const activity = await getActivity(ctx, id)
    await ctx.audit({ action: 'activity.logged', entityType: 'activity', entityId: id, entityLabel: activity.type })
    await ctx.emit('activity.logged', activity)
    return activity
  },
})

export const activityUpdate = defineProcedure({
  name: 'activity.update',
  summary: 'Edit a logged activity',
  permission: 'activity:update',
  input: z.object({
    id: z.uuid(),
    type: z.enum(schema.ACTIVITY_TYPES).optional(),
    body: requiredText(20_000, 'Text').optional(),
    occurredAt: z.coerce.date().optional(),
  }),
  output: activityOutput,
  http: { method: 'PATCH', path: '/activities/{id}' },
  emits: ['activity.updated'],
  async handler(ctx, input) {
    const { id, ...fields } = input
    const before = await loadVisibleActivity(ctx, id)
    const patch = provided(fields)
    const changes = diff(before as Record<string, unknown>, patch)
    if (!changes) return getActivity(ctx, id)

    await ctx.tx.update(schema.activities).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.activities.id, id))
    const activity = await getActivity(ctx, id)
    await ctx.audit({ action: 'activity.updated', entityType: 'activity', entityId: id, entityLabel: activity.type, changes })
    await ctx.emit('activity.updated', activity)
    return activity
  },
})

export const activityDelete = defineProcedure({
  name: 'activity.delete',
  summary: 'Delete a logged activity',
  permission: 'activity:delete',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/activities/{id}' },
  emits: ['activity.deleted'],
  async handler(ctx, input) {
    const before = await loadVisibleActivity(ctx, input.id)
    const activity = await getActivity(ctx, before.id)
    await ctx.tx.delete(schema.activities).where(eq(schema.activities.id, before.id))
    await ctx.audit({
      action: 'activity.deleted',
      entityType: 'activity',
      entityId: before.id,
      entityLabel: before.type,
      changes: { body: { from: before.body, to: null } },
    })
    await ctx.emit('activity.deleted', activity)
    return { deleted: true }
  },
})

/** Someone who could not see an activity on a timeline cannot edit or delete it either. */
async function loadVisibleActivity(ctx: ActorContext, id: string): Promise<ActivityRow> {
  const [row] = await ctx.tx
    .select()
    .from(schema.activities)
    .where(and(eq(schema.activities.id, id), visibleTo(ctx)))
    .limit(1)
  if (!row) throw new NotFoundError('Activity', id)
  return row
}
