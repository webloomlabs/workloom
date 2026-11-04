import { sql } from 'drizzle-orm'
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn, timestamps } from './columns.ts'

/**
 * Talking to Workloom from a chat app (S19): the organization's Telegram bot,
 * the people linked to it, and the updates it receives.
 *
 * Updates land in an inbox first, whichever way they arrive -- pushed to the
 * webhook or pulled by the worker -- and the worker processes them from there.
 * The inbox's unique key on Telegram's update id is what makes a delivery that
 * arrives twice create one expense, not two.
 */

function oneOf(values: readonly string[]) {
  return sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`)
}

/** How updates reach Workloom: Telegram pushes them (needs a public HTTPS address), or the worker asks. */
export const TELEGRAM_MODES = ['webhook', 'poll'] as const
export const TELEGRAM_BOT_STATUSES = ['active', 'paused', 'error'] as const
export const MESSAGING_PROVIDERS = ['telegram'] as const
export const TELEGRAM_UPDATE_STATUSES = ['pending', 'done', 'failed'] as const
/** What a link code links: a person's own chat account, or a group the bot works in. */
export const LINK_CODE_PURPOSES = ['identity', 'group'] as const

export const telegramBots = pgTable(
  'telegram_bots',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** Telegram's id for the bot, and its @username. */
    telegramBotId: text('telegram_bot_id').notNull(),
    username: text('username').notNull(),
    /** The bot token, encrypted with WORKLOOM_ENCRYPTION_KEY. */
    tokenEncrypted: text('token_encrypted').notNull(),
    /** SHA-256 of the secret Telegram sends with each webhook call. Null in poll mode. */
    webhookSecretHash: text('webhook_secret_hash'),
    mode: text('mode').notNull().default('poll'),
    status: text('status').notNull().default('active'),
    lastError: text('last_error'),
    /** The highest update id taken in poll mode; the next poll asks for the ones after it. */
    lastUpdateId: bigint('last_update_id', { mode: 'number' }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('telegram_bots_organization_id_id_key').on(t.organizationId, t.id),
    /** One bot per organization. */
    unique('telegram_bots_organization_key').on(t.organizationId),
    check('telegram_bots_mode_check', sql`${t.mode} in ${oneOf(TELEGRAM_MODES)}`),
    check('telegram_bots_status_check', sql`${t.status} in ${oneOf(TELEGRAM_BOT_STATUSES)}`),
    check('telegram_bots_webhook_secret_check', sql`${t.mode} = 'poll' or ${t.webhookSecretHash} is not null`),
  ],
)

/** A member's account in a chat app, linked by a code they sent from it. */
export const messagingIdentities = pgTable(
  'messaging_identities',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** The person's id in the chat app, and the private chat with the bot. */
    externalUserId: text('external_user_id').notNull(),
    chatId: text('chat_id').notNull(),
    displayName: text('display_name'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    unique('messaging_identities_organization_id_id_key').on(t.organizationId, t.id),
    /** One live link per chat account: a second link moves it, it does not duplicate it. */
    uniqueIndex('messaging_identities_live_key')
      .on(t.organizationId, t.provider, t.externalUserId)
      .where(sql`${t.revokedAt} is null`),
    index('messaging_identities_user_idx').on(t.organizationId, t.userId),
    check('messaging_identities_provider_check', sql`${t.provider} in ${oneOf(MESSAGING_PROVIDERS)}`),
  ],
)

/** A one-time code a member sends the bot to link their chat account. Stored hashed. */
export const messagingLinkCodes = pgTable(
  'messaging_link_codes',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    purpose: text('purpose').notNull().default('identity'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('messaging_link_codes_organization_id_id_key').on(t.organizationId, t.id),
    unique('messaging_link_codes_code_key').on(t.organizationId, t.codeHash),
    check('messaging_link_codes_purpose_check', sql`${t.purpose} in ${oneOf(LINK_CODE_PURPOSES)}`),
  ],
)

/**
 * A Telegram group the bot works in, approved by an owner or admin with a
 * one-time code. In any other group the bot stays silent.
 */
export const telegramGroups = pgTable(
  'telegram_groups',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    botId: uuid('bot_id').notNull(),
    chatId: text('chat_id').notNull(),
    title: text('title'),
    approvedBy: uuid('approved_by').references(() => user.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Why it stopped: removed in Workloom, or the bot was taken out of the group. */
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    unique('telegram_groups_organization_id_id_key').on(t.organizationId, t.id),
    uniqueIndex('telegram_groups_live_key')
      .on(t.organizationId, t.chatId)
      .where(sql`${t.revokedAt} is null`),
    foreignKey({ name: 'telegram_groups_bot_fk', columns: [t.organizationId, t.botId], foreignColumns: [telegramBots.organizationId, telegramBots.id] }).onDelete('cascade'),
  ],
)

/** Everything the bot has received, waiting for or past processing. */
export const telegramUpdates = pgTable(
  'telegram_updates',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    botId: uuid('bot_id').notNull(),
    updateId: bigint('update_id', { mode: 'number' }).notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastError: text('last_error'),
    /**
     * What reading the receipt gave, kept so that a retry after a crash sends
     * the same thing to the expense it creates -- and is not charged twice.
     */
    extraction: jsonb('extraction'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    unique('telegram_updates_organization_id_id_key').on(t.organizationId, t.id),
    /** A delivery that arrives twice is stored once. */
    unique('telegram_updates_once_key').on(t.organizationId, t.botId, t.updateId),
    index('telegram_updates_due_idx').on(t.organizationId, t.status, t.nextAttemptAt),
    foreignKey({ name: 'telegram_updates_bot_fk', columns: [t.organizationId, t.botId], foreignColumns: [telegramBots.organizationId, telegramBots.id] }).onDelete('cascade'),
    check('telegram_updates_status_check', sql`${t.status} in ${oneOf(TELEGRAM_UPDATE_STATUSES)}`),
  ],
)
