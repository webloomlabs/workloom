import { createHash, timingSafeEqual } from 'node:crypto'
import { generateSecret, hashApiKey, newId, writeAuditEntry } from '@workloom/core'
// The verification table is an auth table, not a tenant table.
import { and, db, eq, isNull, schema, withTenant, type TenantTransaction } from '@workloom/db'
import { withAuthLookup } from '../auth-lookup.ts'
import { findMemberRole } from '../membership-role.ts'
import { authenticateClient, clientCredentials, getClient, type OAuthClient } from './clients.ts'
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_SECONDS,
  mcpResource,
  normalizeResource,
  OAUTH_SCOPE,
  REFRESH_REUSE_GRACE_SECONDS,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_SECONDS,
} from './config.ts'
import { codeIdentifier, type StoredCode } from './authorize.ts'
import { OAuthError } from './errors.ts'

/**
 * The token endpoint, token verification, and revocation.
 *
 * Tokens are opaque and stored as digests, like API keys. A JWT would save
 * nothing: every request re-reads the person's role anyway, which is what
 * makes demotion and removal take effect at once, and an opaque token can be
 * revoked by deleting a row rather than by waiting for it to expire.
 */

export type TokenResponse = {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

type Body = Record<string, string | undefined>

export async function exchangeToken(body: Body, authorization: string | null, now = new Date()): Promise<TokenResponse> {
  const { clientId, clientSecret } = clientCredentials(authorization, body)
  if (!clientId) throw new OAuthError('invalid_client', 'client_id is required.', 401)
  const client = await getClient(clientId)
  if (!client) throw new OAuthError('invalid_client', 'Unknown client.', 401)
  authenticateClient(client, clientSecret)

  switch (body.grant_type) {
    case 'authorization_code':
      return exchangeCode(client, body, now)
    case 'refresh_token':
      return refresh(client, body, now)
    default:
      throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.')
  }
}

async function exchangeCode(client: OAuthClient, body: Body, now: Date): Promise<TokenResponse> {
  if (!body.code || !body.code_verifier) {
    throw new OAuthError('invalid_request', 'code and code_verifier are required.')
  }

  // Consumed atomically: a code works once, even if presented twice at once.
  const [row] = await db
    .delete(schema.verification)
    .where(eq(schema.verification.identifier, codeIdentifier(body.code)))
    .returning({ value: schema.verification.value, expiresAt: schema.verification.expiresAt })
  if (!row || row.expiresAt.getTime() <= now.getTime()) {
    throw new OAuthError('invalid_grant', 'The authorization code is invalid, used, or expired.')
  }
  const stored = JSON.parse(row.value) as StoredCode

  if (stored.clientId !== client.id) throw new OAuthError('invalid_grant', 'The code was issued to another client.')
  if (body.redirect_uri !== undefined && body.redirect_uri !== stored.redirectUri) {
    throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.')
  }
  if (!pkceMatches(body.code_verifier, stored.codeChallenge)) {
    throw new OAuthError('invalid_grant', 'code_verifier does not match the code challenge.')
  }
  if (body.resource !== undefined && normalizeResource(body.resource) !== stored.resource) {
    throw new OAuthError('invalid_target', `The only resource here is ${mcpResource()}.`)
  }

  if (!(await findMemberRole(stored.userId, stored.organizationId))) {
    await revokeGrant(stored.organizationId, stored.grantId, now)
    throw new OAuthError('invalid_grant', 'The person who approved this is no longer a member.')
  }

  return withTenant(stored.organizationId, async (tx) => {
    const [grant] = await tx
      .select({ revokedAt: schema.oauthGrants.revokedAt })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.id, stored.grantId))
      .limit(1)
    if (!grant || grant.revokedAt) throw new OAuthError('invalid_grant', 'This connection has been revoked.')
    return (await issueTokens(tx, stored.organizationId, stored.grantId, now)).response
  })
}

async function refresh(client: OAuthClient, body: Body, now: Date): Promise<TokenResponse> {
  if (!body.refresh_token?.startsWith(REFRESH_TOKEN_PREFIX)) {
    throw new OAuthError('invalid_grant', 'The refresh token is invalid.')
  }
  const found = await lookupToken(body.refresh_token)
  if (!found || found.token.kind !== 'refresh' || found.grant.clientId !== client.id) {
    throw new OAuthError('invalid_grant', 'The refresh token is invalid.')
  }
  const { token, grant } = found

  if (grant.revokedAt) throw new OAuthError('invalid_grant', 'This connection has been revoked.')

  if (token.revokedAt) {
    // A used refresh token, presented again. Within a few seconds that is a
    // client refreshing twice at once; any later, the token has leaked, and
    // the whole connection goes.
    const replacedRecently =
      token.replacedBy !== null && now.getTime() - token.revokedAt.getTime() <= REFRESH_REUSE_GRACE_SECONDS * 1000
    if (!replacedRecently) {
      await revokeGrant(token.organizationId, grant.id, now)
      throw new OAuthError('invalid_grant', 'The refresh token was already used. The connection has been revoked; reconnect the app.')
    }
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    throw new OAuthError('invalid_grant', 'The refresh token has expired. Reconnect the app.')
  }
  if (!(await findMemberRole(grant.userId, token.organizationId))) {
    await revokeGrant(token.organizationId, grant.id, now)
    throw new OAuthError('invalid_grant', 'The person who approved this is no longer a member.')
  }

  return withTenant(token.organizationId, async (tx) => {
    const issued = await issueTokens(tx, token.organizationId, grant.id, now)
    if (!token.revokedAt) {
      await tx
        .update(schema.oauthTokens)
        .set({ revokedAt: now, replacedBy: issued.refreshId })
        .where(eq(schema.oauthTokens.id, token.id))
    }
    return issued.response
  })
}

async function issueTokens(
  tx: TenantTransaction,
  organizationId: string,
  grantId: string,
  now: Date,
): Promise<{ response: TokenResponse; refreshId: string }> {
  const access = generateSecret(ACCESS_TOKEN_PREFIX)
  const refresh = generateSecret(REFRESH_TOKEN_PREFIX)
  const refreshId = newId()
  await tx.insert(schema.oauthTokens).values([
    {
      id: newId(),
      organizationId,
      grantId,
      kind: 'access',
      tokenHash: access.hash,
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_SECONDS * 1000),
      createdAt: now,
    },
    {
      id: refreshId,
      organizationId,
      grantId,
      kind: 'refresh',
      tokenHash: refresh.hash,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_SECONDS * 1000),
      createdAt: now,
    },
  ])
  const response: TokenResponse = {
    access_token: access.secret,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refresh.secret,
    scope: OAUTH_SCOPE,
  }
  return { response, refreshId }
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) == challenge, compared in constant time. */
function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

/** A token and its grant, looked up by digest before the organization is known. */
async function lookupToken(secret: string) {
  const hash = hashApiKey(secret)
  const [row] = await withAuthLookup((tx) =>
    tx
      .select({ token: schema.oauthTokens, grant: schema.oauthGrants })
      .from(schema.oauthTokens)
      .innerJoin(
        schema.oauthGrants,
        and(
          eq(schema.oauthGrants.id, schema.oauthTokens.grantId),
          eq(schema.oauthGrants.organizationId, schema.oauthTokens.organizationId),
        ),
      )
      .where(eq(schema.oauthTokens.tokenHash, hash))
      .limit(1),
  )
  return row
}

export type VerifiedOAuthToken = {
  grantId: string
  organizationId: string
  userId: string
  clientName: string
  /** Null means everything the person may do. */
  scopes: string[] | null
  lastUsedAt: Date | null
}

/** Checks an access token presented to the MCP endpoint. Null when it is no good for any reason. */
export async function verifyOAuthAccessToken(secret: string, now = new Date()): Promise<VerifiedOAuthToken | null> {
  if (!secret.startsWith(ACCESS_TOKEN_PREFIX)) return null
  const found = await lookupToken(secret)
  if (!found) return null
  const { token, grant } = found
  if (token.kind !== 'access' || token.revokedAt || grant.revokedAt) return null
  if (token.expiresAt.getTime() <= now.getTime()) return null
  // Tokens are bound to the MCP endpoint (RFC 8707). Should Workloom ever
  // serve a second resource, a token for one must not work at the other.
  if (grant.resource !== mcpResource()) return null
  return {
    grantId: grant.id,
    organizationId: grant.organizationId,
    userId: grant.userId,
    clientName: grant.clientName,
    scopes: grant.scopes,
    lastUsedAt: grant.lastUsedAt,
  }
}

/** Best-effort, and at most every few minutes: an activity timestamp, not part of authorization. */
export async function touchGrant(token: VerifiedOAuthToken, now = new Date()): Promise<void> {
  if (token.lastUsedAt && now.getTime() - token.lastUsedAt.getTime() < 5 * 60 * 1000) return
  try {
    await withTenant(token.organizationId, (tx) =>
      tx.update(schema.oauthGrants).set({ lastUsedAt: now }).where(eq(schema.oauthGrants.id, token.grantId)),
    )
  } catch {
    // Deliberately ignored.
  }
}

/**
 * RFC 7009. Revoking either token ends the whole connection: an app asking
 * to be signed out means all of it. Always succeeds from the caller's point
 * of view, so the endpoint cannot be used to test which tokens exist.
 */
export async function revokeToken(body: Body, authorization: string | null, now = new Date()): Promise<void> {
  const token = body.token
  if (!token || !(token.startsWith(ACCESS_TOKEN_PREFIX) || token.startsWith(REFRESH_TOKEN_PREFIX))) return
  const { clientId, clientSecret } = clientCredentials(authorization, body)
  const found = await lookupToken(token)
  if (!found) return
  if (clientId !== undefined) {
    if (clientId !== found.grant.clientId) return
    const client = await getClient(clientId)
    if (!client) return
    authenticateClient(client, clientSecret)
  }
  await revokeGrant(found.token.organizationId, found.grant.id, now, { reason: 'client' })
}

/** Ends a connection: the grant and every token issued under it. */
export async function revokeGrant(
  organizationId: string,
  grantId: string,
  now = new Date(),
  options: { reason?: 'client' | 'reuse' } = {},
): Promise<void> {
  await withTenant(organizationId, async (tx) => {
    const [grant] = await tx
      .update(schema.oauthGrants)
      .set({ revokedAt: now })
      .where(and(eq(schema.oauthGrants.id, grantId), isNull(schema.oauthGrants.revokedAt)))
      .returning({ id: schema.oauthGrants.id, clientName: schema.oauthGrants.clientName, userId: schema.oauthGrants.userId })
    await tx
      .update(schema.oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(schema.oauthTokens.grantId, grantId), isNull(schema.oauthTokens.revokedAt)))
    if (grant) {
      await writeAuditEntry(tx, {
        organizationId,
        actor: { type: 'system', label: `OAuth (${options.reason === 'client' ? 'disconnected by the app' : 'security check'})` },
        requestId: newId(),
        source: 'system',
        entry: { action: 'oauth_grant.revoked', entityType: 'oauth_grant', entityId: grant.id, entityLabel: grant.clientName },
      })
    }
  })
}
