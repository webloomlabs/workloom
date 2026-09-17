import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * These drive Better Auth's own sign-up and organization endpoints, which a
 * single-tenant installation closes. See provisioning.test.ts for the default
 * shape. Set before anything reads the environment: it is parsed once, on the
 * first access, and cached.
 */
process.env.MULTI_TENANT = 'true'

/**
 * API key authority.
 *
 * The central claim: a key can never do more than the person who owns it may
 * do *right now*. Scopes narrow that; they never widen it. These tests exist
 * because the alternative -- freezing permissions into the key at issue time --
 * is the design that leaves working credentials behind after someone changes
 * role or leaves, and it fails silently.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let authMod: typeof import('../src/index.ts')
let core: typeof import('@workloom/core')

let organizationId: string
let userId: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  authMod = await import('../src/index.ts')
  core = await import('@workloom/core')

  const signUp = await authMod.auth.api.signUpEmail({
    body: { email: 'fin@example.com', password: 'a-sufficiently-long-password', name: 'Fin' },
  })
  userId = signUp.user.id

  organizationId = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug) values (${organizationId}::uuid, 'Acme', 'acme')
    `)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role)
      values (${core.newId()}::uuid, ${organizationId}::uuid, ${userId}::uuid, 'finance')
    `)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

async function issueKey(
  scopes: string[] | null,
  overrides: { expiresAt?: Date; revokedAt?: Date } = {},
) {
  const generated = core.generateApiKey()
  const id = core.newId()
  await mod.withTenant(organizationId, async (tx) => {
    await tx.insert(mod.schema.apiKeys).values({
      id,
      organizationId,
      userId,
      name: 'test',
      keyHash: generated.hash,
      keyPrefix: generated.displayPrefix,
      scopes,
      expiresAt: overrides.expiresAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
    })
  })
  return { id, secret: generated.secret }
}

function headersFor(secret: string): Headers {
  return new Headers({ authorization: `Bearer ${secret}` })
}

async function setRole(role: string) {
  await mod.withoutTenant('test: change role', async (db) => {
    await db.execute(sql`
      update member set role = ${role}
      where organization_id = ${organizationId}::uuid and user_id = ${userId}::uuid
    `)
  })
}

describe('an unscoped key', () => {
  it('inherits exactly its owner\'s permissions', async () => {
    await setRole('finance')
    const key = await issueKey(null)
    const result = await authMod.resolveActor({ headers: headersFor(key.secret) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.permissions).toEqual(new Set(core.permissionsForRole('finance')))
    expect(result.actor.type).toBe('apiKey')
    expect(result.organizationId).toBe(organizationId)
  })
})

describe('scopes', () => {
  it('narrow what the key may do', async () => {
    await setRole('finance')
    const key = await issueKey(['invoice:read'])
    const result = await authMod.resolveActor({ headers: headersFor(key.secret) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.permissions]).toEqual(['invoice:read'])
  })

  it('cannot grant more than the owner has', async () => {
    // A finance user cannot update tasks, so a key claiming that scope must
    // not receive it. Scopes intersect; they never union.
    await setRole('finance')
    const key = await issueKey(['invoice:read', 'task:update'])
    const result = await authMod.resolveActor({ headers: headersFor(key.secret) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.permissions.has('task:update')).toBe(false)
    expect(result.permissions.has('invoice:read')).toBe(true)
  })

  it('silently drops scopes that are not real permissions', async () => {
    await setRole('finance')
    const key = await issueKey(['invoice:read', 'invoice:teleport'])
    const result = await authMod.resolveActor({ headers: headersFor(key.secret) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.permissions]).toEqual(['invoice:read'])
  })
})

describe('when the owner changes', () => {
  it('loses access as soon as they are demoted, with no re-issuance', async () => {
    // This is the property the whole design exists for.
    await setRole('finance')
    const key = await issueKey(null)

    const before = await authMod.resolveActor({ headers: headersFor(key.secret) })
    expect(before.ok && before.permissions.has('invoice:send')).toBe(true)

    await setRole('developer')

    const after = await authMod.resolveActor({ headers: headersFor(key.secret) })
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.permissions.has('invoice:send')).toBe(false)
    expect(after.permissions.has('invoice:read')).toBe(false)
  })

  it('stops working entirely once they are removed from the organization', async () => {
    await setRole('finance')
    const key = await issueKey(null)

    await mod.withoutTenant('test: remove membership', async (db) => {
      await db.execute(sql`
        delete from member
        where organization_id = ${organizationId}::uuid and user_id = ${userId}::uuid
      `)
    })

    const result = await authMod.resolveActor({ headers: headersFor(key.secret) })
    expect(result).toEqual({ ok: false, reason: 'not-a-member' })

    await mod.withoutTenant('test: restore membership', async (db) => {
      await db.execute(sql`
        insert into member (id, organization_id, user_id, role)
        values (${core.newId()}::uuid, ${organizationId}::uuid, ${userId}::uuid, 'finance')
      `)
    })
  })
})

describe('key lifecycle', () => {
  it('rejects a revoked key', async () => {
    const key = await issueKey(null, { revokedAt: new Date() })
    const result = await authMod.resolveActor({ headers: headersFor(key.secret) })
    expect(result).toEqual({ ok: false, reason: 'invalid-key' })
  })

  it('rejects an expired key', async () => {
    const key = await issueKey(null, { expiresAt: new Date(Date.now() - 1000) })
    const result = await authMod.resolveActor({ headers: headersFor(key.secret) })
    expect(result).toEqual({ ok: false, reason: 'invalid-key' })
  })

  it('rejects an unknown secret', async () => {
    const result = await authMod.resolveActor({
      headers: headersFor('wl_live_this-key-was-never-issued'),
    })
    expect(result).toEqual({ ok: false, reason: 'invalid-key' })
  })

  it('never stores the secret itself', async () => {
    const key = await issueKey(null)
    const { rows } = await mod.withTenant(organizationId, async (tx) =>
      tx.execute<{ key_hash: string; key_prefix: string }>(
        sql`select key_hash, key_prefix from api_keys where id = ${key.id}::uuid`,
      ),
    )
    expect(rows[0]?.key_hash).not.toContain(key.secret)
    expect(rows[0]?.key_hash).toMatch(/^[0-9a-f]{64}$/)
    // The prefix identifies a key in the UI without revealing enough to use it.
    expect(key.secret.startsWith(rows[0]!.key_prefix)).toBe(true)
    expect(rows[0]!.key_prefix.length).toBeLessThan(key.secret.length)
  })

  it('records when the key was last used', async () => {
    const key = await issueKey(null)
    await authMod.resolveActor({ headers: headersFor(key.secret) })

    const { rows } = await mod.withTenant(organizationId, async (tx) =>
      tx.execute<{ last_used_at: Date | null }>(
        sql`select last_used_at from api_keys where id = ${key.id}::uuid`,
      ),
    )
    expect(rows[0]?.last_used_at).not.toBeNull()
  })
})
