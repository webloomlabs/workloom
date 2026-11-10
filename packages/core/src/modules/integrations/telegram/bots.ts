import { createHash, randomBytes } from 'node:crypto'
import { and, asc, count, eq, isNull, schema } from '@workloom/db'
import { z } from 'zod'
import { decryptSecret, encryptSecret } from '../../../crypto.ts'
import { DomainError, NotFoundError, type ActorContext } from '../../../context.ts'
import { newId } from '../../../ids.ts'
import { defineProcedure } from '../../../registry/index.ts'
import { actingUserId } from '../../crm/shared.ts'
import { TelegramClient, TelegramError } from './client.ts'

/**
 * The organization's Telegram bot, and the people linked to it.
 *
 * Each organization brings its own bot, made with @BotFather: the bot that
 * receives a message is what says which organization it is for, so nothing a
 * stranger sends can reach another organization's books. A person links their
 * Telegram account by sending the bot a one-time code from Workloom; until
 * then the bot only tells them how.
 */

export const LINK_CODE_TTL_MS = 10 * 60 * 1000

export async function telegramSettings() {
  const { env } = await import('@workloom/config')
  return { base: env.TELEGRAM_API_BASE, appUrl: env.APP_URL.replace(/\/$/, '') }
}

export async function telegramClient(bot: { tokenEncrypted: string }): Promise<TelegramClient> {
  return new TelegramClient(decryptSecret(bot.tokenEncrypted), (await telegramSettings()).base)
}

export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex')

export const telegramBotOutput = z.object({
  id: z.uuid(),
  username: z.string(),
  mode: z.enum(schema.TELEGRAM_MODES),
  status: z.enum(schema.TELEGRAM_BOT_STATUSES),
  lastError: z.string().nullable(),
  /** Where Telegram sends updates, in webhook mode. */
  webhookUrl: z.string().nullable(),
  /** People with a live link to the bot. */
  linkedPeople: z.number().int(),
  createdAt: z.date(),
})

type BotRow = typeof schema.telegramBots.$inferSelect

export async function loadBot(ctx: ActorContext): Promise<BotRow | null> {
  const [bot] = await ctx.tx.select().from(schema.telegramBots).limit(1)
  return bot ?? null
}

async function present(ctx: ActorContext, bot: BotRow) {
  const settings = await telegramSettings()
  const [linked] = await ctx.tx
    .select({ n: count() })
    .from(schema.messagingIdentities)
    .where(and(eq(schema.messagingIdentities.provider, 'telegram'), isNull(schema.messagingIdentities.revokedAt)))
  return {
    id: bot.id,
    username: bot.username,
    mode: bot.mode as (typeof schema.TELEGRAM_MODES)[number],
    status: bot.status as (typeof schema.TELEGRAM_BOT_STATUSES)[number],
    lastError: bot.lastError,
    webhookUrl: bot.mode === 'webhook' ? webhookUrl(settings.appUrl, ctx.organizationId) : null,
    linkedPeople: linked?.n ?? 0,
    createdAt: bot.createdAt,
  }
}

export function webhookUrl(appUrl: string, organizationId: string): string {
  return `${appUrl}/api/integrations/telegram/${organizationId}`
}

/** Points Telegram at the webhook, or away from it for polling. Returns the webhook secret's hash. */
async function applyMode(ctx: ActorContext, client: TelegramClient, mode: (typeof schema.TELEGRAM_MODES)[number]): Promise<string | null> {
  const { appUrl } = await telegramSettings()
  try {
    if (mode === 'poll') {
      await client.deleteWebhook()
      return null
    }
    if (!appUrl.startsWith('https://')) {
      throw new DomainError('Telegram only sends updates to an HTTPS address. Use polling, or serve Workloom over HTTPS.', 'webhook_needs_https', 'mode')
    }
    const secret = randomBytes(32).toString('hex')
    await client.setWebhook(webhookUrl(appUrl, ctx.organizationId), secret)
    return hashSecret(secret)
  } catch (error) {
    if (error instanceof TelegramError) throw new DomainError(`Telegram refused: ${error.message}`, 'telegram_refused', 'mode')
    throw error
  }
}

const tokenInput = z
  .string()
  .trim()
  .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'That does not look like a bot token. BotFather gives one like 123456789:AA…')

export const telegramBotConnect = defineProcedure({
  name: 'telegramBot.connect',
  // Not offered to AI assistants: Integration credentials stay with people.
  mcp: false,
  summary: "Connect the organization's Telegram bot, with the token from @BotFather",
  permission: 'integration:manage',
  input: z.object({ token: tokenInput, mode: z.enum(schema.TELEGRAM_MODES).default('poll') }),
  output: telegramBotOutput,
  http: { method: 'POST', path: '/integrations/telegram', successStatus: 201 },
  emits: [],
  async handler(ctx, input) {
    if (await loadBot(ctx)) throw new DomainError('A bot is already connected. Disconnect it first.', 'bot_exists')
    const { base } = await telegramSettings()
    const client = new TelegramClient(input.token, base)
    let me: Awaited<ReturnType<TelegramClient['getMe']>>
    try {
      me = await client.getMe()
    } catch (error) {
      if (error instanceof TelegramError && error.unauthorized) throw new DomainError('Telegram did not recognise that token.', 'token_invalid', 'token')
      throw new DomainError('Could not reach Telegram. Try again in a moment.', 'telegram_unreachable')
    }
    const id = newId()
    const secretHash = await applyMode(ctx, client, input.mode)
    await ctx.tx.insert(schema.telegramBots).values({
      id,
      organizationId: ctx.organizationId,
      telegramBotId: String(me.id),
      username: me.username,
      tokenEncrypted: encryptSecret(input.token),
      webhookSecretHash: secretHash,
      mode: input.mode,
      createdBy: actingUserId(ctx),
    })
    const bot = (await loadBot(ctx))!
    await ctx.audit({ action: 'telegram_bot.connected', entityType: 'telegram_bot', entityId: id, entityLabel: `@${me.username}`, changes: { mode: { from: null, to: input.mode } } })
    return present(ctx, bot)
  },
})

export const telegramBotGet = defineProcedure({
  name: 'telegramBot.get',
  summary: "The organization's Telegram bot, if one is connected",
  permission: 'authenticated',
  readOnly: true,
  input: z.object({}),
  output: z.object({ bot: telegramBotOutput.nullable() }),
  http: { method: 'GET', path: '/integrations/telegram' },
  async handler(ctx) {
    const bot = await loadBot(ctx)
    return { bot: bot ? await present(ctx, bot) : null }
  },
})

export const telegramBotUpdate = defineProcedure({
  name: 'telegramBot.update',
  // Not offered to AI assistants: Integration credentials stay with people.
  mcp: false,
  summary: 'Change how the bot receives updates, or pause it',
  permission: 'integration:manage',
  input: z.object({
    mode: z.enum(schema.TELEGRAM_MODES).optional(),
    paused: z.boolean().optional(),
  }),
  output: telegramBotOutput,
  http: { method: 'PATCH', path: '/integrations/telegram' },
  emits: [],
  async handler(ctx, input) {
    const bot = await loadBot(ctx)
    if (!bot) throw new NotFoundError('Telegram bot', 'telegram')
    const patch: Partial<BotRow> = {}
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    if (input.mode && input.mode !== bot.mode) {
      patch.webhookSecretHash = await applyMode(ctx, await telegramClient(bot), input.mode)
      patch.mode = input.mode
      changes.mode = { from: bot.mode, to: input.mode }
    }
    if (input.paused !== undefined) {
      const status = input.paused ? 'paused' : 'active'
      if (status !== bot.status) {
        patch.status = status
        patch.lastError = null
        changes.status = { from: bot.status, to: status }
      }
    }
    if (Object.keys(changes).length === 0) return present(ctx, bot)
    await ctx.tx.update(schema.telegramBots).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.telegramBots.id, bot.id))
    await ctx.audit({ action: 'telegram_bot.updated', entityType: 'telegram_bot', entityId: bot.id, entityLabel: `@${bot.username}`, changes })
    return present(ctx, (await loadBot(ctx))!)
  },
})

export const telegramBotDisconnect = defineProcedure({
  name: 'telegramBot.disconnect',
  // Not offered to AI assistants: Integration credentials stay with people.
  mcp: false,
  summary: 'Disconnect the bot. Linked accounts are kept for a bot connected later; unprocessed updates are dropped.',
  permission: 'integration:manage',
  input: z.object({}),
  output: z.object({ id: z.uuid() }),
  http: { method: 'DELETE', path: '/integrations/telegram' },
  emits: [],
  async handler(ctx) {
    const bot = await loadBot(ctx)
    if (!bot) throw new NotFoundError('Telegram bot', 'telegram')
    await ctx.tx.delete(schema.telegramBots).where(eq(schema.telegramBots.id, bot.id))
    await ctx.audit({ action: 'telegram_bot.disconnected', entityType: 'telegram_bot', entityId: bot.id, entityLabel: `@${bot.username}` })
    // Stop Telegram pushing to an address that will now refuse it. Best effort:
    // the bot is disconnected here either way.
    if (bot.mode === 'webhook') {
      const client = await telegramClient(bot)
      ctx.afterCommit(async () => {
        await client.deleteWebhook().catch(() => undefined)
      })
    }
    return { id: bot.id }
  },
})

// People

export const messagingIdentityOutput = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  userName: z.string().nullable(),
  provider: z.enum(schema.MESSAGING_PROVIDERS),
  displayName: z.string().nullable(),
  linkedAt: z.date(),
})

export const messagingIdentityCreateLinkCode = defineProcedure({
  name: 'messagingIdentity.createLinkCode',
  // Not offered to AI assistants: A link code binds an outside chat account to a person.
  mcp: false,
  summary: 'A one-time code, good for ten minutes, that links your Telegram account when you send it to the bot. For people who record expenses.',
  permission: 'expense:create',
  input: z.object({}),
  output: z.object({ code: z.string(), expiresAt: z.date(), botUsername: z.string(), deepLink: z.url() }),
  http: { method: 'POST', path: '/integrations/telegram/link-codes', successStatus: 201 },
  rateLimit: 'expensive',
  emits: [],
  async handler(ctx) {
    const userId = actingUserId(ctx)
    if (!userId) throw new DomainError('Only a person can link a chat account.', 'person_required')
    const bot = await loadBot(ctx)
    if (!bot) throw new DomainError('Connect a Telegram bot first.', 'bot_missing')
    // 16 characters a person could type; Telegram passes up to 64 through a start link.
    const code = randomBytes(12).toString('base64url').slice(0, 16)
    const expiresAt = new Date(ctx.now.getTime() + LINK_CODE_TTL_MS)
    const id = newId()
    await ctx.tx.insert(schema.messagingLinkCodes).values({ id, organizationId: ctx.organizationId, userId, codeHash: hashSecret(code), expiresAt })
    // The code itself is never recorded: it is a credential until it expires.
    await ctx.audit({ action: 'messaging_identity.link_code_created', entityType: 'messaging_link_code', entityId: id, entityLabel: `@${bot.username}` })
    return { code, expiresAt, botUsername: bot.username, deepLink: `https://t.me/${bot.username}?start=${code}` }
  },
})

export const messagingIdentityList = defineProcedure({
  name: 'messagingIdentity.list',
  summary: 'Linked chat accounts: your own, or everyone’s with integration:manage',
  permission: 'authenticated',
  readOnly: true,
  input: z.object({}),
  output: z.object({ data: z.array(messagingIdentityOutput) }),
  http: { method: 'GET', path: '/integrations/telegram/identities' },
  async handler(ctx) {
    const i = schema.messagingIdentities
    const userId = actingUserId(ctx)
    const rows = await ctx.tx
      .select({ id: i.id, userId: i.userId, userName: schema.user.name, provider: i.provider, displayName: i.displayName, linkedAt: i.linkedAt })
      .from(i)
      .innerJoin(schema.user, eq(schema.user.id, i.userId))
      // Only people still in the organization: a removed member's link is dead.
      .innerJoin(schema.member, and(eq(schema.member.userId, i.userId), eq(schema.member.organizationId, i.organizationId)))
      .where(and(isNull(i.revokedAt), ctx.has('integration:manage') ? undefined : eq(i.userId, userId ?? '00000000-0000-0000-0000-000000000000')))
      .orderBy(asc(i.linkedAt))
    return { data: rows.map((r) => ({ ...r, provider: r.provider as 'telegram' })) }
  },
})

export const messagingIdentityRevoke = defineProcedure({
  name: 'messagingIdentity.revoke',
  // Not offered to AI assistants: Account linking stays with people.
  mcp: false,
  summary: 'Unlink a chat account. Your own, or anyone’s with integration:manage.',
  permission: 'expense:create',
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.uuid() }),
  http: { method: 'POST', path: '/integrations/telegram/identities/{id}/revoke' },
  emits: [],
  async handler(ctx, input) {
    const i = schema.messagingIdentities
    const [row] = await ctx.tx.select().from(i).where(eq(i.id, input.id)).limit(1)
    if (!row || row.revokedAt) throw new NotFoundError('Linked account', input.id)
    if (row.userId !== actingUserId(ctx)) ctx.require('integration:manage')
    await ctx.tx.update(i).set({ revokedAt: ctx.now, revokedBy: actingUserId(ctx) }).where(eq(i.id, input.id))
    await ctx.audit({ action: 'messaging_identity.revoked', entityType: 'messaging_identity', entityId: row.id, entityLabel: row.displayName ?? row.externalUserId })
    return { id: row.id }
  },
})
