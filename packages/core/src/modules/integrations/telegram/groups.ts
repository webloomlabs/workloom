import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, schema } from '@workloom/db'
import { z } from 'zod'
import { DomainError, NotFoundError } from '../../../context.ts'
import { newId } from '../../../ids.ts'
import { defineProcedure } from '../../../registry/index.ts'
import { actingUserId } from '../../crm/shared.ts'
import { hashSecret, LINK_CODE_TTL_MS, loadBot } from './bots.ts'

/**
 * The Telegram groups the bot works in. A group is approved by an owner or
 * admin with a one-time code -- sent in the group, or carried by Telegram's
 * "add to group" link -- so a bot dropped into some other group stays silent
 * there. In an approved group, receipts from linked members become drafts;
 * the details and buttons go to the sender privately, not to the whole group.
 */

export const telegramGroupOutput = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  approvedAt: z.date(),
})

export const telegramGroupCreateLinkCode = defineProcedure({
  name: 'telegramGroup.createLinkCode',
  // Not offered to AI assistants: A link code binds an outside chat to the organization.
  mcp: false,
  summary: 'A one-time code, good for ten minutes, that lets the bot work in a Telegram group',
  permission: 'integration:manage',
  input: z.object({}),
  output: z.object({ code: z.string(), expiresAt: z.date(), botUsername: z.string(), addToGroupLink: z.url() }),
  http: { method: 'POST', path: '/integrations/telegram/group-codes', successStatus: 201 },
  rateLimit: 'expensive',
  emits: [],
  async handler(ctx) {
    const userId = actingUserId(ctx)
    if (!userId) throw new DomainError('Only a person can approve a group.', 'person_required')
    const bot = await loadBot(ctx)
    if (!bot) throw new DomainError('Connect a Telegram bot first.', 'bot_missing')
    const code = randomBytes(12).toString('base64url').slice(0, 16)
    const expiresAt = new Date(ctx.now.getTime() + LINK_CODE_TTL_MS)
    const id = newId()
    await ctx.tx.insert(schema.messagingLinkCodes).values({ id, organizationId: ctx.organizationId, userId, codeHash: hashSecret(code), purpose: 'group', expiresAt })
    await ctx.audit({ action: 'telegram_group.link_code_created', entityType: 'messaging_link_code', entityId: id, entityLabel: `@${bot.username}` })
    // Telegram's own link: pick a group, the bot joins it, and the code arrives with it.
    return { code, expiresAt, botUsername: bot.username, addToGroupLink: `https://t.me/${bot.username}?startgroup=${code}` }
  },
})

export const telegramGroupList = defineProcedure({
  name: 'telegramGroup.list',
  summary: 'The Telegram groups the bot works in',
  permission: 'integration:manage',
  readOnly: true,
  input: z.object({}),
  output: z.object({ data: z.array(telegramGroupOutput) }),
  http: { method: 'GET', path: '/integrations/telegram/groups' },
  async handler(ctx) {
    const g = schema.telegramGroups
    const rows = await ctx.tx.select({ id: g.id, title: g.title, approvedAt: g.approvedAt }).from(g).where(isNull(g.revokedAt)).orderBy(desc(g.approvedAt))
    return { data: rows }
  },
})

export const telegramGroupRevoke = defineProcedure({
  name: 'telegramGroup.revoke',
  // Not offered to AI assistants: Account linking stays with people.
  mcp: false,
  summary: 'Stop the bot working in a group. It stays silent there from now on.',
  permission: 'integration:manage',
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.uuid() }),
  http: { method: 'POST', path: '/integrations/telegram/groups/{id}/revoke' },
  emits: [],
  async handler(ctx, input) {
    const g = schema.telegramGroups
    const [row] = await ctx.tx.select().from(g).where(and(eq(g.id, input.id), isNull(g.revokedAt))).limit(1)
    if (!row) throw new NotFoundError('Telegram group', input.id)
    await ctx.tx.update(g).set({ revokedAt: ctx.now, revokedReason: 'removed in Workloom' }).where(eq(g.id, input.id))
    await ctx.audit({ action: 'telegram_group.revoked', entityType: 'telegram_group', entityId: row.id, entityLabel: row.title ?? row.chatId })
    return { id: row.id }
  },
})
