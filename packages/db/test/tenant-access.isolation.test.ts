import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from './harness.ts'
import { captureError } from './errors.ts'

/**
 * Cross-tenant access probes.
 *
 * The schema assertions in schema.isolation.test.ts check that policies are
 * declared. These check that they actually work -- that org B cannot read,
 * modify, delete, or forge rows belonging to org A.
 *
 * The table list is derived from the live database rather than hard-coded, so
 * a tenant table added in a later slice is probed automatically. Views are
 * probed the same way: a view is where isolation is most easily lost, and a
 * `security_invoker` reloption is a declaration, not a proof that no rows come
 * back.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>

const ORG_A = '01a08800-0000-7000-8000-00000000000a'
const ORG_B = '01a08800-0000-7000-8000-00000000000b'

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()

  // Organizations are not themselves tenant-scoped, so they are seeded
  // outside a tenant transaction.
  await mod.withoutTenant('test setup: seed two organizations', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone)
      values (${ORG_A}::uuid, 'Org A', 'org-a', 'AUD', 'UTC'),
             (${ORG_B}::uuid, 'Org B', 'org-b', 'USD', 'UTC')
      on conflict do nothing
    `)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

/** Tenant tables, discovered from the database rather than listed by hand. */
async function tenantTables(): Promise<string[]> {
  const { rows } = await mod.withoutTenant('test: enumerate tenant tables', async (db) =>
    db.execute<{ table: string }>(sql`
      select c.relname as table
      from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id'
          and a.attnum > 0 and not a.attisdropped
      where c.relkind = 'r' and n.nspname = 'public'
        and c.relname not in ('member', 'invitation')
      order by c.relname
    `),
  )
  return rows.map((r) => r.table)
}

describe('tenant tables', () => {
  it('exist, so the checks below are not vacuous', async () => {
    // Guards against the whole suite passing because a migration silently
    // failed and there is simply nothing to protect.
    const tables = await tenantTables()
    expect(tables).toEqual(
      expect.arrayContaining([
        'api_keys',
        'audit_logs',
        'events',
        'webhook_endpoints',
        'webhook_deliveries',
        'idempotency_keys',
        'companies',
        'contacts',
        'leads',
        'deals',
        'activities',
        'projects',
        'project_members',
        'milestones',
        'tasks',
        'task_dependencies',
        'comments',
        'attachments',
        'time_entries',
        'default_rates',
        'document_sequences',
        'tax_rates',
        'services',
        'quotes',
        'quote_lines',
        'invoices',
        'invoice_lines',
      ]),
    )
  })
})

describe('cross-tenant access', () => {
  it('hides org A rows from org B', async () => {
    const id = '01a08801-0000-7000-8000-000000000001'
    await mod.withTenant(ORG_A, async (tx) => {
      await tx.execute(sql`
        insert into audit_logs (id, organization_id, actor_type, action, entity_type)
        values (${id}::uuid, ${ORG_A}::uuid, 'system', 'test.created', 'test')
      `)
    })

    const seenByA = await mod.withTenant(ORG_A, async (tx) =>
      tx.execute(sql`select id from audit_logs where id = ${id}::uuid`),
    )
    expect(seenByA.rows).toHaveLength(1)

    const seenByB = await mod.withTenant(ORG_B, async (tx) =>
      tx.execute(sql`select id from audit_logs where id = ${id}::uuid`),
    )
    expect(seenByB.rows).toHaveLength(0)
  })

  it('refuses to insert a row belonging to another organization', async () => {
    // WITH CHECK is what stops a caller inside org B's transaction from
    // writing a row stamped with org A's id.
    const message = await captureError(() =>
      mod.withTenant(ORG_B, async (tx) => {
        await tx.execute(sql`
          insert into audit_logs (id, organization_id, actor_type, action, entity_type)
          values (${'01a08801-0000-7000-8000-000000000002'}::uuid, ${ORG_A}::uuid,
                  'system', 'forged.created', 'test')
        `)
      }),
    )
    expect(message).toMatch(/row-level security/i)
  })

  it('sees nothing at all outside a tenant transaction', async () => {
    // The setting is unset, so the policy compares against NULL and no row
    // matches. A forgotten withTenant() yields emptiness, never another
    // organization's data.
    const { rows } = await mod.withoutTenant('test: query with no tenant scope', async (db) =>
      db.execute(sql`select id from audit_logs`),
    )
    expect(rows).toHaveLength(0)
  })

  it('scopes every discovered tenant table, not just the ones we remembered', async () => {
    for (const table of await tenantTables()) {
      const { rows } = await mod.withTenant(ORG_B, async (tx) =>
        tx.execute(sql`select count(*)::int as count from ${sql.identifier(table)}
                       where organization_id = ${ORG_A}::uuid`),
      )
      expect(rows[0], `${table} leaked rows from another organization`).toEqual({ count: 0 })
    }
  })
})

/** Views, discovered from the database, in the schema the application owns. */
async function tenantViews(): Promise<string[]> {
  const { rows } = await mod.withoutTenant('test: enumerate views', async (db) =>
    db.execute<{ view: string }>(sql`
      select c.relname as view
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'v' and n.nspname = 'public'
      order by c.relname
    `),
  )
  return rows.map((r) => r.view)
}

/** A project of org A's, with an hour of time against it, so a report has something to leak. */
async function seedProjectForA(): Promise<string> {
  const companyId = crypto.randomUUID()
  const projectId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  await mod.withoutTenant('test setup: a user to log the time', async (db) => {
    await db.execute(sql`insert into "user" (id, name, email) values (${userId}::uuid, 'A worker', ${`w-${userId.slice(0, 8)}@example.com`})`)
  })
  await mod.withTenant(ORG_A, async (tx) => {
    await tx.execute(sql`insert into companies (id, organization_id, name) values (${companyId}::uuid, ${ORG_A}::uuid, 'A client')`)
    await tx.execute(sql`
      insert into projects (id, organization_id, company_id, name, currency)
      values (${projectId}::uuid, ${ORG_A}::uuid, ${companyId}::uuid, 'A project', 'AUD')`)
    await tx.execute(sql`
      insert into time_entries (id, organization_id, user_id, project_id, spent_on, duration_seconds, billable, currency,
                                cost_rate_minor, cost_rate_source)
      values (${crypto.randomUUID()}::uuid, ${ORG_A}::uuid, ${userId}::uuid, ${projectId}::uuid, current_date, 3600, true, 'AUD',
              5000, 'organization')`)
  })
  return projectId
}

describe('cross-tenant access through views', () => {
  it('has views to probe, so the checks below are not vacuous', async () => {
    expect(await tenantViews()).toContain('project_financials_v')
  })

  it('shows org A nothing of its own that org B can also see', async () => {
    const projectId = await seedProjectForA()

    const seenByA = await mod.withTenant(ORG_A, async (tx) =>
      tx.execute(sql`select project_id from project_financials_v where project_id = ${projectId}::uuid`),
    )
    expect(seenByA.rows, 'org A cannot see its own project financials').toHaveLength(1)

    for (const view of await tenantViews()) {
      const { rows } = await mod.withTenant(ORG_B, async (tx) =>
        tx.execute(sql`select count(*)::int as count from ${sql.identifier(view)}
                       where organization_id = ${ORG_A}::uuid`),
      )
      expect(rows[0], `${view} leaked rows from another organization`).toEqual({ count: 0 })
    }
  })

  it('leaks without security_invoker when its owner outranks the caller', async () => {
    // Why the option matters, demonstrated rather than asserted.
    //
    // Isolation here is driven by a transaction-local setting, not by the
    // connected role, so a view owned by the *application* role still applies
    // the policy and shows nothing. The danger is a view created by a
    // privileged role -- which is exactly what happens when migrations run as
    // the database owner, the default on most hosting platforms. Such a view
    // runs with that role's privileges, row-level security does not apply to
    // it, and every tenant sees every other tenant.
    const projectId = await seedProjectForA()
    const pg = (await import('pg')).default
    const admin = new pg.Client({ connectionString: database.adminUrl })
    await admin.connect()
    try {
      // Over a base table, which is what a reporting view is written over. A
      // view over `project_financials_v` would not leak: that view carries the
      // option itself, and a nested view resolves it against the real session
      // role, not the outer view's owner.
      await admin.query('create view canary_leaky_v as select project_id, organization_id from time_entries')
      await admin.query('grant select on canary_leaky_v to workloom_app_test')

      const violations = await mod.findIsolationViolations()
      expect(violations.filter((v) => v.object === 'canary_leaky_v').map((v) => v.check)).toContain('view-security-invoker')

      const { rows } = await mod.withTenant(ORG_B, async (tx) =>
        tx.execute<{ count: number }>(sql`select count(*)::int as count from canary_leaky_v where project_id = ${projectId}::uuid`),
      )
      expect(rows[0]!.count, "org B read org A's rows -- which is the point: the check above is not decorative").toBe(1)

      // The same view with the option restores isolation, and nothing else changed.
      await admin.query('create or replace view canary_leaky_v with (security_invoker = true) as select project_id, organization_id from time_entries')
      const sealed = await mod.withTenant(ORG_B, async (tx) =>
        tx.execute<{ count: number }>(sql`select count(*)::int as count from canary_leaky_v where project_id = ${projectId}::uuid`),
      )
      expect(sealed.rows[0]!.count).toBe(0)
    } finally {
      await admin.query('drop view if exists canary_leaky_v')
      await admin.end()
    }
  })
})

describe('the audit log', () => {
  it('cannot be updated or deleted by the application', async () => {
    // An audit log the application can rewrite is not an audit log.
    const id = '01a08801-0000-7000-8000-000000000003'
    await mod.withTenant(ORG_A, async (tx) => {
      await tx.execute(sql`
        insert into audit_logs (id, organization_id, actor_type, action, entity_type)
        values (${id}::uuid, ${ORG_A}::uuid, 'system', 'test.created', 'test')
      `)
    })

    const onUpdate = await captureError(() =>
      mod.withTenant(ORG_A, async (tx) =>
        tx.execute(sql`update audit_logs set action = 'tampered' where id = ${id}::uuid`),
      ),
    )
    expect(onUpdate).toMatch(/permission denied/i)

    const onDelete = await captureError(() =>
      mod.withTenant(ORG_A, async (tx) =>
        tx.execute(sql`delete from audit_logs where id = ${id}::uuid`),
      ),
    )
    expect(onDelete).toMatch(/permission denied/i)
  })
})

describe('connection pooling', () => {
  it('does not leak tenant scope between interleaved requests', async () => {
    // The scope is transaction-local. A session-level SET would persist on the
    // pooled connection and leak into whichever request borrowed it next --
    // silent, intermittent, and cross-tenant. This is the regression test for
    // that specific mistake.
    await mod.withTenant(ORG_A, async (tx) => {
      await tx.execute(sql`
        insert into audit_logs (id, organization_id, actor_type, action, entity_type)
        select gen_random_uuid(), ${ORG_A}::uuid, 'system', 'pool.test', 'test'
        from generate_series(1, 5)
      `)
    })

    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const org = i % 2 === 0 ? ORG_A : ORG_B
        return mod
          .withTenant(org, async (tx) => {
            const { rows } = await tx.execute<{ org: string | null }>(
              sql`select distinct organization_id::text as org from audit_logs`,
            )
            return { requested: org, sawOnly: rows.map((r) => r.org) }
          })
      }),
    )

    for (const { requested, sawOnly } of results) {
      for (const seen of sawOnly) {
        expect(seen, 'a request saw another organization\'s rows').toBe(requested)
      }
    }
  })
})
