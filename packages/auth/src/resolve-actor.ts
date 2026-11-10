import { isPermission, permissionsForRole, type Permission } from '@workloom/core'
import { db, eq, schema, sql, withTenant } from '@workloom/db'
import type { Actor } from '@workloom/core'
import { auth } from './auth.ts'
import { verifyApiKey } from './api-keys.ts'
import { findMemberRole } from './membership-role.ts'
import { ACCESS_TOKEN_PREFIX } from './oauth/config.ts'
import { touchGrant, verifyOAuthAccessToken } from './oauth/tokens.ts'

/**
 * Turns a request into an identity, an organization, and a permission set.
 *
 * This is the single point where cookie sessions and API keys converge. Every
 * transport calls it; nothing downstream needs to know which was used.
 *
 * It is also the only place membership is enforced. The auth tables are not
 * under row-level security -- they cannot be, since "which organizations does
 * this user belong to?" must be answerable before an organization is known --
 * so this function is the boundary that RLS cannot draw, and it carries its
 * own tests for that reason.
 */

export type Resolution =
  | { ok: true; organizationId: string; actor: Actor; role: string; permissions: Set<Permission> }
  | { ok: false; reason: 'unauthenticated' | 'no-organization' | 'not-a-member' | 'invalid-key' }

export type ResolveOptions = {
  headers: Headers
  /** Overrides the session's active organization, for explicit org scoping. */
  organizationId?: string | undefined
  /**
   * Which endpoint is asking. OAuth access tokens are issued for the MCP
   * endpoint alone (RFC 8707), so only `'mcp'` accepts them; the REST API
   * takes API keys and sessions. Defaults to `'api'`.
   */
  audience?: 'api' | 'mcp' | undefined
}

export async function resolveActor(options: ResolveOptions): Promise<Resolution> {
  const authorization = options.headers.get('authorization')

  if (authorization?.startsWith('Bearer ')) {
    const secret = authorization.slice('Bearer '.length).trim()
    if (secret.startsWith(ACCESS_TOKEN_PREFIX)) {
      return options.audience === 'mcp' ? resolveFromOAuthToken(secret) : { ok: false, reason: 'invalid-key' }
    }
    return resolveFromApiKey(secret)
  }
  return resolveFromSession(options)
}

async function resolveFromSession(options: ResolveOptions): Promise<Resolution> {
  const session = await auth.api.getSession({ headers: options.headers })
  if (!session) return { ok: false, reason: 'unauthenticated' }

  const organizationId = options.organizationId ?? session.session.activeOrganizationId
  if (!organizationId) return { ok: false, reason: 'no-organization' }

  const role = await findMemberRole(session.user.id, organizationId)
  if (!role) return { ok: false, reason: 'not-a-member' }

  return {
    ok: true,
    organizationId,
    actor: {
      type: 'user',
      id: session.user.id,
      label: session.user.name || session.user.email,
    },
    role,
    permissions: new Set(permissionsForRole(role)),
  }
}

/**
 * An AI assistant connected through OAuth. Exactly an API key's rules: the
 * person's current role, narrowed by the scopes they chose at consent.
 *
 * The actor is an `apiKey` actor marked `credential: 'oauth'`, so everything
 * that attributes an API key's work to its owner does the same here.
 */
async function resolveFromOAuthToken(secret: string): Promise<Resolution> {
  const token = await verifyOAuthAccessToken(secret)
  if (!token) return { ok: false, reason: 'invalid-key' }

  const role = await findMemberRole(token.userId, token.organizationId)
  if (!role) return { ok: false, reason: 'not-a-member' }

  const [owner] = await db
    .select({ name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, token.userId))
    .limit(1)

  const ownerPermissions = permissionsForRole(role)
  const permissions =
    token.scopes === null
      ? new Set(ownerPermissions)
      : new Set(token.scopes.filter((s): s is Permission => isPermission(s) && ownerPermissions.has(s)))

  await touchGrant(token)

  return {
    ok: true,
    organizationId: token.organizationId,
    actor: {
      type: 'apiKey',
      id: token.grantId,
      userId: token.userId,
      label: `${token.clientName} (${owner?.name || owner?.email || 'unknown owner'})`,
      credential: 'oauth',
    },
    role,
    permissions,
  }
}

async function resolveFromApiKey(secret: string): Promise<Resolution> {
  const key = await verifyApiKey(secret)
  if (!key) return { ok: false, reason: 'invalid-key' }

  // The owner's CURRENT role, not the role they held when the key was issued.
  const role = await findMemberRole(key.userId, key.organizationId)
  if (!role) return { ok: false, reason: 'not-a-member' }

  const [owner] = await db
    .select({ name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, key.userId))
    .limit(1)

  /**
   * The intersection is the point.
   *
   * A key can never exceed what its owner may do, re-evaluated per request.
   * Demote someone from Finance and every key they issued loses finance
   * access immediately -- no re-issuance, no revocation sweep, no stale grant
   * sitting in a scopes column. Scopes only ever narrow.
   */
  const ownerPermissions = permissionsForRole(role)
  const permissions =
    key.scopes === null
      ? new Set(ownerPermissions)
      : new Set(key.scopes.filter((s): s is Permission => isPermission(s) && ownerPermissions.has(s)))

  await touchLastUsed(key.id, key.organizationId)

  return {
    ok: true,
    organizationId: key.organizationId,
    actor: {
      type: 'apiKey',
      id: key.id,
      userId: key.userId,
      label: `API key (${owner?.name || owner?.email || 'unknown owner'})`,
    },
    role,
    permissions,
  }
}

/**
 * Best-effort. A failure here must never fail the request it is describing --
 * it is an activity timestamp, not part of authorisation.
 */
async function touchLastUsed(keyId: string, organizationId: string): Promise<void> {
  try {
    // Must run inside a tenant transaction: api_keys is under row-level
    // security, so an update on the unscoped handle silently matches no rows.
    await withTenant(organizationId, async (tx) => {
      await tx.execute(sql`update api_keys set last_used_at = now() where id = ${keyId}::uuid`)
    })
  } catch {
    // Deliberately ignored.
  }
}
