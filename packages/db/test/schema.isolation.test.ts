import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from './harness.ts'

/**
 * Tenant-isolation invariants.
 *
 * These assertions are introspective rather than enumerated, so they cover
 * tables that do not exist yet. At S0 the schema is empty and they pass
 * vacuously -- that is intended. Their value arrives with the first tenant
 * table: adding one without a row-level security policy fails this suite,
 * without anyone having to remember to update a list.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

describe('tenant isolation', () => {
  it('does not connect as a superuser', async () => {
    // A superuser bypasses row-level security unconditionally, which would
    // make every other assertion in this file meaningless.
    const violations = await mod.findIsolationViolations()
    expect(violations.filter((v) => v.check === 'not-superuser')).toEqual([])
  })

  it('has row-level security enabled and forced on every tenant table', async () => {
    const violations = await mod.findIsolationViolations()
    expect(violations.filter((v) => v.check === 'rls-enabled')).toEqual([])
  })

  it('has a policy covering all commands on every tenant table', async () => {
    const violations = await mod.findIsolationViolations()
    expect(violations.filter((v) => v.check === 'tenant-policy')).toEqual([])
  })

  it('indexes every tenant table by organization_id first', async () => {
    const violations = await mod.findIsolationViolations()
    expect(violations.filter((v) => v.check === 'tenant-index')).toEqual([])
  })

  it('defines every view with security_invoker', async () => {
    // Without it a view runs with its owner's privileges and silently
    // bypasses every tenant policy -- and a single-organization test would
    // still see entirely correct data.
    const violations = await mod.findIsolationViolations()
    expect(violations.filter((v) => v.check === 'view-security-invoker')).toEqual([])
  })

  it('reports no violations of any kind', async () => {
    expect(await mod.findIsolationViolations()).toEqual([])
  })
})

describe('the isolation harness itself', () => {
  it('detects a tenant table that is missing its policy', async () => {
    // Guards against the suite silently passing because the checks stopped
    // finding anything -- the failure mode that would make all of the above
    // worthless. Creates a table shaped like a tenant table, confirms it is
    // reported, then removes it.
    const { sql } = await import('drizzle-orm')
    await mod.db.execute(
      sql`create table canary_unprotected (id uuid primary key, organization_id uuid not null)`,
    )
    try {
      const violations = await mod.findIsolationViolations()
      const checks = violations.filter((v) => v.object === 'canary_unprotected').map((v) => v.check)
      expect(checks).toContain('rls-enabled')
      expect(checks).toContain('tenant-policy')
      expect(checks).toContain('tenant-index')
    } finally {
      await mod.db.execute(sql`drop table canary_unprotected`)
    }
  })
})

describe('the boot gate', () => {
  it('refuses a superuser connection', async () => {
    // The way an install ends up with no isolation is almost never a bad
    // policy -- it is a DATABASE_URL pointing at the superuser the hosting
    // platform handed over. Superusers bypass row-level security outright,
    // so the application must refuse to run as one.
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const pg = (await import('pg')).default
    const pool = new pg.Pool({ connectionString: database.adminUrl })
    try {
      const asSuperuser = drizzle(pool)
      const violations = await mod.findIsolationViolations(asSuperuser)
      expect(violations.map((v) => v.check)).toContain('not-superuser')

      await expect(mod.assertIsolationIntact(asSuperuser)).rejects.toThrow(mod.IsolationError)
    } finally {
      await pool.end()
    }
  })

  it('passes as the unprivileged application role', async () => {
    await expect(mod.assertIsolationIntact()).resolves.toBeUndefined()
  })
})
