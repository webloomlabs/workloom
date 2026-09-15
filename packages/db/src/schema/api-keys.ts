import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn } from './columns.ts'

/**
 * API keys.
 *
 * Hand-rolled rather than delegated to a plugin: Better Auth 1.7 has no
 * apiKey plugin, and the behaviour that matters here is custom anyway -- a
 * key's effective permissions are the intersection of its scopes with the
 * live permissions of the user who owns it, evaluated per request. Demote
 * someone from Finance and their keys lose finance access immediately, with
 * no key re-issuance and no stale grant left behind.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,

    /**
     * The owning user. Their role is the ceiling on what this key can do,
     * which is why the key is useless once they are removed from the org.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /**
     * SHA-256 of the secret. The secret itself is shown once, at creation,
     * and never stored -- a leaked database must not yield working keys.
     */
    keyHash: text('key_hash').notNull(),
    /** Leading characters, for identifying a key in the UI without revealing it. */
    keyPrefix: text('key_prefix').notNull(),

    /**
     * Permission strings this key is limited to. NULL means "everything the
     * owner may do", which is still bounded by their role at request time.
     */
    scopes: text('scopes').array(),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('api_keys_organization_id_id_idx').on(t.organizationId, t.id),
    // Lookup on authentication is by hash alone: the request presents a
    // secret, not an organization.
    uniqueIndex('api_keys_key_hash_key').on(t.keyHash),
  ],
)
