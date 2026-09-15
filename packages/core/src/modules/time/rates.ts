import { and, eq, isNull, or, schema } from '@workloom/db'
import { z } from 'zod'
import { DomainError, type ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'
import { resolveRates, type RateSnapshot } from '../../time/index.ts'
import { baseCurrency, currencyCode, minorAmount } from '../crm/shared.ts'

/**
 * Default hourly rates, and the resolution that copies them onto time entries.
 *
 * Rates are commercial terms. Reading them needs `report:readFinancial`;
 * setting them needs `rate:update` as well, because setting a rate is reading it.
 */

const rateValues = z.object({
  /** Per hour, in minor units of `currency`. Null when unset. */
  billableRateMinor: z.number().int().nullable(),
  costRateMinor: z.number().int().nullable(),
  updatedAt: z.date().nullable(),
})

const rateListOutput = z.object({
  currency: z.string().length(3),
  organization: rateValues,
  members: z.array(rateValues.extend({ userId: z.uuid(), name: z.string(), email: z.string() })),
})

export const rateList = defineProcedure({
  name: 'rate.list',
  summary: "The organization's default hourly rates and each member's, in one currency",
  permission: 'report:readFinancial',
  readOnly: true,
  input: z.object({
    /** Defaults to the organization's base currency. */
    currency: currencyCode.optional(),
  }),
  output: rateListOutput,
  http: { method: 'GET', path: '/rates' },
  async handler(ctx, input) {
    const currency = input.currency ?? (await baseCurrency(ctx))
    const r = schema.defaultRates
    const [rows, members] = await Promise.all([
      ctx.tx.select().from(r).where(eq(r.currency, currency)),
      ctx.tx
        .select({ userId: schema.member.userId, name: schema.user.name, email: schema.user.email })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        // `member` is outside row-level security: this predicate is the boundary.
        .where(eq(schema.member.organizationId, ctx.organizationId))
        .orderBy(schema.user.name),
    ])
    const values = (row: (typeof rows)[number] | undefined) => ({
      billableRateMinor: row?.billableRateMinor ?? null,
      costRateMinor: row?.costRateMinor ?? null,
      updatedAt: row?.updatedAt ?? null,
    })
    return {
      currency,
      organization: values(rows.find((row) => row.userId === null)),
      members: members.map((m) => ({ ...m, ...values(rows.find((row) => row.userId === m.userId)) })),
    }
  },
})

export const rateSet = defineProcedure({
  name: 'rate.set',
  summary: "Set the organization's default hourly rates, or a member's. Time already logged keeps the rates it was logged at.",
  permission: 'rate:update',
  input: z.object({
    /** The member whose defaults these are. Omit for the organization's. */
    userId: z.uuid().nullish(),
    /** Defaults to the organization's base currency. */
    currency: currencyCode.optional(),
    billableRateMinor: minorAmount.nullable(),
    costRateMinor: minorAmount.nullable(),
  }),
  output: rateValues.extend({ userId: z.uuid().nullable(), currency: z.string().length(3) }),
  http: { method: 'POST', path: '/rates' },
  // Rates are internal economics: like project rates, they never go out in events.
  emits: [],
  async handler(ctx, input) {
    ctx.require('report:readFinancial')
    const userId = input.userId ?? null
    const currency = input.currency ?? (await baseCurrency(ctx))
    let label = 'Organization default'
    if (userId) label = await memberName(ctx, userId)

    const r = schema.defaultRates
    const match = and(eq(r.currency, currency), userId ? eq(r.userId, userId) : isNull(r.userId))
    const [before] = await ctx.tx.select().from(r).where(match).limit(1).for('update')

    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const field of ['billableRateMinor', 'costRateMinor'] as const) {
      const from = before?.[field] ?? null
      if (from !== input[field]) changes[field] = { from, to: input[field] }
    }

    let updatedAt: Date | null = before?.updatedAt ?? null
    if (Object.keys(changes).length > 0) {
      if (input.billableRateMinor === null && input.costRateMinor === null) {
        await ctx.tx.delete(r).where(match)
        updatedAt = null
      } else {
        await ctx.tx
          .insert(r)
          .values({
            id: newId(),
            organizationId: ctx.organizationId,
            userId,
            currency,
            billableRateMinor: input.billableRateMinor,
            costRateMinor: input.costRateMinor,
          })
          .onConflictDoUpdate({
            target: [r.organizationId, r.userId, r.currency],
            set: { billableRateMinor: input.billableRateMinor, costRateMinor: input.costRateMinor, updatedAt: ctx.now },
          })
        updatedAt = ctx.now
      }
      await ctx.audit({
        action: 'rate.updated',
        entityType: userId ? 'member' : 'organization',
        entityId: userId ?? ctx.organizationId,
        entityLabel: `${label} (${currency})`,
        changes,
      })
    }

    return { userId, currency, billableRateMinor: input.billableRateMinor, costRateMinor: input.costRateMinor, updatedAt }
  },
})

/**
 * The organization member's name.
 *
 * `member` is outside row-level security, so the organization predicate is the
 * only thing stopping a user id from another organization being accepted.
 */
export async function memberName(ctx: ActorContext, userId: string, field = 'userId'): Promise<string> {
  const [row] = await ctx.tx
    .select({ name: schema.user.name })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, userId)))
    .limit(1)
  if (!row) throw new DomainError('That person is not a member of this organization.', 'not_member', field)
  return row.name
}

/**
 * The rates a person's time on a project is worth right now, to be copied
 * onto an entry. Defaults in another currency do not apply.
 */
export async function snapshotRates(ctx: ActorContext, project: { id: string; currency: string }, userId: string): Promise<RateSnapshot> {
  const r = schema.defaultRates
  const pm = schema.projectMembers
  const [overrides, defaults] = await Promise.all([
    ctx.tx
      .select({ billableRateMinor: pm.billableRateMinor, costRateMinor: pm.costRateMinor })
      .from(pm)
      .where(and(eq(pm.projectId, project.id), eq(pm.userId, userId)))
      .limit(1),
    ctx.tx
      .select({ userId: r.userId, billableRateMinor: r.billableRateMinor, costRateMinor: r.costRateMinor })
      .from(r)
      .where(and(eq(r.currency, project.currency), or(eq(r.userId, userId), isNull(r.userId)))),
  ])
  return resolveRates({
    project_member: overrides[0],
    member: defaults.find((d) => d.userId === userId),
    organization: defaults.find((d) => d.userId === null),
  })
}
