import { createHash } from 'node:crypto'
import { asc, desc, schema, sql } from '@workloom/db'
import { z } from 'zod'
import type { ActorContext } from '../../context.ts'
import { newId } from '../../ids.ts'
import { defineProcedure } from '../../registry/index.ts'

/**
 * Daily seals over the audit log.
 *
 * The application cannot update, delete, or truncate audit entries. Someone
 * with the database itself still could; seals make that visible. Each day
 * (UTC) that has entries is sealed once it is over: a SHA-256 over every entry
 * of the day, in order, chained to the seal before it. Changing, removing, or
 * slipping in an entry on a sealed day changes that day's digest -- and with
 * the chain, every seal after it.
 */

/** Each entry as stable text: Postgres renders jsonb with its keys in a fixed order. */
async function dayEntries(ctx: ActorContext, day: string): Promise<string[]> {
  const a = schema.auditLogs
  const rows = await ctx.tx
    .select({
      text: sql<string>`jsonb_build_array(${a.id}, ${a.createdAt}, ${a.actorType}, ${a.actorId}, ${a.actorLabel}, ${a.action}, ${a.entityType}, ${a.entityId}, ${a.entityLabel}, ${a.changes}, ${a.snapshot}, ${a.source}, ${a.requestId})::text`,
    })
    .from(a)
    .where(sql`(${a.createdAt} at time zone 'UTC')::date = ${day}::date`)
    .orderBy(asc(a.id))
  return rows.map((r) => r.text)
}

export function sealDigest(previous: string | null, entries: string[]): string {
  return createHash('sha256')
    .update(previous ?? 'workloom audit seal v1')
    .update('\n')
    .update(entries.join('\n'))
    .digest('hex')
}

const utcDay = (date: Date) => date.toISOString().slice(0, 10)

/** Seals every finished day with entries that is not sealed yet. Returns how many days it sealed. */
export async function sealAuditLog(ctx: ActorContext): Promise<number> {
  const a = schema.auditLogs
  const [last] = await ctx.tx.select().from(schema.auditSeals).orderBy(desc(schema.auditSeals.day)).limit(1)
  const yesterday = utcDay(new Date(ctx.now.getTime() - 86_400_000))
  const days = await ctx.tx
    .selectDistinct({ day: sql<string>`(${a.createdAt} at time zone 'UTC')::date::text` })
    .from(a)
    .where(sql`(${a.createdAt} at time zone 'UTC')::date <= ${yesterday}::date ${last ? sql`and (${a.createdAt} at time zone 'UTC')::date > ${last.day}::date` : sql``}`)
    .orderBy(sql`1`)
  let previous = last?.digest ?? null
  for (const { day } of days) {
    const entries = await dayEntries(ctx, day)
    const digest = sealDigest(previous, entries)
    await ctx.tx.insert(schema.auditSeals).values({ id: newId(), organizationId: ctx.organizationId, day, entries: entries.length, digest, previousDigest: previous, sealedAt: ctx.now })
    previous = digest
  }
  return days.length
}

export const auditSealVerify = defineProcedure({
  name: 'auditSeal.verify',
  summary: 'Recompute every seal over the audit log, and say whether any sealed day has changed since',
  permission: 'auditLog:read',
  readOnly: true,
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    sealedDays: z.number().int(),
    sealedThrough: z.iso.date().nullable(),
    /** The first sealed day whose entries no longer match its seal. */
    brokenAt: z.iso.date().nullable(),
    /** Entries now found on a past day that had none when the days after it were sealed. */
    unsealedDays: z.array(z.iso.date()),
  }),
  http: { method: 'GET', path: '/audit-seals/verify' },
  async handler(ctx) {
    const seals = await ctx.tx.select().from(schema.auditSeals).orderBy(asc(schema.auditSeals.day))
    let previous: string | null = null
    let brokenAt: string | null = null
    for (const seal of seals) {
      const digest = sealDigest(previous, await dayEntries(ctx, seal.day))
      if (digest !== seal.digest || seal.previousDigest !== previous) {
        brokenAt = seal.day
        break
      }
      previous = seal.digest
    }
    const through = seals.at(-1)?.day ?? null
    const a = schema.auditLogs
    const sealedDays = new Set(seals.map((s) => s.day))
    const stray = through
      ? (
          await ctx.tx
            .selectDistinct({ day: sql<string>`(${a.createdAt} at time zone 'UTC')::date::text` })
            .from(a)
            .where(sql`(${a.createdAt} at time zone 'UTC')::date <= ${through}::date`)
        )
          .map((r) => r.day)
          .filter((d) => !sealedDays.has(d))
          .sort()
      : []
    return { ok: brokenAt === null && stray.length === 0, sealedDays: seals.length, sealedThrough: through, brokenAt, unsealedDays: stray }
  },
})
