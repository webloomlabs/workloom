import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from './harness.ts'

/**
 * What an invoice has been paid, at the database level (migration 0016).
 *
 * `amount_paid_minor` is derived from the allocations against the invoice, and
 * the service never writes it. This file checks the rules that hold whatever
 * writes to the tables -- including a superuser with a hand-written UPDATE,
 * which is where a dispute over an invoice would actually be settled:
 *
 *   - the column always equals the sum of its allocations, refunds subtracting;
 *   - no invoice is allocated beyond its total, or refunded below nothing;
 *   - no payment is allocated beyond what was received;
 *   - a payment cannot straddle two currencies, by foreign key.
 *
 * The application's own refusals, with their messages, are in
 * packages/core/test/payments.test.ts.
 */

let database: TestDatabase
let admin: pg.Client

const ORG = '01a0ac00-0000-7000-8000-00000000000a'

beforeAll(async () => {
  database = await startTestDatabase()
  const mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  await mod.closePool()
  admin = new pg.Client({ connectionString: database.adminUrl })
  await admin.connect()
  await admin.query(`insert into organization (id, name, slug) values ($1, 'Ledger', 'ledger')`, [ORG])
})

afterAll(async () => {
  await admin?.end()
  await database?.stop()
})

const failure = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message)

async function client(org = ORG): Promise<string> {
  const id = crypto.randomUUID()
  await admin.query(`insert into companies (id, organization_id, name) values ($1, $2, 'Client')`, [id, org])
  return id
}

/** An issued invoice for `totalMinor`, written straight in. */
async function invoice(company: string, totalMinor: number, currency = 'AUD', org = ORG): Promise<string> {
  const id = crypto.randomUUID()
  await admin.query(`insert into invoices (id, organization_id, company_id, title, currency) values ($1, $2, $3, 'I', $4)`, [id, org, company, currency])
  await admin.query(
    `insert into invoice_lines (id, organization_id, invoice_id, position, description, quantity, unit_amount_minor, amount_minor, line_discount_minor, net_minor, document_discount_minor, tax_minor, total_minor)
     values ($1, $2, $3, 1, 'Design', 1, $4, $4, 0, $4, 0, 0, $4)`,
    [crypto.randomUUID(), org, id, totalMinor],
  )
  await admin.query(
    `update invoices set status = 'sent', number = $2, issue_date = '2026-09-16', due_date = '2026-09-30', sent_at = now(),
       base_currency = 'AUD', exchange_rate_to_base = 1, total_base_minor = $3, subtotal_minor = $3, total_minor = $3 where id = $1`,
    [id, `INV-${id.slice(0, 8)}`, totalMinor],
  )
  return id
}

async function payment(company: string, amountMinor: number, kind = 'payment', currency = 'AUD', org = ORG): Promise<string> {
  const id = crypto.randomUUID()
  await admin.query(
    `insert into payments (id, organization_id, company_id, kind, received_on, currency, amount_minor, base_currency, exchange_rate_to_base, amount_base_minor)
     values ($1, $2, $3, $4, '2026-09-16', $5, $6, 'AUD', 1, $6)`,
    [id, org, company, kind, currency, amountMinor],
  )
  return id
}

function allocate(org: string, paymentId: string, invoiceId: string, amountMinor: number, currency = 'AUD'): Promise<unknown> {
  return admin.query(
    `insert into payment_allocations (id, organization_id, payment_id, invoice_id, currency, amount_minor) values ($1, $2, $3, $4, $5, $6)`,
    [crypto.randomUUID(), org, paymentId, invoiceId, currency, amountMinor],
  )
}

const settled = async (id: string): Promise<{ paid: number; status: string }> => {
  const { rows } = await admin.query(`select amount_paid_minor::int as paid, status from invoices where id = $1`, [id])
  return rows[0]
}

describe('what an invoice has been paid', () => {
  it('follows its allocations, and cannot be set by hand', async () => {
    const company = await client()
    const target = await invoice(company, 1000)
    expect((await settled(target)).paid).toBe(0)

    await allocate(ORG, await payment(company, 400), target, 400)
    expect((await settled(target)).paid).toBe(400)

    // Even as a superuser, and even to a number the allocations would allow.
    expect(await failure(admin.query(`update invoices set amount_paid_minor = 1000 where id = $1`, [target]))).toMatch(
      /follows its payment allocations/,
    )
    expect(await failure(admin.query(`update invoices set amount_paid_minor = 400 + 0 where id = $1`, [target]))).toBe('')
    expect((await settled(target)).paid).toBe(400)
  })

  it('goes back down when an allocation is removed, and when its payment is deleted', async () => {
    const company = await client()
    const target = await invoice(company, 1000)
    const first = await payment(company, 600)
    await allocate(ORG, first, target, 600)
    await allocate(ORG, await payment(company, 400), target, 400)
    expect((await settled(target)).paid).toBe(1000)

    await admin.query(`delete from payment_allocations where payment_id = $1`, [first])
    expect((await settled(target)).paid).toBe(400)

    // Deleting the payment takes its allocations with it, and the invoice follows.
    await admin.query(`delete from payments where company_id = $1`, [company])
    expect((await settled(target)).paid).toBe(0)
  })

  it('subtracts a refund', async () => {
    const company = await client()
    const target = await invoice(company, 1000)
    await allocate(ORG, await payment(company, 1000), target, 1000)
    await allocate(ORG, await payment(company, 250, 'refund'), target, 250)
    expect((await settled(target)).paid).toBe(750)
  })
})

describe('what the ledger refuses', () => {
  it('refuses more against an invoice than it asks for', async () => {
    const company = await client()
    const target = await invoice(company, 1000)
    expect(await failure(allocate(ORG, await payment(company, 5000), target, 1001))).toMatch(/would be allocated 1001 against a total of 1000/)

    await allocate(ORG, await payment(company, 600), target, 600)
    expect(await failure(allocate(ORG, await payment(company, 600), target, 401))).toMatch(/would be allocated 1001 against a total of 1000/)
    expect((await settled(target)).paid).toBe(600)
  })

  it('refuses to refund an invoice below nothing', async () => {
    const company = await client()
    const target = await invoice(company, 1000)
    await allocate(ORG, await payment(company, 300), target, 300)
    expect(await failure(allocate(ORG, await payment(company, 900, 'refund'), target, 400))).toMatch(/refunded more than it was paid/)
    expect((await settled(target)).paid).toBe(300)
  })

  it('refuses more of a payment than was received', async () => {
    const company = await client()
    const one = await invoice(company, 1000)
    const two = await invoice(company, 1000)
    const received = await payment(company, 500)
    await allocate(ORG, received, one, 400)
    expect(await failure(allocate(ORG, received, two, 200))).toMatch(/would be allocated 600 of 500/)
    expect((await settled(two)).paid).toBe(0)
  })

  it('refuses a payment cut below what it is already allocated to', async () => {
    const company = await client()
    const target = await invoice(company, 1000)
    const received = await payment(company, 800)
    await allocate(ORG, received, target, 800)
    expect(await failure(admin.query(`update payments set amount_minor = 500 where id = $1`, [received]))).toMatch(/would be allocated 800 of 500/)
  })

  it('refuses a payment turned into a refund that the invoice cannot bear', async () => {
    const company = await client()
    const target = await invoice(company, 1000)
    const received = await payment(company, 800)
    await allocate(ORG, received, target, 800)
    expect(await failure(admin.query(`update payments set kind = 'refund' where id = $1`, [received]))).toMatch(/refunded more than it was paid/)
    expect((await settled(target)).paid).toBe(800)
  })

  it('refuses an allocation that straddles two currencies, by foreign key', async () => {
    // Not a trigger and not a service rule: the currency is part of the key to
    // both sides, so there is no such row to write. That is what keeps foreign
    // exchange gain and loss out of the MVP.
    const company = await client()
    const inYen = await invoice(company, 1000, 'JPY')
    const inDollars = await payment(company, 1000, 'payment', 'AUD')
    expect(await failure(allocate(ORG, inDollars, inYen, 1000, 'AUD'))).toMatch(/payment_allocations_invoice_fk/)
    expect(await failure(allocate(ORG, inDollars, inYen, 1000, 'JPY'))).toMatch(/payment_allocations_payment_fk/)
  })

  it('refuses the same payment against the same invoice twice', async () => {
    const company = await client()
    const target = await invoice(company, 1000)
    const received = await payment(company, 1000)
    await allocate(ORG, received, target, 400)
    expect(await failure(allocate(ORG, received, target, 400))).toMatch(/payment_allocations_payment_invoice_key/)
  })
})

describe('an organization leaving', () => {
  it('takes its payments, allocations, and expenses with it', async () => {
    const org = crypto.randomUUID()
    await admin.query(`insert into organization (id, name, slug) values ($1, 'Leaving', $2)`, [org, `pay-leaving-${org.slice(0, 8)}`])
    const company = await client(org)
    const target = await invoice(company, 1000, 'AUD', org)
    await allocate(org, await payment(company, 1000, 'payment', 'AUD', org), target, 1000)
    await admin.query(
      `insert into expenses (id, organization_id, company_id, description, incurred_on, currency, amount_minor, base_currency, exchange_rate_to_base, amount_base_minor)
       values ($1, $2, $3, 'Hosting', '2026-09-16', 'AUD', 100, 'AUD', 1, 100)`,
      [crypto.randomUUID(), org, company],
    )

    // As in document-guard.test.ts: the cascade needs a right the application
    // role is denied, and granting it here isolates what this test is about.
    await admin.query('grant delete on audit_logs to workloom_app_test')
    try {
      await admin.query(`delete from organization where id = $1`, [org])
    } finally {
      await admin.query('revoke delete on audit_logs from workloom_app_test')
    }
    const { rowCount } = await admin.query(`select 1 from payments where organization_id = $1`, [org])
    expect(rowCount).toBe(0)
  })
})
