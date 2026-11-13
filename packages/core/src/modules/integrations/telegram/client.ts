/**
 * The small part of Telegram's Bot API that Workloom uses.
 *
 * The bot token is part of every URL Telegram's API takes, so it is kept out
 * of every error this raises: a failed call logs the method, never the URL.
 * The base address can be changed, which is how the tests point it at a fake.
 */

export type TelegramUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export type TelegramChat = { id: number; type: string; title?: string }
export type TelegramPhotoSize = { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }
export type TelegramDocument = { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
export type TelegramMessage = {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  caption?: string
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
  /** Photos or files sent together as an album share this; each still comes as its own message. */
  media_group_id?: string
  /** A group became a supergroup, and has a new id. */
  migrate_to_chat_id?: number
}
export type TelegramCallbackQuery = { id: string; from: TelegramUser; message?: TelegramMessage; data?: string }
/** The bot's own membership of a chat changed: added to a group, or removed from it. */
export type TelegramChatMemberUpdated = { chat: TelegramChat; from: TelegramUser; new_chat_member: { status: string; user: TelegramUser } }
export type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery; my_chat_member?: TelegramChatMemberUpdated }
export type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> }

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    description: string,
    /** Telegram said the token is wrong or the bot was deleted. */
    readonly unauthorized = status === 401 || status === 404,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`)
    this.name = 'TelegramError'
  }
}

const TIMEOUT_MS = 15_000
/** What the bot asks Telegram for: messages, button presses, and being added to or removed from groups. */
const UPDATE_TYPES = ['message', 'callback_query', 'my_chat_member']

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly base = 'https://api.telegram.org',
  ) {}

  private async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      // The cause can carry the URL, and with it the token.
      throw new TelegramError(method, 0, error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not reach Telegram')
    }
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null
    if (!response.ok || !payload?.ok) throw new TelegramError(method, response.status, this.redact(payload?.description ?? response.statusText))
    return payload.result as T
  }

  private redact(text: string): string {
    return text.split(this.token).join('<token>')
  }

  getMe() {
    return this.call<TelegramUser & { username: string }>('getMe')
  }

  setWebhook(url: string, secretToken: string) {
    return this.call<boolean>('setWebhook', { url, secret_token: secretToken, allowed_updates: UPDATE_TYPES, drop_pending_updates: false })
  }

  deleteWebhook() {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: false })
  }

  getUpdates(offset: number | undefined, limit = 50) {
    return this.call<TelegramUpdate[]>('getUpdates', { ...(offset !== undefined ? { offset } : {}), limit, timeout: 0, allowed_updates: UPDATE_TYPES })
  }

  sendMessage(chatId: number | string, text: string, replyMarkup?: InlineKeyboard) {
    return this.call<TelegramMessage>('sendMessage', { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })
  }

  editMessageText(chatId: number | string, messageId: number, text: string, replyMarkup?: InlineKeyboard) {
    return this.call<TelegramMessage | boolean>('editMessageText', { chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call<boolean>('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) })
  }

  /** Downloads a file the bot was sent, refusing one over the limit before fetching it. */
  async downloadFile(fileId: string, maxBytes: number): Promise<Buffer> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
    if (!file.file_path) throw new TelegramError('getFile', 0, 'no file path')
    if (file.file_size && file.file_size > maxBytes) throw new TelegramError('getFile', 413, 'file too large')
    let response: Response
    try {
      response = await fetch(`${this.base}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) })
    } catch {
      throw new TelegramError('downloadFile', 0, 'could not reach Telegram')
    }
    if (!response.ok) throw new TelegramError('downloadFile', response.status, response.statusText)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new TelegramError('downloadFile', 413, 'file too large')
    return bytes
  }
}

/**
 * What a button carries back: an action, the expense it acts on, and for a
 * project or account choice the project or account. Telegram allows 64 bytes.
 * "x:c:" and a UUID take 40; a choice carries two UUIDs, so they go as
 * base64url (22 characters each) to fit: "x:p:" + 22 + ":" + 22 is 49.
 */
export type CallbackAction =
  | { action: 'confirm' | 'discard' | 'noProject' | 'noAccount'; expenseId: string }
  | { action: 'project'; expenseId: string; projectId: string }
  | { action: 'account'; expenseId: string; bankAccountId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LETTERS = { confirm: 'c', discard: 'd', noProject: 'n', noAccount: 'b' } as const
const ACTIONS = { c: 'confirm', d: 'discard', n: 'noProject', b: 'noAccount' } as const

const packUuid = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url')

function unpackUuid(packed: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(packed)) return null
  const hex = Buffer.from(packed, 'base64url').toString('hex')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return UUID.test(uuid) ? uuid : null
}

export function encodeCallback(value: CallbackAction): string {
  if (value.action === 'project') return `x:p:${packUuid(value.expenseId)}:${packUuid(value.projectId)}`
  if (value.action === 'account') return `x:a:${packUuid(value.expenseId)}:${packUuid(value.bankAccountId)}`
  return `x:${LETTERS[value.action]}:${value.expenseId}`
}

export function decodeCallback(data: string | undefined): CallbackAction | null {
  const pair = /^x:([pa]):([^:]+):([^:]+)$/.exec(data ?? '')
  if (pair) {
    const expenseId = unpackUuid(pair[2]!)
    const otherId = unpackUuid(pair[3]!)
    if (!expenseId || !otherId) return null
    return pair[1] === 'p' ? { action: 'project', expenseId, projectId: otherId } : { action: 'account', expenseId, bankAccountId: otherId }
  }
  const match = /^x:([cdnb]):(.+)$/.exec(data ?? '')
  if (!match || !UUID.test(match[2]!)) return null
  return { action: ACTIONS[match[1] as keyof typeof ACTIONS], expenseId: match[2]! }
}
