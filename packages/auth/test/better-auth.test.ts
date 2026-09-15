import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Better Auth compatibility.
 *
 * This began as the spike the plan called for: confirm that Better Auth's
 * organization plugin fits a model where the organization IS the tenant
 * boundary, and that it tolerates `uuid` primary keys rather than its default
 * opaque strings. Getting that wrong is cheap to fix now and expensive after
 * six modules are built on it, so the checks stay as a regression suite.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let auth: typeof import('../src/auth.ts').auth

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  // Imported after the environment is in place: the connection pool and the
  // Better Auth instance are both built at module evaluation.
  ;({ auth } = await import('../src/auth.ts'))
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('sign-up', () => {
  it('creates a user whose id is a UUIDv7', async () => {
    const result = await auth.api.signUpEmail({
      body: {
        email: 'owner@example.com',
        password: 'a-sufficiently-long-password',
        name: 'Ann Owner',
      },
    })

    expect(result.user.id).toMatch(UUID)
    // Version nibble 7, not 4: ids must sort chronologically.
    expect(result.user.id[14]).toBe('7')
  })

  it('stores the id in a real uuid column, not text', async () => {
    // The point of the spike. If the adapter had forced text ids, this column
    // type would be `text` and foreign keys from domain tables would not work.
    const { rows } = await mod.withoutTenant('test: inspect column types', async (db) =>
      db.execute<{ data_type: string }>(sql`
        select data_type from information_schema.columns
        where table_name = 'user' and column_name = 'id'
      `),
    )
    expect(rows[0]?.data_type).toBe('uuid')
  })

  it('rejects a password below the minimum length', async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: 'short@example.com', password: 'tooshort', name: 'Short' },
      }),
    ).rejects.toThrow()
  })
})

describe('organizations', () => {
  it('creates one, and makes the creator its owner', async () => {
    const signUp = await auth.api.signUpEmail({
      body: {
        email: 'founder@example.com',
        password: 'a-sufficiently-long-password',
        name: 'Fay Founder',
      },
    })

    const headers = new Headers()
    const session = await auth.api.signInEmail({
      body: { email: 'founder@example.com', password: 'a-sufficiently-long-password' },
      returnHeaders: true,
    })
    const cookie = session.headers.get('set-cookie')
    expect(cookie).toBeTruthy()
    headers.set('cookie', cookie!.split(';')[0]!)

    const org = await auth.api.createOrganization({
      body: { name: 'Webloom Labs', slug: 'webloom-labs' },
      headers,
    })

    expect(org?.id).toMatch(UUID)

    const { rows } = await mod.withoutTenant('test: read membership', async (db) =>
      db.execute<{ role: string; user_id: string }>(sql`
        select role, user_id::text as user_id from member where organization_id = ${org!.id}::uuid
      `),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.role).toBe('owner')
    expect(rows[0]?.user_id).toBe(signUp.user.id)
  })

  it('carries Workloom settings on the organization row', async () => {
    // base_currency and timezone live here rather than in a side table: they
    // are read on nearly every request that formats money or ages an invoice.
    const { rows } = await mod.withoutTenant('test: read org settings', async (db) =>
      db.execute<{ base_currency: string; timezone: string }>(sql`
        select base_currency, timezone from organization where slug = 'webloom-labs'
      `),
    )
    expect(rows[0]).toEqual({ base_currency: 'AUD', timezone: 'UTC' })
  })
})
