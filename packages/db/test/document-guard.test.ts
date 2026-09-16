import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from './harness.ts'

/**
 * The guard triggers on issued documents, at the database level: quotes from
 * migration 0012, invoices from 0014.
 *
 * The application's own refusals are tested in packages/core/test/finance.test.ts
 * and invoices.test.ts. These check the edges only SQL reaches: the guards bind
 * even a superuser, and still let a whole organization be removed.
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

async function issuedInvoice(org: string): Promise<{ invoice: string; line: string }> {
  const company = crypto.randomUUID()
  const invoice = crypto.randomUUID()
  const line = crypto.randomUUID()
  await admin.query(`insert into companies (id, organization_id, name) values ($1, $2, 'Client')`, [company, org])
  await admin.query(`insert into invoices (id, organization_id, company_id, title, currency) values ($1, $2, $3, 'I', 'AUD')`, [invoice, org, company])
  await admin.query(
    `insert into invoice_lines (id, organization_id, invoice_id, position, description, quantity, unit_amount_minor, amount_minor, line_discount_minor, net_minor, document_discount_minor, tax_minor, total_minor)
     values ($1, $2, $3, 1, 'Design', 1, 100, 100, 0, 100, 0, 0, 100)`,
    [line, org, invoice],
  )
  await admin.query(
    `update invoices set status = 'sent', number = $2, issue_date = '2026-09-16', due_date = '2026-09-30', sent_at = now(),
       base_currency = 'AUD', exchange_rate_to_base = 1, total_base_minor = 100, subtotal_minor = 100, total_minor = 100 where id = $1`,
    [invoice, `INV-${invoice.slice(0, 8)}`],
  )
  return { invoice, line }
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

  it('binds issued invoices too, and still records what the client does', async () => {
    const { invoice, line } = await issuedInvoice(ORG)
    expect(await failure(admin.query(`update invoices set total_minor = 1 where id = $1`, [invoice]))).toMatch(/can no longer change/)
    expect(await failure(admin.query(`update invoices set status = 'draft', number = null where id = $1`, [invoice]))).toMatch(/can no longer change/)
    expect(await failure(admin.query(`delete from invoices where id = $1`, [invoice]))).toMatch(/never deleted/)
    expect(await failure(admin.query(`update invoice_lines set quantity = 2 where id = $1`, [line]))).toMatch(/only while the invoice is a draft/)
    expect(
      await failure(
        admin.query(
          `insert into invoice_lines (id, organization_id, invoice_id, position, description, quantity, unit_amount_minor, amount_minor, line_discount_minor, net_minor, document_discount_minor, tax_minor, total_minor)
           values ($1, $2, $3, 2, 'sneaked in', 1, 1, 1, 0, 1, 0, 0, 1)`,
          [crypto.randomUUID(), ORG, invoice],
        ),
      ),
    ).toMatch(/only while the invoice is a draft/)

    // What happens to an issued invoice is still recorded: opened, paid, cancelled.
    await admin.query(`update invoices set status = 'viewed', viewed_at = now() where id = $1`, [invoice])
    await admin.query(`update invoices set amount_paid_minor = 100, status = 'paid', paid_at = now() where id = $1`, [invoice])
    const { rows } = await admin.query(`select status from invoices where id = $1`, [invoice])
    expect(rows[0].status).toBe('paid')
  })

  it('lets a whole organization go, sent quotes and all', async () => {
    const org = crypto.randomUUID()
    await admin.query(`insert into organization (id, name, slug) values ($1, 'Leaving', $2)`, [org, `leaving-${org.slice(0, 8)}`])
    const quote = await sentQuote(org)
    await issuedInvoice(org)
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
