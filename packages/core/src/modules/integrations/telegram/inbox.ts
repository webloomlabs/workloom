import { timingSafeEqual } from 'node:crypto'
import { and, asc, db, eq, isNull, lte, or, schema, sql, withTenant, type TenantTransaction } from '@workloom/db'
import { isUuid, newId } from '../../../ids.ts'
import type { ReceiptExtractor } from '../../finance/receipt-extraction.ts'
import { hashSecret, telegramClient } from './bots.ts'
import { TelegramError, type TelegramClient, type TelegramUpdate } from './client.ts'
import { processUpdate } from './process-update.ts'

/**
 * The bot's inbox. Webhook calls and polls only *store* updates; the worker
 * processes them from here, one organization at a time, with a lease so two
 * workers never handle the same update and a crash only delays one.
 */

type BotRow = typeof schema.telegramBots.$inferSelect
type UpdateRow = typeof schema.telegramUpdates.$inferSelect

const LEASE_MS = 2 * 60 * 1000
const MAX_ATTEMPTS = 5

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

/** Claims an organization's due updates under a lease, counting the attempt up front. */
async function claim(organizationId: string, now: Date, limit: number): Promise<UpdateRow[]> {
  return withTenant(organizationId, async (tx) => {
    const u = schema.telegramUpdates
    const due = await tx
      .select({ id: u.id })
      .from(u)
      .where(and(eq(u.status, 'pending'), lte(u.nextAttemptAt, now), or(isNull(u.lockedUntil), lte(u.lockedUntil, now))))
      .orderBy(asc(u.updateId))
      .limit(limit)
      .for('update', { skipLocked: true })
    if (due.length === 0) return []
    return tx
      .update(u)
      .set({ lockedUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`${u.attempts} + 1` })
      .where(sql`${u.id} in (${sql.join(due.map((d) => sql`${d.id}::uuid`), sql`, `)})`)
      .returning()
  })
}

export type InboxDeps = {
  /** The Telegram client for a bot. Tests point it at a fake server. */
  clientFor?: (bot: BotRow) => Promise<TelegramClient>
  /** The receipt reader. Defaults to the one installed for the process. */
  extractor?: ReceiptExtractor | null
  now?: Date
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
    const rows = await claim(organizationId, now, limit)
    if (rows.length === 0) continue
    const client = await (deps.clientFor ?? telegramClient)(bot)
    for (const row of rows) {
      try {
        if (bot.status !== 'paused') await processUpdate({ organizationId, bot, row, client, extractor: deps.extractor, now })
        await withTenant(organizationId, (tx) =>
          tx.update(schema.telegramUpdates).set({ status: 'done', processedAt: new Date(), lockedUntil: null, lastError: null }).where(eq(schema.telegramUpdates.id, row.id)),
        )
        processed += 1
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
        const failed = row.attempts >= MAX_ATTEMPTS
        // 30 s, 2 min, 8 min, 32 min: a Telegram outage is waited out, a bug gives up.
        const wait = 30_000 * 4 ** (row.attempts - 1)
        await withTenant(organizationId, (tx) =>
          tx
            .update(schema.telegramUpdates)
            .set({ status: failed ? 'failed' : 'pending', lastError: message, lockedUntil: null, nextAttemptAt: new Date(now.getTime() + wait) })
            .where(eq(schema.telegramUpdates.id, row.id)),
        )
        console.error(`telegram: update ${row.updateId} in ${organizationId} ${failed ? 'failed for good' : 'will be retried'}: ${message}`)
      }
    }
  }
  return processed
}
