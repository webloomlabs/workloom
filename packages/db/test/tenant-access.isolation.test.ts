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
 * a tenant table added in a later slice is probed automatically.
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
