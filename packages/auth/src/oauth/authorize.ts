import { randomBytes } from 'node:crypto'
import {
  DomainError,
  hashApiKey,
  isPermission,
  isRole,
  newId,
  roleHasPermission,
  writeAuditEntry,
  type Actor,
  type Permission,
  type Role,
} from '@workloom/core'
// Organization membership and the verification table are auth tables, not
// tenant tables; see docs/architecture.md.
import { and, db, eq, isNull, schema, withTenant } from '@workloom/db'
import { findMemberRole } from '../membership-role.ts'
import { getClient, redirectUriMatches, type OAuthClient } from './clients.ts'
import { CODE_SECONDS, issuer, mcpResource, normalizeResource } from './config.ts'

/**
 * The authorization endpoint's logic: checking a request, and turning a
 * person's consent into a one-time code.
 *
 * The page and the form in the web app only render and submit. Everything
 * that decides anything happens here, and is re-run on submit -- the hidden
 * form fields that carry the request are as untrusted as the URL they came
 * from.
 */

export type AuthorizeRequest = {
  client: OAuthClient
  redirectUri: string
  codeChallenge: string
  state: string | undefined
  resource: string
}

export type AuthorizeValidation =
  | { ok: true; request: AuthorizeRequest }
  /** Shown to the person. The redirect URI is unknown or unverified, so nothing is sent back to it. */
  | { ok: false; kind: 'show'; message: string }
  /** Sent back to the (verified) redirect URI as an OAuth error. */
  | { ok: false; kind: 'redirect'; redirectTo: string }

type Params = Record<string, string | undefined>

export async function validateAuthorizeRequest(params: Params): Promise<AuthorizeValidation> {
  const client = params.client_id ? await getClient(params.client_id) : undefined
  if (!client) {
    return { ok: false, kind: 'show', message: 'This app is not registered with Workloom. Start the connection again from the app.' }
  }

  // Without redirect_uri, a client with exactly one registered URI means that one.
  const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined)
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return { ok: false, kind: 'show', message: 'The app asked to return you to an address it did not register. Nothing was shared.' }
  }

  const fail = (error: string, description: string): AuthorizeValidation => ({
    ok: false,
    kind: 'redirect',
    redirectTo: authorizationRedirect(redirectUri, { error, error_description: description, state: params.state }),
  })

  if (params.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.')
  if (!params.code_challenge || params.code_challenge_method !== 'S256') {
    return fail('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.')
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_challenge)) {
    return fail('invalid_request', 'code_challenge is malformed.')
  }
  if (params.resource !== undefined && normalizeResource(params.resource) !== mcpResource()) {
    return fail('invalid_target', `The only resource here is ${mcpResource()}.`)
  }

  return {
    ok: true,
    request: {
      client,
      redirectUri,
      codeChallenge: params.code_challenge,
      state: params.state,
      resource: mcpResource(),
    },
  }
}

/** The redirect back to the client, with `iss` so it can tell which server answered (RFC 9207). */
export function authorizationRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value)
  url.searchParams.set('iss', issuer())
  return url.toString()
}

export function denyAuthorization(request: AuthorizeRequest): string {
  return authorizationRedirect(request.redirectUri, {
    error: 'access_denied',
    error_description: 'The person declined.',
    state: request.state,
  })
}

/** The organizations a person may connect an app to, with their role in each. */
export async function listMemberships(userId: string): Promise<Array<{ organizationId: string; name: string; role: Role }>> {
  const rows = await db
    .select({ organizationId: schema.member.organizationId, name: schema.organization.name, role: schema.member.role })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, userId))
  return rows
    .filter((r): r is typeof r & { role: Role } => isRole(r.role))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** What the authorization code stands for, until it is exchanged. */
export type StoredCode = {
  grantId: string
  organizationId: string
  userId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  resource: string
}

export const codeIdentifier = (code: string) => `oauth-code:${hashApiKey(code)}`

/**
 * A person said yes. Records the grant and returns where to send them,
 * carrying a code the client exchanges for tokens.
 *
 * The scopes are capped at the person's role in the chosen organization, as
 * an API key's are, and a grant to the same app before this one is revoked:
 * reconnecting replaces, it does not accumulate.
 */
export async function approveAuthorization(input: {
  request: AuthorizeRequest
  user: { id: string; name: string; email: string }
  organizationId: string
  /** Null for full access: everything the person may do. */
  scopes: string[] | null
  context?: { ipAddress?: string | undefined; userAgent?: string | undefined }
  now?: Date
}): Promise<string> {
  const now = input.now ?? new Date()
  const role = await findMemberRole(input.user.id, input.organizationId)
  if (!role) throw new DomainError('You are not a member of that organization.', 'not_a_member')

  let scopes: Permission[] | null = null
  if (input.scopes !== null) {
    scopes = [...new Set(input.scopes)].filter((s): s is Permission => isPermission(s) && roleHasPermission(role, s))
    if (scopes.length === 0) {
      throw new DomainError('Choose at least one permission, or give the app full access.', 'scopes_empty', 'scopes')
    }
  }

  const { client, redirectUri, codeChallenge, resource, state } = input.request
  const grantId = newId()
  const actor: Actor = { type: 'user', id: input.user.id, label: input.user.name || input.user.email }

  await withTenant(input.organizationId, async (tx) => {
    const previous = await tx
      .update(schema.oauthGrants)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.oauthGrants.userId, input.user.id),
          eq(schema.oauthGrants.clientId, client.id),
          isNull(schema.oauthGrants.revokedAt),
        ),
      )
      .returning({ id: schema.oauthGrants.id })
    for (const { id } of previous) {
      await tx
        .update(schema.oauthTokens)
        .set({ revokedAt: now })
        .where(and(eq(schema.oauthTokens.grantId, id), isNull(schema.oauthTokens.revokedAt)))
    }

    await tx.insert(schema.oauthGrants).values({
      id: grantId,
      organizationId: input.organizationId,
      userId: input.user.id,
      clientId: client.id,
      clientName: client.clientName,
      resource,
      scopes,
      createdAt: now,
    })

    await writeAuditEntry(tx, {
      organizationId: input.organizationId,
      actor,
      requestId: newId(),
      ipAddress: input.context?.ipAddress,
      userAgent: input.context?.userAgent,
      source: 'web',
      entry: {
        action: 'oauth_grant.created',
        entityType: 'oauth_grant',
        entityId: grantId,
        entityLabel: client.clientName,
        changes: { scopes: { from: null, to: scopes ?? 'full access' }, redirectHost: { from: null, to: new URL(redirectUri).host } },
      },
    })
  })

  const code = randomBytes(32).toString('base64url')
  const stored: StoredCode = {
    grantId,
    organizationId: input.organizationId,
    userId: input.user.id,
    clientId: client.id,
    redirectUri,
    codeChallenge,
    resource,
  }
  await db.insert(schema.verification).values({
    id: newId(),
    identifier: codeIdentifier(code),
    value: JSON.stringify(stored),
    expiresAt: new Date(now.getTime() + CODE_SECONDS * 1000),
  })

  return authorizationRedirect(redirectUri, { code, state })
}
