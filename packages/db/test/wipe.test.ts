import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from './harness.ts'

/**
 * Wiping one organization's records (src/wipe.ts) and the guard triggers'
 * single exception for it (migration 0048).
 *
 * The guards must stand aside for a wipe of the organization the transaction
 * is scoped to, and for nothing else: not for another organization, not for a
 * transaction that merely names one. The full reset, with its password and
 * code, is tested in packages/auth/test/organization-reset.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let admin: pg.Client

const ORG_A = '01a0aa00-0000-7000-8000-0000000000aa'
const ORG_B = '01a0aa00-0000-7000-8000-0000000000bb'

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  admin = new pg.Client({ connectionString: database.adminUrl })
  await admin.connect()
  for (const [id, slug] of [[ORG_A, 'wipe-a'], [ORG_B, 'wipe-b']]) {
    await admin.query(`insert into organization (id, name, slug) values ($1, $2, $2)`, [id, slug])
  }
})

afterAll(async () => {
  await admin?.end()
  await mod?.closePool()
  await database?.stop()
})

const failure = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => String((error as { cause?: Error }).cause?.message ?? error.message))

/** A sent quote, an issued invoice, and books locked over both: every guard that refuses a delete. */
async function guardedRecords(org: string): Promise<{ quote: string; invoice: string }> {
  const company = crypto.randomUUID()
  const quote = crypto.randomUUID()
  const invoice = crypto.randomUUID()
  // Open the books while issuing; they are locked over it again below.
  await admin.query(`update organization set books_locked_through = null where id = $1`, [org])
  await admin.query(`insert into companies (id, organization_id, name) values ($1, $2, 'Client')`, [company, org])
  await admin.query(
    `insert into quotes (id, organization_id, company_id, title, currency, valid_until) values ($1, $2, $3, 'Q', 'AUD', '2030-01-01')`,
    [quote, org, company],
  )
  await admin.query(
    `insert into quote_lines (id, organization_id, quote_id, position, description, quantity, unit_amount_minor, amount_minor, line_discount_minor, net_minor, document_discount_minor, tax_minor, total_minor)
     values ($1, $2, $3, 1, 'Design', 1, 100, 100, 0, 100, 0, 0, 100)`,
    [crypto.randomUUID(), org, quote],
  )
  await admin.query(
    `update quotes set status = 'sent', number = $2, issue_date = '2026-08-01', sent_at = now(), base_currency = 'AUD', exchange_rate_to_base = 1, total_base_minor = 100, subtotal_minor = 100, total_minor = 100 where id = $1`,
    [quote, `Q-${quote.slice(0, 8)}`],
  )
  await admin.query(`insert into invoices (id, organization_id, company_id, title, currency) values ($1, $2, $3, 'I', 'AUD')`, [invoice, org, company])
  await admin.query(
    `insert into invoice_lines (id, organization_id, invoice_id, position, description, quantity, unit_amount_minor, amount_minor, line_discount_minor, net_minor, document_discount_minor, tax_minor, total_minor)
     values ($1, $2, $3, 1, 'Design', 1, 100, 100, 0, 100, 0, 0, 100)`,
    [crypto.randomUUID(), org, invoice],
  )
  await admin.query(
    `update invoices set status = 'sent', number = $2, issue_date = '2026-09-16', due_date = '2026-09-30', sent_at = now(),
       base_currency = 'AUD', exchange_rate_to_base = 1, total_base_minor = 100, subtotal_minor = 100, total_minor = 100 where id = $1`,
    [invoice, `INV-${invoice.slice(0, 8)}`],
  )
  await admin.query(`update organization set books_locked_through = '2026-09-30' where id = $1`, [org])
  await admin.query(
    `insert into audit_logs (id, organization_id, actor_type, action, entity_type, source) values ($1, $2, 'system', 'test.seeded', 'test', 'system')`,
    [crypto.randomUUID(), org],
  )
  return { quote, invoice }
}

/** Rows per tenant table for one organization, read as the superuser so RLS hides nothing. */
async function counts(org: string): Promise<Record<string, number>> {
  const { rows } = await admin.query<{ table: string }>(`
    select c.relname as table from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
    where c.relkind = 'r' and n.nspname = 'public' and c.relrowsecurity`)
  const result: Record<string, number> = {}
  for (const { table } of rows) {
    const { rows: n } = await admin.query<{ n: string }>(`select count(*) as n from "${table}" where organization_id = $1`, [org])
    result[table] = Number(n[0]!.n)
  }
  return result
}

describe('the wipe exception in the guard triggers', () => {
  it('is on every trigger', async () => {
    const { rows } = await admin.query<{ name: string; def: string }>(`
      select tg.tgname as name, pg_get_triggerdef(tg.oid) as def
      from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where not tg.tgisinternal and n.nspname = 'public'`)
    expect(rows.length).toBeGreaterThan(20)
    // A trigger added without it would make a reset fail on its rows -- or,
    // worse, fire half-way through one. Add `WHEN (NOT workloom_wiping())`.
    expect(rows.filter((r) => !r.def.includes('NOT workloom_wiping()')).map((r) => r.name)).toEqual([])
  })

  it('holds only when the transaction is scoped to the organization it names', async () => {
    const wiping = (scope: string | null, wipe: string | null) =>
      mod.withoutTenant('test: wiping()', async (db) =>
        db.transaction(async (tx) => {
          if (scope) await tx.execute(mod.sql`select set_config('workloom.org_id', ${scope}, true)`)
          if (wipe) await tx.execute(mod.sql`select set_config('workloom.wipe_org', ${wipe}, true)`)
          const { rows } = await tx.execute<{ on: boolean }>(mod.sql`select workloom_wiping() as on`)
          return rows[0]!.on
        }),
      )
    expect(await wiping(null, null)).toBe(false)
    expect(await wiping(ORG_A, null)).toBe(false)
    expect(await wiping(null, ORG_A)).toBe(false)
    expect(await wiping(ORG_B, ORG_A)).toBe(false)
    expect(await wiping(ORG_A, ORG_A)).toBe(true)
  })

  it('does not let one organization name another to get past its guards', async () => {
    const { invoice } = await guardedRecords(ORG_B)
    const attempt = mod.withTenant(ORG_B, async (tx) => {
      await tx.execute(mod.sql`select set_config('workloom.wipe_org', ${ORG_A}, true)`)
      await tx.execute(mod.sql`delete from invoices where id = ${invoice}::uuid`)
    })
    expect(await failure(attempt)).toMatch(/never deleted|books_locked/)
  })
})

describe('wipeTenantData', () => {
  it('removes every record of one organization, guarded ones included, and nothing of another', async () => {
    await guardedRecords(ORG_A)
    await guardedRecords(ORG_B)
    const otherBefore = await counts(ORG_B)
    const auditBefore = (await counts(ORG_A)).audit_logs!

    const deleted = await mod.withTenant(ORG_A, (tx) => mod.wipeTenantData(tx, ORG_A))
    expect(deleted.quotes).toBe(1)
    expect(deleted.invoices).toBe(1)
    expect(deleted).not.toHaveProperty('audit_logs')

    const after = await counts(ORG_A)
    const left = Object.entries(after).filter(([table, n]) => n > 0 && !mod.KEPT_ON_WIPE.includes(table as never))
    expect(left).toEqual([])
    expect(after.audit_logs).toBe(auditBefore)
    expect(await counts(ORG_B)).toEqual(otherBefore)
  })

  it('stands the guards back up before returning, within the same transaction', async () => {
    await guardedRecords(ORG_A)
    const stillWiping = await mod.withTenant(ORG_A, async (tx) => {
      await mod.wipeTenantData(tx, ORG_A)
      const { rows } = await tx.execute<{ on: boolean }>(mod.sql`select workloom_wiping() as on`)
      return rows[0]!.on
    })
    expect(stillWiping).toBe(false)

    // And an ordinary transaction afterwards meets them as before.
    const { invoice } = await guardedRecords(ORG_A)
    const attempt = mod.withTenant(ORG_A, (tx) => tx.execute(mod.sql`delete from invoices where id = ${invoice}::uuid`))
    expect(await failure(attempt)).toMatch(/never deleted|books_locked/)
  })

  it('refuses a transaction scoped to a different organization', async () => {
    expect(await failure(mod.withTenant(ORG_B, (tx) => mod.wipeTenantData(tx, ORG_A)))).toMatch(/scoped to/)
  })
})

describe('deletionOrder', () => {
  it('puts every table after the tables that reference it', () => {
    const order = mod.deletionOrder(
      ['companies', 'invoices', 'invoice_lines', 'projects'],
      [
        { child: 'invoice_lines', parent: 'invoices' },
        { child: 'invoices', parent: 'companies' },
        { child: 'invoices', parent: 'projects' },
        { child: 'projects', parent: 'companies' },
        { child: 'tasks', parent: 'tasks' },
        { child: 'invoices', parent: 'organization' },
      ],
    )
    expect(order.indexOf('invoice_lines')).toBeLessThan(order.indexOf('invoices'))
    expect(order.indexOf('invoices')).toBeLessThan(order.indexOf('projects'))
    expect(order.indexOf('projects')).toBeLessThan(order.indexOf('companies'))
    expect(order).toHaveLength(4)
  })

  it('names the tables when there is no order', () => {
    expect(() =>
      mod.deletionOrder(['a', 'b', 'c'], [{ child: 'a', parent: 'b' }, { child: 'b', parent: 'a' }]),
    ).toThrow(/cycle.*a, b/)
  })
})
