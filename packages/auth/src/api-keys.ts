import { API_KEY_PREFIX, hashApiKey } from '@workloom/core'
import { db, sql } from '@workloom/db'

/**
 * API key verification.
 *
 * Generation and hashing live in packages/core (core must not import auth);
 * this module owns only the database lookup, which needs the connection.
 */

export type ResolvedApiKey = {
  id: string
  organizationId: string
  userId: string
  /** Null means "everything the owning user may do". */
  scopes: string[] | null
}

/**
 * Looks up a presented secret.
 *
 * The one query that cannot know its organization in advance -- the
 * organization is precisely what it is trying to discover. It runs in a
 * transaction that sets `workloom.auth_lookup`, which the api_key_authentication
 * policy checks. The flag is transaction-local, set here and nowhere else, and
 * widens nothing except SELECT on this one table for the length of this
 * lookup. Ordinary access to api_keys remains tenant-scoped.
 */
export async function verifyApiKey(presented: string, now = new Date()) {
  if (!presented.startsWith(API_KEY_PREFIX)) return null

  const hash = hashApiKey(presented)
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('workloom.auth_lookup', 'on', true)`)
    // Note the string types. Drizzle's raw `execute` does not apply the
    // driver's type parsers, so timestamps arrive as strings. Comparing one
    // to a Date coerces the Date to its own string form and compares
    // lexicographically -- which silently accepts expired credentials. They
    // are parsed explicitly below.
    const result = await tx.execute<{
      id: string
      organization_id: string
      user_id: string
      scopes: string[] | null
      expires_at: string | null
      revoked_at: string | null
    }>(sql`
      select id, organization_id, user_id, scopes, expires_at, revoked_at
      from api_keys where key_hash = ${hash} limit 1
    `)
    return result.rows
  })

  const row = rows[0]
  if (!row) return null

  // No constant-time comparison is needed here: the lookup is an indexed
  // match on a SHA-256 digest, so no secret is compared byte by byte in
  // application code and there is no timing signal to leak.
  if (row.revoked_at !== null) return null

  if (row.expires_at !== null) {
    const expiresAt = new Date(row.expires_at)
    if (Number.isNaN(expiresAt.getTime())) return null
    if (expiresAt.getTime() <= now.getTime()) return null
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    scopes: row.scopes,
  } satisfies ResolvedApiKey
}
