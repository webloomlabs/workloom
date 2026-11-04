import { and, eq, gt, isNull, ne, schema, withTenant } from '@workloom/db'
import { isOneOf } from '@workloom/storage'
import { DomainError, ForbiddenError, NotFoundError, type Actor } from '../../../context.ts'
import { newId } from '../../../ids.ts'
import { permissionsForRole, isRole } from '../../../permissions/index.ts'
import { consumeRateLimit, rateLimitKey } from '../../../rate-limit.ts'
import { buildContext, executeProcedure, type ExecutionRequest } from '../../../registry/index.ts'
import { describeDraft, receiptHintsFor } from '../../finance/expense-from-receipt.ts'
import { RECEIPT_MAX_BYTES, RECEIPT_TYPES, receiptFilename } from '../../finance/expense-receipts.ts'
import { readReceipt, receiptDraftSchema, type ReceiptDraft, type ReceiptExtractor } from '../../finance/receipt-extraction.ts'
import { hashSecret, telegramSettings } from './bots.ts'
import { decodeCallback, encodeCallback, TelegramError, type InlineKeyboard, type TelegramClient, type TelegramMessage, type TelegramUpdate, type TelegramUser } from './client.ts'

/**
 * What the bot does with one update.
 *
 * - `/start <code>` from anyone links their Telegram account to the member
 *   who made the code.
 * - From a linked member: a photo or PDF becomes a draft expense, read by
 *   AI when the organization has turned that on, with buttons to confirm
 *   or discard it. Anything else gets a line of help.
 * - From anyone else: how to link, and nothing more. Nothing they send is
 *   stored as an expense.
 *
 * Everything that changes the books is a procedure run as the member
 * themselves -- their permissions, their name on the audit entry, with
 * Telegram as the door it came in by. A button press is checked against the
 * person who pressed it, not the person who sent the receipt.
 */

type BotRow = typeof schema.telegramBots.$inferSelect
type UpdateRow = typeof schema.telegramUpdates.$inferSelect

export type UpdateContext = {
  organizationId: string
  bot: BotRow
  row: UpdateRow
  client: TelegramClient
  /** Undefined: the process's installed reader. Null: none. */
  extractor?: ReceiptExtractor | null | undefined
  now: Date
}

const HELP = 'Send me a photo of a receipt, or the PDF, and I will start an expense for you to check.'

function linkHelp(appUrl: string): string {
  return `I don't know you yet. In Workloom, open ${appUrl}/settings/telegram and choose "Link my Telegram", then send me the code it shows.`
}

const fullName = (user: TelegramUser) => [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id)

/** A member as an actor: who they are, their role now, and what it allows. */
type Member = { request: Omit<ExecutionRequest, 'input'>; identityId: string; userName: string }

async function memberRequest(organizationId: string, userId: string, now: Date): Promise<Omit<ExecutionRequest, 'input'> | null> {
  const [found] = await withTenant(organizationId, (tx) =>
    tx
      .select({ role: schema.member.role, name: schema.user.name })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
      .limit(1),
  )
  if (!found || !isRole(found.role)) return null
  const actor: Actor = { type: 'user', id: userId, label: found.name }
  return { organizationId, actor, role: found.role, permissions: permissionsForRole(found.role), source: 'telegram', now, userAgent: 'Telegram' }
}

/** The member behind a Telegram account, if it is linked and they are still in the organization. */
async function linkedMember(organizationId: string, from: TelegramUser, now: Date): Promise<Member | null> {
  const i = schema.messagingIdentities
  const [identity] = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(i)
      .where(and(eq(i.provider, 'telegram'), eq(i.externalUserId, String(from.id)), isNull(i.revokedAt)))
      .limit(1),
  )
  if (!identity) return null
  const request = await memberRequest(organizationId, identity.userId, now)
  if (!request) {
    // They have left the organization: the link dies with their membership.
    await withTenant(organizationId, (tx) => tx.update(i).set({ revokedAt: now }).where(eq(i.id, identity.id)))
    return null
  }
  return { request, identityId: identity.id, userName: (request.actor as { label: string }).label }
}

/** Whether the organization has turned on reading receipts with AI. */
async function receiptReadingOn(organizationId: string): Promise<boolean> {
  const [org] = await withTenant(organizationId, (tx) =>
    tx.select({ on: schema.organization.receiptReadingEnabled }).from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1),
  )
  return org?.on ?? false
}

export async function processUpdate(context: UpdateContext): Promise<void> {
  const update = context.row.payload as TelegramUpdate
  if (update.callback_query) return handleButton(context, update.callback_query)
  const message = update.message
  // Private chats only: a receipt posted in a group is not addressed to the bot.
  if (!message?.from || message.chat.type !== 'private' || message.from.is_bot) return

  const start = /^\/start(?:\s+(\S+))?/.exec(message.text?.trim() ?? '')
  if (start) return start[1] ? link(context, message, start[1]) : greet(context, message)

  const member = await linkedMember(context.organizationId, message.from, context.now)
  const { appUrl } = await telegramSettings()
  if (!member) {
    await context.client.sendMessage(message.chat.id, linkHelp(appUrl))
    return
  }
  if (message.photo?.length || message.document) return receipt(context, message, member, appUrl)
  await context.client.sendMessage(message.chat.id, HELP)
}

async function greet(context: UpdateContext, message: TelegramMessage) {
  const member = await linkedMember(context.organizationId, message.from!, context.now)
  const { appUrl } = await telegramSettings()
  await context.client.sendMessage(message.chat.id, member ? `Hello ${member.userName}. ${HELP}` : linkHelp(appUrl))
}

/** `/start <code>`: links the sender's Telegram account to the member who made the code. */
async function link(context: UpdateContext, message: TelegramMessage, code: string) {
  const { organizationId, now } = context
  const from = message.from!
  const c = schema.messagingLinkCodes
  const i = schema.messagingIdentities
  const userId = await withTenant(organizationId, async (tx) => {
    const [found] = await tx
      .select()
      .from(c)
      .where(and(eq(c.codeHash, hashSecret(code)), isNull(c.usedAt), gt(c.expiresAt, now)))
      .limit(1)
      .for('update')
    if (!found) return null
    await tx.update(c).set({ usedAt: now }).where(eq(c.id, found.id))
    return found.userId
  })
  const request = userId ? await memberRequest(organizationId, userId, now) : null
  if (!userId || !request) {
    await context.client.sendMessage(message.chat.id, 'That code has expired or was already used. Make a new one in Workloom and send it within ten minutes.')
    return
  }
  const hooks = { commit: [] as Array<() => Promise<void>>, rollback: [] as Array<() => Promise<void>> }
  await withTenant(organizationId, async (tx) => {
    const ctx = buildContext(request, tx, hooks)
    // A Telegram account links to one person: linking it again moves it.
    await tx
      .update(i)
      .set({ revokedAt: now })
      .where(and(eq(i.provider, 'telegram'), eq(i.externalUserId, String(from.id)), isNull(i.revokedAt), ne(i.userId, userId)))
    const [existing] = await tx
      .select({ id: i.id })
      .from(i)
      .where(and(eq(i.provider, 'telegram'), eq(i.externalUserId, String(from.id)), isNull(i.revokedAt)))
      .limit(1)
    const id = existing?.id ?? newId()
    if (existing) {
      await tx.update(i).set({ chatId: String(message.chat.id), displayName: fullName(from), linkedAt: now }).where(eq(i.id, id))
    } else {
      await tx.insert(i).values({ id, organizationId, userId, provider: 'telegram', externalUserId: String(from.id), chatId: String(message.chat.id), displayName: fullName(from), linkedAt: now })
    }
    await ctx.audit({ action: 'messaging_identity.linked', entityType: 'messaging_identity', entityId: id, entityLabel: `Telegram ${fullName(from)}` })
  })
  await context.client.sendMessage(message.chat.id, `Linked to Workloom as ${(request.actor as { label: string }).label}. ${HELP}`)
}

/** The file in a message: the largest size of a photo, or a document. */
function attachment(message: TelegramMessage): { fileId: string; name: string | undefined; size: number | undefined } | null {
  if (message.photo?.length) {
    const largest = message.photo.reduce((a, b) => ((b.file_size ?? b.width * b.height) > (a.file_size ?? a.width * a.height) ? b : a))
    return { fileId: largest.file_id, name: `telegram-${message.message_id}.jpg`, size: largest.file_size }
  }
  if (message.document) return { fileId: message.document.file_id, name: message.document.file_name, size: message.document.file_size }
  return null
}

async function receipt(context: UpdateContext, message: TelegramMessage, member: Member, appUrl: string) {
  const { organizationId, bot, row, client } = context
  const chat = message.chat.id

  const limit = await consumeRateLimit(rateLimitKey({ organizationId, actorId: `telegram:${member.identityId}`, klass: 'expensive' }), 'expensive', context.now)
  if (!limit.allowed) {
    await client.sendMessage(chat, `That is a lot of receipts at once. Send the rest in ${limit.resetSeconds} seconds.`)
    return
  }

  const file = attachment(message)!
  if (file.size && file.size > RECEIPT_MAX_BYTES) {
    await client.sendMessage(chat, 'That file is over 10 MB. Send a smaller photo or PDF.')
    return
  }
  let bytes: Buffer
  try {
    bytes = await client.downloadFile(file.fileId, RECEIPT_MAX_BYTES)
  } catch (error) {
    if (error instanceof TelegramError && error.status === 413) {
      await client.sendMessage(chat, 'That file is over 10 MB. Send a smaller photo or PDF.')
      return
    }
    throw error
  }
  const type = isOneOf(bytes, RECEIPT_TYPES)
  if (!type) {
    await client.sendMessage(chat, 'I can only take photos (JPEG, PNG, WebP, HEIC) and PDFs.')
    return
  }

  // Read once: a retry after a crash reuses what was read, so the expense it
  // replays is the same one, and the receipt is not sent to be read twice.
  const reading = await receiptReadingOn(organizationId)
  let draft: ReceiptDraft | null
  if (row.extraction !== null) {
    draft = (row.extraction as { draft: unknown }).draft === null ? null : receiptDraftSchema.parse((row.extraction as { draft: unknown }).draft)
  } else {
    draft = reading ? await readReceipt({ bytes, contentType: type }, await receiptHintsFor(member.request), context.extractor === undefined ? undefined : context.extractor) : null
    await withTenant(organizationId, (tx) => tx.update(schema.telegramUpdates).set({ extraction: { draft } }).where(eq(schema.telegramUpdates.id, row.id)))
  }

  let created: { expense: { id: string; description: string; currency: string }; duplicateOf: { number: string | null; description: string } | null }
  try {
    created = (await executeProcedure('expense.createFromReceipt', {
      ...member.request,
      input: {
        file: new File([new Uint8Array(bytes)], receiptFilename(file.name, type), { type }),
        draft,
        note: message.caption?.trim() || null,
      },
      idempotencyKey: `telegram:${bot.id}:${row.updateId}`,
    })) as typeof created
  } catch (error) {
    if (error instanceof ForbiddenError) {
      await client.sendMessage(chat, 'Your role in Workloom cannot record expenses.')
      return
    }
    if (error instanceof DomainError) {
      await client.sendMessage(chat, error.message)
      return
    }
    throw error
  }

  const url = `${appUrl}/expenses/${created.expense.id}`
  const lines = [
    `Draft expense started: ${created.expense.description}`,
    reading ? describeDraft(draft, created.expense.currency) : 'Fill in the amount in Workloom, then confirm it.',
    created.duplicateOf ? `This looks like the same receipt as ${created.duplicateOf.number ?? created.duplicateOf.description}.` : null,
    // Telegram only opens HTTPS links from a button; otherwise the link is in the text.
    appUrl.startsWith('https://') ? null : url,
  ].filter(Boolean)
  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      [
        { text: 'Confirm', callback_data: encodeCallback({ action: 'confirm', expenseId: created.expense.id }) },
        { text: 'Discard', callback_data: encodeCallback({ action: 'discard', expenseId: created.expense.id }) },
      ],
      ...(appUrl.startsWith('https://') ? [[{ text: 'Open in Workloom', url }]] : []),
    ],
  }
  await client.sendMessage(chat, lines.join('\n'), keyboard)
}

/** A Confirm or Discard press, done as -- and only if allowed for -- the person who pressed it. */
async function handleButton(context: UpdateContext, query: NonNullable<TelegramUpdate['callback_query']>) {
  const { client, organizationId, now } = context
  const action = decodeCallback(query.data)
  if (!action) {
    await client.answerCallbackQuery(query.id)
    return
  }
  const member = await linkedMember(organizationId, query.from, now)
  if (!member) {
    await client.answerCallbackQuery(query.id, 'Link your Telegram to Workloom first.')
    return
  }
  let reply: string
  let edit: string | null = null
  try {
    if (action.action === 'confirm') {
      const expense = (await executeProcedure('expense.confirm', { ...member.request, input: { id: action.expenseId } })) as { number: string | null; description: string }
      reply = `Confirmed ${expense.number ?? ''}`.trim()
      edit = `Confirmed as ${expense.number}: ${expense.description}`
    } else {
      await executeProcedure('expense.delete', { ...member.request, input: { id: action.expenseId } })
      reply = 'Discarded'
      edit = 'Discarded. Nothing was recorded.'
    }
  } catch (error) {
    if (error instanceof ForbiddenError) reply = 'You are not allowed to do that.'
    else if (error instanceof NotFoundError) reply = 'That expense is no longer there.'
    else if (error instanceof DomainError) reply = error.message
    else throw error
  }
  await client.answerCallbackQuery(query.id, reply.slice(0, 200))
  if (edit && query.message) await client.editMessageText(query.message.chat.id, query.message.message_id, edit).catch(() => undefined)
}
