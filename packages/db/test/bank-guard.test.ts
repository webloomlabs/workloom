import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from './harness.ts'

/**
 * What a bank account holds, and what explains a statement line, at the
 * database level (migration 0023).
 *
 * A reconciliation is a statement to an accountant that the books balanced on
 * a date. The rules that make it true are held here rather than in the service,
 * and this file checks them against a superuser with hand-written SQL -- which
 * is where someone tidying up a quarter would actually break them:
 *
 *   - an account's balance always equals its opening anchor plus every line;
 *   - a line is never explained by more than it is worth, or against its own
 *     direction;
 *   - a payment or an expense is never claimed by more bank movement than it
 *     was worth;
 *   - a match cannot straddle two currencies, by foreign key;
 *   - a reconciled line does not change, and does not go away.
 *
 * The application's own refusals, with their messages, are in
 * packages/core/test/banking.test.ts.
 */

let database: TestDatabase
let admin: pg.Client

const ORG = '01a0ac00-0000-7000-8000-00000000000b'

beforeAll(async () => {
  database = await startTestDatabase()
  const mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  await mod.closePool()
  admin = new pg.Client({ connectionString: database.adminUrl })
  await admin.connect()
  await admin.query(`insert into organization (id, name, slug) values ($1, 'Cash', 'cash')`, [ORG])
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

async function account(openingMinor = 0, currency = 'AUD', org = ORG): Promise<string> {
  const id = crypto.randomUUID()
  await admin.query(
    `insert into bank_accounts (id, organization_id, name, currency, opening_balance_minor, opening_balance_on, current_balance_minor)
     values ($1, $2, $3, $4, $5, '2026-09-01', $5)`,
    [id, org, `Account ${id.slice(0, 8)}`, currency, openingMinor],
  )
  return id
}

/** A statement line. `amountMinor` is signed: positive in, negative out. */
async function line(accountId: string, amountMinor: number, currency = 'AUD', org = ORG): Promise<string> {
  const id = crypto.randomUUID()
  await admin.query(
    `insert into bank_transactions (id, organization_id, bank_account_id, currency, amount_minor, booked_on, description, fingerprint)
     values ($1, $2, $3, $4, $5, '2026-09-16', 'TRANSFER', $6)`,
    [id, org, accountId, currency, amountMinor, `manual:${id}`],
  )
  return id
}

async function payment(company: string, amountMinor: number, currency = 'AUD', org = ORG): Promise<string> {
  const id = crypto.randomUUID()
  await admin.query(
    `insert into payments (id, organization_id, company_id, kind, received_on, currency, amount_minor, base_currency, exchange_rate_to_base, amount_base_minor)
     values ($1, $2, $3, 'payment', '2026-09-16', $4, $5, 'AUD', 1, $5)`,
    [id, org, company, currency, amountMinor],
  )
  return id
}

/** An expense costing `netMinor` plus `taxMinor`: what left the bank is the sum. */
async function expense(netMinor: number, taxMinor = 0, currency = 'AUD', org = ORG): Promise<string> {
  const id = crypto.randomUUID()
  await admin.query(
    `insert into expenses (id, organization_id, description, incurred_on, currency, amount_minor, tax_minor, base_currency, exchange_rate_to_base, amount_base_minor)
     values ($1, $2, 'Hosting', '2026-09-16', $3, $4, $5, 'AUD', 1, $4)`,
    [id, org, currency, netMinor, taxMinor],
  )
  return id
}

function match(
  org: string,
  transactionId: string,
  target: { kind: string; paymentId?: string; expenseId?: string; counterpartId?: string },
  amountMinor: number,
  currency = 'AUD',
): Promise<unknown> {
  return admin.query(
    `insert into bank_transaction_matches (id, organization_id, bank_transaction_id, currency, kind, payment_id, expense_id, counterpart_transaction_id, amount_minor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [crypto.randomUUID(), org, transactionId, currency, target.kind, target.paymentId ?? null, target.expenseId ?? null, target.counterpartId ?? null, amountMinor],
  )
}

const balance = async (id: string): Promise<number> => {
  const { rows } = await admin.query(`select current_balance_minor::int as balance from bank_accounts where id = $1`, [id])
  return rows[0].balance
}

const explained = async (id: string): Promise<number> => {
  const { rows } = await admin.query(`select matched_minor::int as matched from bank_transactions where id = $1`, [id])
  return rows[0].matched
}

describe('what an account holds', () => {
  it('follows its transactions, and cannot be set by hand', async () => {
    const acct = await account(10_000)
    expect(await balance(acct)).toBe(10_000)

    await line(acct, 2_500)
    expect(await balance(acct)).toBe(12_500)
    await line(acct, -400)
    expect(await balance(acct)).toBe(12_100)

    // Even as a superuser, and even to the number the transactions would give.
    expect(await failure(admin.query(`update bank_accounts set current_balance_minor = 99 where id = $1`, [acct]))).toMatch(
      /follows its transactions/,
    )
    expect(await failure(admin.query(`update bank_accounts set current_balance_minor = 12100 where id = $1`, [acct]))).toBe('')
    expect(await balance(acct)).toBe(12_100)
  })

  it('goes back down when a line is corrected or removed', async () => {
    const acct = await account(0)
    const first = await line(acct, 1_000)
    await line(acct, 500)
    expect(await balance(acct)).toBe(1_500)

    await admin.query(`update bank_transactions set amount_minor = 250 where id = $1`, [first])
    expect(await balance(acct)).toBe(750)

    await admin.query(`delete from bank_transactions where id = $1`, [first])
    expect(await balance(acct)).toBe(500)
  })

  it('refuses a currency change, and an opening balance moved under existing lines', async () => {
    const acct = await account(1_000)
    expect(await failure(admin.query(`update bank_accounts set opening_balance_minor = 2000 where id = $1`, [acct]))).toBe('')
    expect(await balance(acct)).toBe(1_000)

    await line(acct, 100)
    expect(await failure(admin.query(`update bank_accounts set currency = 'USD' where id = $1`, [acct]))).toMatch(
      /another currency is another account/,
    )
    expect(await failure(admin.query(`update bank_accounts set opening_balance_minor = 5000 where id = $1`, [acct]))).toMatch(
      /rewrites every reconciliation measured from it/,
    )
  })
})

describe('what explains a line', () => {
  it('follows its matches, and cannot be set by hand', async () => {
    const acct = await account()
    const company = await client()
    const deposit = await line(acct, 1_000)
    expect(await explained(deposit)).toBe(0)

    await match(ORG, deposit, { kind: 'payment', paymentId: await payment(company, 600) }, 600)
    expect(await explained(deposit)).toBe(600)

    expect(await failure(admin.query(`update bank_transactions set matched_minor = 1000 where id = $1`, [deposit]))).toMatch(
      /follows its matches/,
    )
    expect(await explained(deposit)).toBe(600)

    // A second payment finishes it, and removing one puts it back.
    await match(ORG, deposit, { kind: 'payment', paymentId: await payment(company, 400) }, 400)
    expect(await explained(deposit)).toBe(1_000)
    await admin.query(`delete from bank_transaction_matches where bank_transaction_id = $1 and amount_minor = 400`, [deposit])
    expect(await explained(deposit)).toBe(600)
  })

  it('refuses more than the line is worth', async () => {
    const acct = await account()
    const company = await client()
    const deposit = await line(acct, 1_000)
    expect(await failure(match(ORG, deposit, { kind: 'payment', paymentId: await payment(company, 5_000) }, 1_001))).toMatch(
      /would be explained by 1001 of 1000/,
    )

    await match(ORG, deposit, { kind: 'payment', paymentId: await payment(company, 600) }, 600)
    expect(await failure(match(ORG, deposit, { kind: 'payment', paymentId: await payment(company, 600) }, 401))).toMatch(
      /would be explained by 1001 of 1000/,
    )
    expect(await explained(deposit)).toBe(600)
  })

  it('refuses a match that runs against the line it explains', async () => {
    // Money came in. An expense did not pay for it.
    const acct = await account()
    const deposit = await line(acct, 1_000)
    expect(await failure(match(ORG, deposit, { kind: 'expense', expenseId: await expense(500) }, 500))).toMatch(
      /bank_transaction_matches_expense_sign_check/,
    )

    const withdrawal = await line(acct, -1_000)
    const company = await client()
    expect(await failure(match(ORG, withdrawal, { kind: 'payment', paymentId: await payment(company, 500) }, 500))).toMatch(
      /would be explained by 500 against a line of -1000/,
    )
  })

  it('refuses more bank movement against a payment than it was worth', async () => {
    const acct = await account()
    const company = await client()
    const received = await payment(company, 500)
    await match(ORG, await line(acct, 400), { kind: 'payment', paymentId: received }, 400)
    expect(await failure(match(ORG, await line(acct, 200), { kind: 'payment', paymentId: received }, 200))).toMatch(
      /would be matched to 600 of bank movement against 500/,
    )
  })

  it('measures an expense gross, because the tax left the bank too', async () => {
    const acct = await account()
    // 1,000 net plus 100 tax: 1,100 actually left the account.
    const cost = await expense(1_000, 100)
    expect(await failure(match(ORG, await line(acct, -1_100), { kind: 'expense', expenseId: cost }, -1_100))).toBe('')

    const second = await expense(1_000, 100)
    expect(await failure(match(ORG, await line(acct, -1_200), { kind: 'expense', expenseId: second }, -1_200))).toMatch(
      /would be matched to 1200 of bank movement against 1100/,
    )
  })

  it('refuses a payment cut below the bank movement already matched to it', async () => {
    const acct = await account()
    const company = await client()
    const received = await payment(company, 800)
    await match(ORG, await line(acct, 800), { kind: 'payment', paymentId: received }, 800)
    expect(await failure(admin.query(`update payments set amount_minor = 500 where id = $1`, [received]))).toMatch(
      /would be matched to 800 of bank movement against 500/,
    )
  })

  it('refuses a match that straddles two currencies, by foreign key', async () => {
    // Not a trigger and not a service rule: the currency is part of the key to
    // both sides, so there is no such row to write. A foreign payment landing
    // in a domestic account needs FX realisation, which is ledger work.
    const acct = await account(0, 'AUD')
    const company = await client()
    const deposit = await line(acct, 1_000, 'AUD')
    const inYen = await payment(company, 1_000, 'JPY')
    expect(await failure(match(ORG, deposit, { kind: 'payment', paymentId: inYen }, 1_000, 'AUD'))).toMatch(
      /bank_transaction_matches_payment_fk/,
    )
    expect(await failure(match(ORG, deposit, { kind: 'payment', paymentId: inYen }, 1_000, 'JPY'))).toMatch(
      /bank_transaction_matches_transaction_fk/,
    )
  })

  it('refuses the same line against the same payment twice', async () => {
    const acct = await account()
    const company = await client()
    const deposit = await line(acct, 1_000)
    const received = await payment(company, 1_000)
    await match(ORG, deposit, { kind: 'payment', paymentId: received }, 400)
    expect(await failure(match(ORG, deposit, { kind: 'payment', paymentId: received }, 400))).toMatch(
      /bank_transaction_matches_payment_key/,
    )
  })
})

describe('what the statement fixes', () => {
  /** Closes off one account at `closingMinor`, stamping every line in the period. */
  async function reconcile(accountId: string, closingMinor: number, org = ORG): Promise<string> {
    const id = crypto.randomUUID()
    const { rows } = await admin.query(
      `select count(*)::int as count from bank_transactions where bank_account_id = $1`,
      [accountId],
    )
    await admin.query(
      `insert into bank_reconciliations (id, organization_id, bank_account_id, currency, statement_start_on, statement_end_on,
         opening_balance_minor, closing_balance_minor, computed_balance_minor, transaction_count)
       values ($1, $2, $3, 'AUD', '2026-09-01', '2026-09-30', 0, $4, $4, $5)`,
      [id, org, accountId, closingMinor, rows[0].count],
    )
    await admin.query(
      `update bank_transactions set reconciliation_id = $1, reconciled_at = now(), status = 'reconciled' where bank_account_id = $2`,
      [id, accountId],
    )
    return id
  }

  it('refuses a reconciliation that does not balance', async () => {
    const acct = await account()
    await line(acct, 1_000)
    expect(
      await failure(
        admin.query(
          `insert into bank_reconciliations (id, organization_id, bank_account_id, currency, statement_start_on, statement_end_on,
             opening_balance_minor, closing_balance_minor, computed_balance_minor, transaction_count)
           values ($1, $2, $3, 'AUD', '2026-09-01', '2026-09-30', 0, 999, 1000, 1)`,
          [crypto.randomUUID(), ORG, acct],
        ),
      ),
    ).toMatch(/bank_reconciliations_balanced_check/)
  })

  it('freezes the lines it closed off', async () => {
    const acct = await account()
    const deposit = await line(acct, 1_000)
    await reconcile(acct, 1_000)

    expect(await failure(admin.query(`update bank_transactions set amount_minor = 900 where id = $1`, [deposit]))).toMatch(
      /has been reconciled and can no longer change/,
    )
    expect(await failure(admin.query(`update bank_transactions set description = 'TIDIED' where id = $1`, [deposit]))).toMatch(
      /has been reconciled and can no longer change/,
    )
    expect(await failure(admin.query(`delete from bank_transactions where id = $1`, [deposit]))).toMatch(
      /undo the reconciliation first/,
    )

    // A note about the line, and undoing the reconciliation itself, still work.
    expect(await failure(admin.query(`update bank_transactions set notes = 'Queried with the bank' where id = $1`, [deposit]))).toBe('')
    expect(
      await failure(
        admin.query(`update bank_transactions set reconciliation_id = null, reconciled_at = null, status = 'explained' where id = $1`, [deposit]),
      ),
    ).toBe('')
    expect(await failure(admin.query(`update bank_transactions set amount_minor = 900 where id = $1`, [deposit]))).toBe('')
  })

  it('refuses to delete a line that explains a payment', async () => {
    const acct = await account()
    const company = await client()
    const deposit = await line(acct, 1_000)
    await match(ORG, deposit, { kind: 'payment', paymentId: await payment(company, 1_000) }, 1_000)
    expect(await failure(admin.query(`delete from bank_transactions where id = $1`, [deposit]))).toMatch(
      /explains a payment or an expense: unmatch it first/,
    )
  })
})

describe('what stops a statement being imported twice', () => {
  it('refuses the same line in the same account, and allows it in another', async () => {
    const one = await account()
    const two = await account()
    const write = (acct: string, fingerprint: string) =>
      admin.query(
        `insert into bank_transactions (id, organization_id, bank_account_id, currency, amount_minor, booked_on, description, fingerprint)
         values ($1, $2, $3, 'AUD', 440, '2026-09-16', 'COFFEE', $4)`,
        [crypto.randomUUID(), ORG, acct, fingerprint],
      )

    await write(one, 'v1:h:abc')
    expect(await failure(write(one, 'v1:h:abc'))).toMatch(/bank_transactions_fingerprint_key/)
    // The same charge on another account is another charge.
    expect(await failure(write(two, 'v1:h:abc'))).toBe('')
    // Two identical charges on one day are both real, and carry different ordinals.
    expect(await failure(write(one, 'v1:h:abc#1'))).toBe('')
  })

  it('refuses the same file against the same account twice', async () => {
    const acct = await account()
    const write = () =>
      admin.query(
        `insert into bank_statement_imports (id, organization_id, bank_account_id, filename, byte_size, content_hash, format, row_count, imported_count, duplicate_count)
         values ($1, $2, $3, 'september.csv', 2048, 'sha256:abc', 'csv', 38, 38, 0)`,
        [crypto.randomUUID(), ORG, acct],
      )
    await write()
    expect(await failure(write())).toMatch(/bank_statement_imports_content_key/)
  })
})

describe('an organization leaving', () => {
  it('takes its accounts, lines, and matches with it', async () => {
    const org = crypto.randomUUID()
    await admin.query(`insert into organization (id, name, slug) values ($1, 'Leaving', $2)`, [org, `bank-leaving-${org.slice(0, 8)}`])
    const company = await client(org)
    const acct = await account(0, 'AUD', org)
    const deposit = await line(acct, 1_000, 'AUD', org)
    await match(org, deposit, { kind: 'payment', paymentId: await payment(company, 1_000, 'AUD', org) }, 1_000)

    // As in allocation-guard.test.ts: the cascade needs a right the application
    // role is denied, and granting it here isolates what this test is about.
    await admin.query('grant delete on audit_logs to workloom_app_test')
    try {
      await admin.query(`delete from organization where id = $1`, [org])
    } finally {
      await admin.query('revoke delete on audit_logs from workloom_app_test')
    }
    const { rowCount } = await admin.query(`select 1 from bank_accounts where organization_id = $1`, [org])
    expect(rowCount).toBe(0)
  })
})
