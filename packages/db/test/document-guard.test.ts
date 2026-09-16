import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from './harness.ts'

/**
 * The quote guard triggers from migration 0012, at the database level.
 *
 * The application's own refusals are tested in packages/core/test/finance.test.ts.
 * These check the edges only SQL reaches: the guard binds even a superuser, and
 * still lets a whole organization be removed.
 */

let database: TestDatabase
let admin: pg.Client

const ORG = '01a0a900-0000-7000-8000-00000000000a'

beforeAll(async () => {
  database = await startTestDatabase()
  const mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  await mod.closePool()
  admin = new pg.Client({ connectionString: database.adminUrl })
  await admin.connect()
})

afterAll(async () => {
  await admin?.end()
  await database?.stop()
})

async function sentQuote(org: string): Promise<string> {
  const company = crypto.randomUUID()
  const quote = crypto.randomUUID()
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
    `update quotes set status = 'sent', number = $2, issue_date = '2029-12-01', sent_at = now(), base_currency = 'AUD', exchange_rate_to_base = 1, total_base_minor = 100, subtotal_minor = 100, total_minor = 100 where id = $1`,
    [quote, `Q-${quote.slice(0, 8)}`],
  )
  return quote
}

const failure = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message)

describe('the quote guard', () => {
  beforeAll(async () => {
    await admin.query(`insert into organization (id, name, slug) values ($1, 'Guarded', 'guarded')`, [ORG])
  })

  it('binds a superuser too', async () => {
    const quote = await sentQuote(ORG)
    expect(await failure(admin.query(`update quotes set title = 'rewritten' where id = $1`, [quote]))).toMatch(/can no longer change/)
    expect(await failure(admin.query(`delete from quotes where id = $1`, [quote]))).toMatch(/never deleted/)
    expect(await failure(admin.query(`update quote_lines set quantity = 2 where quote_id = $1`, [quote]))).toMatch(/only while the quote is a draft/)
  })

  it('lets a whole organization go, sent quotes and all', async () => {
    const org = crypto.randomUUID()
    await admin.query(`insert into organization (id, name, slug) values ($1, 'Leaving', $2)`, [org, `leaving-${org.slice(0, 8)}`])
    const quote = await sentQuote(org)
    // Cascades run with the table owner's rights, and the application role may
    // never delete audit entries -- so today no one can remove an organization
    // (see S7a notes). Granting that one right here isolates what this test is
    // about: the quote guard itself does not stand in the way.
    await admin.query('grant delete on audit_logs to workloom_app_test')
    try {
      await admin.query(`delete from organization where id = $1`, [org])
    } finally {
      await admin.query('revoke delete on audit_logs from workloom_app_test')
    }
    const { rowCount } = await admin.query(`select 1 from quotes where id = $1`, [quote])
    expect(rowCount).toBe(0)
  })
})
