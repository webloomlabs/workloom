import { isPermission, isRole, permissionsForRole, type Permission } from '@workloom/core'
import { and, db, eq, schema, sql, withTenant } from '@workloom/db'
import type { Actor } from '@workloom/core'
import { auth } from './auth.ts'
import { verifyApiKey } from './api-keys.ts'

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
}

export async function resolveActor(options: ResolveOptions): Promise<Resolution> {
  const authorization = options.headers.get('authorization')

  if (authorization?.startsWith('Bearer ')) {
    return resolveFromApiKey(authorization.slice('Bearer '.length).trim())
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

async function findMemberRole(userId: string, organizationId: string) {
  const [row] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, organizationId)))
    .limit(1)
  return isRole(row?.role) ? row.role : undefined
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
