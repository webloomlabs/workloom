import { sql } from 'drizzle-orm'
import { check, foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { tenantColumn } from './columns.ts'

/**
 * OAuth 2.1, so that AI assistants such as ChatGPT and Claude can connect to
 * the MCP server with "Connect → sign in → Allow" rather than a pasted key.
 *
 * Hand-rolled for the same reason as API keys: Better Auth 1.7 has no OAuth
 * provider, and the behaviour that matters is Workloom's own -- a grant is
 * an API key in all but name. Its authority is the person's CURRENT role,
 * narrowed by the scopes chosen at consent, re-evaluated on every request.
 *
 * Authorization codes live for minutes and are stored, hashed, in Better
 * Auth's `verification` table rather than here.
 */

/**
 * Registered clients (RFC 7591 Dynamic Client Registration).
 *
 * Deliberately has NO organization_id: a client registers before anyone has
 * signed in, let alone chosen an organization, so this is infrastructure
 * like `rate_limits`, not a tenant table. Everything in it is
 * self-asserted by whoever registered it -- the name above all -- and is
 * shown as such.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    /** Public identifier, `wlc_…`. */
    id: text('id').primaryKey(),
    clientName: text('client_name').notNull(),
    clientUri: text('client_uri'),
    redirectUris: text('redirect_uris').array().notNull(),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
    /** SHA-256 of the secret, for the rare confidential client. Null for public clients. */
    clientSecretHash: text('client_secret_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check(
      'oauth_clients_auth_method_check',
      sql`token_endpoint_auth_method in ('none', 'client_secret_post', 'client_secret_basic')`,
    ),
  ],
)

/** One person's consent for one client to act in one organization. */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    /** The person. Their role is the ceiling, read afresh on every request. */
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    /** As shown at consent, so the list of connected apps reads the same later. */
    clientName: text('client_name').notNull(),
    /** The resource (RFC 8707) tokens from this grant are good for: the MCP endpoint. */
    resource: text('resource').notNull(),
    /** Permission strings, as for API keys. NULL means everything the person may do. */
    scopes: text('scopes').array(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('oauth_grants_organization_id_id_idx').on(t.organizationId, t.id),
    index('oauth_grants_organization_user_idx').on(t.organizationId, t.userId),
    unique('oauth_grants_organization_id_id_key').on(t.organizationId, t.id),
  ],
)

/**
 * Access and refresh tokens, stored as SHA-256 digests -- a leaked backup
 * must not yield working credentials, exactly as for API keys.
 */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: uuid('id').primaryKey(),
    ...tenantColumn,
    grantId: uuid('grant_id').notNull(),
    kind: text('kind').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** For a used refresh token: the one that replaced it. Presenting it again means it leaked. */
    replacedBy: uuid('replaced_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('oauth_tokens_organization_grant_idx').on(t.organizationId, t.grantId),
    // Lookup on authentication is by hash alone: the organization is what it discovers.
    uniqueIndex('oauth_tokens_token_hash_key').on(t.tokenHash),
    check('oauth_tokens_kind_check', sql`${t.kind} in ('access', 'refresh')`),
    foreignKey({
      name: 'oauth_tokens_grant_fk',
      columns: [t.organizationId, t.grantId],
      foreignColumns: [oauthGrants.organizationId, oauthGrants.id],
    }).onDelete('cascade'),
  ],
)
