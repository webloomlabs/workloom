import { timingSafeEqual } from 'node:crypto'
import { and, asc, db, eq, inArray, isNull, lte, notInArray, or, schema, sql, withTenant, type TenantTransaction } from '@workloom/db'
import { isUuid, newId } from '../../../ids.ts'
import type { ReceiptExtractor } from '../../finance/receipt-extraction.ts'
import { hashSecret, telegramClient } from './bots.ts'
import { TelegramError, type TelegramClient, type TelegramUpdate } from './client.ts'
import { processAlbum, processUpdate } from './process-update.ts'

/**
 * The bot's inbox. Webhook calls and polls only *store* updates; the worker
 * processes them from here, one organization at a time, with a lease so two
 * workers never handle the same update and a crash only delays one.
 */

type BotRow = typeof schema.telegramBots.$inferSelect
type UpdateRow = typeof schema.telegramUpdates.$inferSelect

const LEASE_MS = 2 * 60 * 1000
const MAX_ATTEMPTS = 5
/**
 * How long an album must have been quiet before it is handled. Telegram sends
 * an album's photos as separate updates within a moment of each other; waiting
 * for the last one keeps them one expense.
 */
export const ALBUM_SETTLE_MS = 3000

function sameSecret(given: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(given), 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

async function store(tx: TenantTransaction, organizationId: string, botId: string, update: TelegramUpdate): Promise<boolean> {
  const inserted = await tx
    .insert(schema.telegramUpdates)
    .values({ id: newId(), organizationId, botId, updateId: update.update_id, payload: update })
    .onConflictDoNothing()
    .returning({ id: schema.telegramUpdates.id })
  return inserted.length > 0
}

/**
 * Takes one webhook call. The organization comes from the URL; the secret
 * header proves the call is Telegram's for *this* organization's bot. Answers
 * whether it was stored -- the route returns 200 either way, so Telegram does
 * not retry a call that will never be accepted.
 */
export async function receiveTelegramWebhook(organizationId: string, secret: string | null, body: unknown): Promise<'stored' | 'duplicate' | 'refused'> {
  if (!isUuid(organizationId) || !secret) return 'refused'
  const update = body as TelegramUpdate | null
  if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id)) return 'refused'
  return withTenant(organizationId, async (tx) => {
    const [bot] = await tx.select().from(schema.telegramBots).limit(1)
    if (!bot || bot.mode !== 'webhook' || !bot.webhookSecretHash || !sameSecret(secret, bot.webhookSecretHash)) return 'refused'
    return (await store(tx, organizationId, bot.id, update)) ? 'stored' : 'duplicate'
  })
}

/** Organizations with a bot, found one tenant at a time as everything cross-organization is. */
async function organizationsWithBots(): Promise<Array<{ organizationId: string; bot: BotRow }>> {
  const organizations = await db.select({ id: schema.organization.id }).from(schema.organization)
  const found: Array<{ organizationId: string; bot: BotRow }> = []
  for (const { id } of organizations) {
    const [bot] = await withTenant(id, (tx) => tx.select().from(schema.telegramBots).limit(1))
    if (bot) found.push({ organizationId: id, bot })
  }
  return found
}

/** Asks Telegram for new updates for every bot in poll mode, and stores them. Returns how many were new. */
export async function pollTelegramBots(options: { clientFor?: (bot: BotRow) => Promise<TelegramClient> } = {}): Promise<number> {
  let stored = 0
  for (const { organizationId, bot } of await organizationsWithBots()) {
    if (bot.mode !== 'poll' || bot.status === 'paused') continue
    try {
      const client = await (options.clientFor ?? telegramClient)(bot)
      const updates = await client.getUpdates(bot.lastUpdateId === null ? undefined : bot.lastUpdateId + 1)
      if (updates.length === 0) {
        if (bot.status === 'error') await withTenant(organizationId, (tx) => tx.update(schema.telegramBots).set({ status: 'active', lastError: null }).where(eq(schema.telegramBots.id, bot.id)))
        continue
      }
      await withTenant(organizationId, async (tx) => {
        for (const update of updates) if (await store(tx, organizationId, bot.id, update)) stored += 1
        // Moving the offset on tells Telegram these are taken: they are stored now.
        const last = Math.max(...updates.map((u) => u.update_id))
        await tx.update(schema.telegramBots).set({ lastUpdateId: last, status: 'active', lastError: null }).where(eq(schema.telegramBots.id, bot.id))
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await withTenant(organizationId, (tx) =>
        tx.update(schema.telegramBots).set({ status: 'error', lastError: message.slice(0, 500) }).where(eq(schema.telegramBots.id, bot.id)),
      )
      if (!(error instanceof TelegramError)) console.error(`telegram: polling failed in ${organizationId}`, error)
    }
  }
  return stored
}

/** The album an update's message belongs to, if it was sent as one. */
const albumOf = (u: typeof schema.telegramUpdates) => sql<string | null>`${u.payload}->'message'->>'media_group_id'`

/**
 * Claims an organization's due updates under a lease, counting the attempt up
 * front. An album is claimed whole, and only once it has gone quiet: none of
 * its photos arrived within `settleMs` (by the database's clock, which stamped
 * them).
 */
async function claim(organizationId: string, now: Date, limit: number, settleMs: number): Promise<UpdateRow[]> {
  return withTenant(organizationId, async (tx) => {
    const u = schema.telegramUpdates
    const leaseFree = or(isNull(u.lockedUntil), lte(u.lockedUntil, now))
    const settled = sql`not exists (
      select 1 from telegram_updates s
      where s.organization_id = ${u.organizationId} and s.bot_id = ${u.botId} and s.status = 'pending'
        and s.payload->'message'->>'media_group_id' = ${albumOf(u)}
        and s.received_at > now() - (${settleMs}::int * interval '1 millisecond'))`
    const due = await tx
      .select({ id: u.id, album: albumOf(u) })
      .from(u)
      .where(and(eq(u.status, 'pending'), lte(u.nextAttemptAt, now), leaseFree, or(sql`${albumOf(u)} is null`, settled)))
      .orderBy(asc(u.updateId))
      .limit(limit)
      .for('update', { skipLocked: true })
    if (due.length === 0) return []
    const ids = due.map((d) => d.id)
    // The rest of each album, so the limit never cuts one in two.
    const albums = [...new Set(due.map((d) => d.album).filter((a): a is string => a !== null))]
    if (albums.length > 0) {
      const rest = await tx
        .select({ id: u.id })
        .from(u)
        .where(and(eq(u.status, 'pending'), leaseFree, inArray(albumOf(u), albums), notInArray(u.id, ids)))
        .for('update', { skipLocked: true })
      ids.push(...rest.map((r) => r.id))
    }
    return tx
      .update(u)
      .set({ lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`${u.attempts} + 1` })
      .where(inArray(u.id, ids))
      .returning()
  })
}

/** Updates handled together: one on its own, or every photo of an album. */
function units(rows: UpdateRow[]): UpdateRow[][] {
  const sorted = [...rows].sort((a, b) => a.updateId - b.updateId)
  const albums = new Map<string, UpdateRow[]>()
  const out: UpdateRow[][] = []
  for (const row of sorted) {
    const message = (row.payload as TelegramUpdate).message
    const album = message?.media_group_id ? `${message.chat.id}:${message.media_group_id}` : null
    if (!album) {
      out.push([row])
      continue
    }
    const existing = albums.get(album)
    if (existing) existing.push(row)
    else {
      const unit = [row]
      albums.set(album, unit)
      out.push(unit)
    }
  }
  return out
}

export type InboxDeps = {
  /** The Telegram client for a bot. Tests point it at a fake server. */
  clientFor?: (bot: BotRow) => Promise<TelegramClient>
  /** The receipt reader. Defaults to the one installed for the process. */
  extractor?: ReceiptExtractor | null
  now?: Date
  /** How long an album waits for the rest of its photos. Defaults to `ALBUM_SETTLE_MS`. */
  albumSettleMs?: number
}

/**
 * Processes every organization's due updates. Each update is handled outside
 * any transaction -- downloading a photo and reading it take seconds -- and
 * whatever it changes goes through procedures, as the person who sent it.
 */
export async function processTelegramInbox(deps: InboxDeps = {}, limit = 20): Promise<number> {
  let processed = 0
  for (const { organizationId, bot } of await organizationsWithBots()) {
    const now = deps.now ?? new Date()
    const rows = await claim(organizationId, now, limit, deps.albumSettleMs ?? ALBUM_SETTLE_MS)
    if (rows.length === 0) continue
    const client = await (deps.clientFor ?? telegramClient)(bot)
    for (const unit of units(rows)) {
      const ids = unit.map((r) => r.id)
      try {
        if (bot.status !== 'paused') {
          const first = unit[0]!
          const album = Boolean((first.payload as TelegramUpdate).message?.media_group_id)
          if (album) await processAlbum({ organizationId, bot, rows: unit, client, extractor: deps.extractor, now })
          else await processUpdate({ organizationId, bot, row: first, client, extractor: deps.extractor, now })
        }
        await withTenant(organizationId, (tx) =>
          tx.update(schema.telegramUpdates).set({ status: 'done', processedAt: new Date(), lockedUntil: null, lastError: null }).where(inArray(schema.telegramUpdates.id, ids)),
        )
        processed += unit.length
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
        const attempts = Math.max(...unit.map((r) => r.attempts))
        const failed = attempts >= MAX_ATTEMPTS
        // 30 s, 2 min, 8 min, 32 min: a Telegram outage is waited out, a bug gives up.
        const wait = 30_000 * 4 ** (attempts - 1)
        await withTenant(organizationId, (tx) =>
          tx
            .update(schema.telegramUpdates)
            .set({ status: failed ? 'failed' : 'pending', lastError: message, lockedUntil: null, nextAttemptAt: new Date(now.getTime() + wait) })
            .where(inArray(schema.telegramUpdates.id, ids)),
        )
        console.error(`telegram: update ${unit.map((r) => r.updateId).join(', ')} in ${organizationId} ${failed ? 'failed for good' : 'will be retried'}: ${message}`)
      }
    }
  }
  return processed
}
