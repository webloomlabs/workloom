import { and, desc, eq, gt, isNull, ne, notInArray, schema, withTenant } from '@workloom/db'
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
 *   or discard it. A project named in the caption files it there; otherwise,
 *   when there are active projects, the bot asks which one before offering
 *   Confirm. Anything else gets a line of help.
 * - From anyone else: how to link, and nothing more. Nothing they send is
 *   stored as an expense.
 * - In a group: nothing at all, unless an owner or admin approved the group
 *   with a code. There, a receipt from a linked member is taken as above,
 *   its details and buttons sent to them privately; everyone else is ignored.
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

/** A member as an actor: who they are, their role now, and what it allows -- and their private chat with the bot. */
type Member = { request: Omit<ExecutionRequest, 'input'>; identityId: string; userName: string; chatId: string }

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
  return { request, identityId: identity.id, userName: (request.actor as { label: string }).label, chatId: identity.chatId }
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
  if (update.my_chat_member) return membershipChanged(context, update.my_chat_member)
  const message = update.message
  if (!message?.from || message.from.is_bot) return
  if (message.chat.type === 'group' || message.chat.type === 'supergroup') return groupMessage(context, message)
  // Channels and anything else are not conversations with the bot.
  if (message.chat.type !== 'private') return

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
      .where(and(eq(c.codeHash, hashSecret(code)), eq(c.purpose, 'identity'), isNull(c.usedAt), gt(c.expiresAt, now)))
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

/** A project the bot can offer: one still in play. */
type ProjectChoice = { id: string; name: string; companyName: string | null }

/** How many projects the bot lists as buttons. More than this, and the rest are chosen in Workloom. */
const PROJECT_CHOICES = 10
const PROJECT_QUESTION = 'Which project is this for?'

/** Projects still in play -- not completed, cancelled or archived -- newest first. None for a member who cannot see projects. */
async function activeProjects(member: Member): Promise<ProjectChoice[]> {
  if (!member.request.permissions.has('project:read')) return []
  const p = schema.projects
  return withTenant(member.request.organizationId, (tx) =>
    tx
      .select({ id: p.id, name: p.name, companyName: schema.companies.name })
      .from(p)
      .leftJoin(schema.companies, eq(schema.companies.id, p.companyId))
      .where(and(isNull(p.archivedAt), notInArray(p.status, ['completed', 'cancelled'])))
      .orderBy(desc(p.id)),
  )
}

const comparable = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

/** Whether `name` appears in `text` as whole words. */
function mentions(text: string, name: string): boolean {
  const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'u').test(text)
}

/**
 * The project a caption names, if it names exactly one. A name inside a
 * longer one that also matched ("Acme" in "Acme Website") gives way to it;
 * two different projects named is a question for the person, not a guess.
 */
function projectInCaption(caption: string | undefined, projects: ProjectChoice[]): ProjectChoice | null {
  if (!caption?.trim()) return null
  const text = comparable(caption)
  const found = projects.map((p) => ({ p, name: comparable(p.name) })).filter(({ name }) => name.length >= 3 && mentions(text, name))
  const best = found.filter((a) => !found.some((b) => b.name.length > a.name.length && b.name.includes(a.name)))
  // Two projects with the same name, for different clients, leave two here: ask.
  return best.length === 1 ? best[0]!.p : null
}

/** A caption that is only the project's name says nothing more about the expense. */
function captionNote(caption: string | undefined, project: ProjectChoice | undefined): string | null {
  const note = caption?.trim() || null
  if (!note || !project) return note
  return comparable(note.replace(/^[\s#:\-–—]+|[\s.:\-–—]+$/g, '')) === comparable(project.name) ? null : note
}

const openRow = (url: string) => (url.startsWith('https://') ? [[{ text: 'Open in Workloom', url }]] : [])

/** Confirm and Discard, under a draft that is ready for them. */
function draftKeyboard(expenseId: string, url: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: 'Confirm', callback_data: encodeCallback({ action: 'confirm', expenseId }) },
        { text: 'Discard', callback_data: encodeCallback({ action: 'discard', expenseId }) },
      ],
      ...openRow(url),
    ],
  }
}

/** One button per project, the newest few, in name order; then no project, or discard. */
function projectKeyboard(expenseId: string, projects: ProjectChoice[], url: string): InlineKeyboard {
  const listed = projects.slice(0, PROJECT_CHOICES).sort((a, b) => a.name.localeCompare(b.name))
  return {
    inline_keyboard: [
      ...listed.map((p) => [
        { text: (p.companyName ? `${p.name} · ${p.companyName}` : p.name).slice(0, 60), callback_data: encodeCallback({ action: 'project', expenseId, projectId: p.id }) },
      ]),
      [
        { text: 'No project', callback_data: encodeCallback({ action: 'noProject', expenseId }) },
        { text: 'Discard', callback_data: encodeCallback({ action: 'discard', expenseId }) },
      ],
      ...openRow(url),
    ],
  }
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

/**
 * A receipt from a linked member. From a group, everything about it -- the
 * amounts, the buttons, any problem -- goes to the sender privately, and the
 * group sees one line that it was taken.
 */
async function receipt(context: UpdateContext, message: TelegramMessage, member: Member, appUrl: string, group?: TelegramMessage['chat']) {
  const { organizationId, bot, row, client } = context
  const chat = group ? member.chatId : message.chat.id

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

  // Read once: a retry after a crash reuses what was read -- and the project
  // the caption named -- so the expense it replays is the same one, and the
  // receipt is not sent to be read twice.
  const reading = await receiptReadingOn(organizationId)
  const projects = await activeProjects(member)
  let draft: ReceiptDraft | null
  let projectId: string | null
  if (row.extraction !== null) {
    const saved = row.extraction as { draft: unknown; projectId?: string | null }
    draft = saved.draft === null ? null : receiptDraftSchema.parse(saved.draft)
    projectId = saved.projectId !== undefined ? saved.projectId : (projectInCaption(message.caption, projects)?.id ?? null)
  } else {
    draft = reading ? await readReceipt({ bytes, contentType: type }, await receiptHintsFor(member.request), context.extractor === undefined ? undefined : context.extractor) : null
    projectId = projectInCaption(message.caption, projects)?.id ?? null
    await withTenant(organizationId, (tx) => tx.update(schema.telegramUpdates).set({ extraction: { draft, projectId } }).where(eq(schema.telegramUpdates.id, row.id)))
  }

  let created: { expense: { id: string; description: string; currency: string; projectName: string | null }; duplicateOf: { number: string | null; description: string } | null }
  try {
    created = (await executeProcedure('expense.createFromReceipt', {
      ...member.request,
      input: {
        file: new File([new Uint8Array(bytes)], receiptFilename(file.name, type), { type }),
        draft,
        note: captionNote(message.caption, projects.find((p) => p.id === projectId)),
        projectId,
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
  // No project named, and some to choose from: ask before offering Confirm.
  const ask = !created.expense.projectName && projects.length > 0
  const lines = [
    `Draft expense started: ${created.expense.description}`,
    reading ? describeDraft(draft, created.expense.currency) : 'Fill in the amount in Workloom, then confirm it.',
    created.expense.projectName ? `Project: ${created.expense.projectName}` : null,
    created.duplicateOf ? `This looks like the same receipt as ${created.duplicateOf.number ?? created.duplicateOf.description}.` : null,
    ask ? (projects.length > PROJECT_CHOICES ? `${PROJECT_QUESTION} Only the ${PROJECT_CHOICES} newest are listed; choose another in Workloom.` : PROJECT_QUESTION) : null,
    // Telegram only opens HTTPS links from a button; otherwise the link is in the text.
    appUrl.startsWith('https://') ? null : url,
  ].filter(Boolean)
  const keyboard = ask ? projectKeyboard(created.expense.id, projects, url) : draftKeyboard(created.expense.id, url)
  await client.sendMessage(chat, lines.join('\n'), keyboard)
  if (group) await client.sendMessage(group.id, `Draft expense started for ${member.userName}. The details are in your private chat with me.`)
}

type GroupRow = typeof schema.telegramGroups.$inferSelect

async function approvedGroup(organizationId: string, chatId: number): Promise<GroupRow | null> {
  const g = schema.telegramGroups
  const [group] = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(g)
      .where(and(eq(g.chatId, String(chatId)), isNull(g.revokedAt)))
      .limit(1),
  )
  return group ?? null
}

/**
 * A message in a group. The bot answers only in groups an owner or admin has
 * approved, and there only to receipts from linked members. Everyone else,
 * and every other group, gets silence: a bot that chatters in groups is a bot
 * people mute.
 */
async function groupMessage(context: UpdateContext, message: TelegramMessage) {
  const { organizationId } = context
  // Telegram may address a command to the bot by name: /start@webloom_bot CODE.
  const command = /^\/(start|link)(?:@(\w+))?(?:\s+(\S+))?/.exec(message.text?.trim() ?? '')
  if (command?.[3] && (!command[2] || command[2].toLowerCase() === context.bot.username.toLowerCase())) return approveGroup(context, message, command[3])

  if (message.migrate_to_chat_id) {
    // The group became a supergroup, with a new id: the approval moves with it.
    await withTenant(organizationId, (tx) =>
      tx
        .update(schema.telegramGroups)
        .set({ chatId: String(message.migrate_to_chat_id) })
        .where(and(eq(schema.telegramGroups.chatId, String(message.chat.id)), isNull(schema.telegramGroups.revokedAt))),
    )
    return
  }

  if (!(message.photo?.length || message.document)) return
  if (!(await approvedGroup(organizationId, message.chat.id))) return
  const member = await linkedMember(organizationId, message.from!, context.now)
  if (!member) return
  const { appUrl } = await telegramSettings()
  return receipt(context, message, member, appUrl, message.chat)
}

/** `/link <code>` in a group, or the code Telegram's "add to group" link carries: approves the group. */
async function approveGroup(context: UpdateContext, message: TelegramMessage, code: string) {
  const { organizationId, now, bot } = context
  const c = schema.messagingLinkCodes
  const g = schema.telegramGroups
  const userId = await withTenant(organizationId, async (tx) => {
    const [found] = await tx
      .select()
      .from(c)
      .where(and(eq(c.codeHash, hashSecret(code)), eq(c.purpose, 'group'), isNull(c.usedAt), gt(c.expiresAt, now)))
      .limit(1)
      .for('update')
    if (!found) return null
    await tx.update(c).set({ usedAt: now }).where(eq(c.id, found.id))
    return found.userId
  })
  // The code's maker must still be able to approve groups.
  const request = userId ? await memberRequest(organizationId, userId, now) : null
  if (!userId || !request || !request.permissions.has('integration:manage')) {
    await context.client.sendMessage(message.chat.id, 'That code has expired or was already used. An owner or admin can make a new one in Workloom.')
    return
  }
  const hooks = { commit: [] as Array<() => Promise<void>>, rollback: [] as Array<() => Promise<void>> }
  await withTenant(organizationId, async (tx) => {
    const ctx = buildContext(request, tx, hooks)
    const [existing] = await tx
      .select({ id: g.id })
      .from(g)
      .where(and(eq(g.chatId, String(message.chat.id)), isNull(g.revokedAt)))
      .limit(1)
    const id = existing?.id ?? newId()
    if (existing) await tx.update(g).set({ title: message.chat.title ?? null }).where(eq(g.id, id))
    else await tx.insert(g).values({ id, organizationId, botId: bot.id, chatId: String(message.chat.id), title: message.chat.title ?? null, approvedBy: userId, approvedAt: now })
    await ctx.audit({ action: 'telegram_group.approved', entityType: 'telegram_group', entityId: id, entityLabel: message.chat.title ?? String(message.chat.id) })
  })
  await context.client.sendMessage(
    message.chat.id,
    'This group is linked to Workloom. Post a receipt photo or PDF here and it becomes a draft expense for whoever sent it; the details go to them privately. Link your own Telegram in Workloom first.',
  )
}

/** The bot was added to a chat or taken out of one. Taken out of a group, its approval ends. */
async function membershipChanged(context: UpdateContext, change: NonNullable<TelegramUpdate['my_chat_member']>) {
  if (change.new_chat_member.status !== 'left' && change.new_chat_member.status !== 'kicked') return
  await withTenant(context.organizationId, (tx) =>
    tx
      .update(schema.telegramGroups)
      .set({ revokedAt: context.now, revokedReason: 'the bot left the group' })
      .where(and(eq(schema.telegramGroups.chatId, String(change.chat.id)), isNull(schema.telegramGroups.revokedAt))),
  )
}

/** A Confirm, Discard or project press, done as -- and only if allowed for -- the person who pressed it. */
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
  let keyboard: InlineKeyboard | undefined
  try {
    if (action.action === 'project' || action.action === 'noProject') {
      const expense = (await executeProcedure('expense.update', {
        ...member.request,
        input: { id: action.expenseId, projectId: action.action === 'project' ? action.projectId : null },
      })) as { id: string; description: string; projectName: string | null }
      const line = `Project: ${expense.projectName ?? 'none'}`
      reply = expense.projectName ? `Filed under ${expense.projectName}` : 'No project'
      // The question's line becomes the answer; the rest of the message stays as it was.
      const before = query.message?.text?.split('\n') ?? [`Draft expense: ${expense.description}`]
      const asked = before.findIndex((l) => l.startsWith(PROJECT_QUESTION))
      if (asked >= 0) before[asked] = line
      else before.push(line)
      edit = before.join('\n')
      const { appUrl } = await telegramSettings()
      keyboard = draftKeyboard(expense.id, `${appUrl}/expenses/${expense.id}`)
    } else if (action.action === 'confirm') {
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
  if (edit && query.message) await client.editMessageText(query.message.chat.id, query.message.message_id, edit, keyboard).catch(() => undefined)
}
