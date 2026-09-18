import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from './harness.ts'

/**
 * A revision that has left draft, at the database level (migration 0027).
 *
 * A sent revision is what the client was offered, and an accepted one is what
 * they agreed to. Editing either afterwards rewrites history that a project's
 * contracted value is derived from, so the rule is held here rather than in the
 * service -- including against a superuser with hand-written SQL, which is
 * where someone tidying up a quarter would actually break it.
 *
 * The application's own refusals, with their messages, are in
 * packages/core/test/projects.test.ts.
 */

let database: TestDatabase
let admin: pg.Client

const ORG = '01a0ac00-0000-7000-8000-00000000000c'

beforeAll(async () => {
  database = await startTestDatabase()
  const mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  await mod.closePool()
  admin = new pg.Client({ connectionString: database.adminUrl })
  await admin.connect()
  await admin.query(`insert into organization (id, name, slug) values ($1, 'Scope', 'scope')`, [ORG])
})

afterAll(async () => {
  await admin?.end()
  await database?.stop()
})

const failure = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message)

async function project(currency = 'AUD', org = ORG): Promise<string> {
  const id = crypto.randomUUID()
  await admin.query(`insert into projects (id, organization_id, name, currency, contract_value_minor) values ($1, $2, 'Rebuild', $3, 1000000)`, [
    id,
    org,
    currency,
  ])
  return id
}

/** A revision in the given state, written straight in. */
async function revision(
  projectId: string,
  status = 'draft',
  options: { currency?: string; amountMinor?: number; org?: string; number?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID()
  const org = options.org ?? ORG
  const stamps: Record<string, string> = {
    sent: 'sent_at = now()',
    accepted: "sent_at = now(), accepted_at = now(), applied_at = now()",
    declined: 'sent_at = now(), declined_at = now()',
    withdrawn: 'sent_at = now(), withdrawn_at = now()',
  }
  await admin.query(
    `insert into project_revisions (id, organization_id, project_id, number, title, currency, amount_minor, requested_on)
     values ($1, $2, $3, $4, 'More scope', $5, $6, '2026-09-16')`,
    [id, org, projectId, options.number ?? 1, options.currency ?? 'AUD', options.amountMinor ?? 200000],
  )
  if (status !== 'draft') {
    await admin.query(`update project_revisions set status = $2, ${stamps[status]} where id = $1`, [id, status])
  }
  return id
}

describe('a revision that has left draft', () => {
  it('cannot have its content changed, however it is written', async () => {
    const p = await project()
    const sent = await revision(p, 'sent')

    expect(await failure(admin.query(`update project_revisions set amount_minor = 999999 where id = $1`, [sent]))).toMatch(
      /its content can no longer change/,
    )
    expect(await failure(admin.query(`update project_revisions set title = 'Tidied' where id = $1`, [sent]))).toMatch(
      /its content can no longer change/,
    )
    expect(await failure(admin.query(`update project_revisions set new_due_date = '2031-01-01' where id = $1`, [sent]))).toMatch(
      /its content can no longer change/,
    )
  })

  it('may still record the answer it was given', async () => {
    const p = await project()
    const sent = await revision(p, 'sent')
    expect(
      await failure(
        admin.query(`update project_revisions set status = 'declined', declined_at = now(), decline_reason = 'No' where id = $1`, [sent]),
      ),
    ).toBe('')

    const accepted = await revision(await project(), 'sent', { number: 1 })
    expect(
      await failure(
        admin.query(
          `update project_revisions set status = 'accepted', accepted_at = now(), applied_at = now(),
             previous_contract_value_minor = 1000000, previous_due_date = '2030-03-31' where id = $1`,
          [accepted],
        ),
      ),
    ).toBe('')
  })

  it('cannot go back to draft', async () => {
    const p = await project()
    const sent = await revision(p, 'sent')
    expect(await failure(admin.query(`update project_revisions set status = 'draft', sent_at = null where id = $1`, [sent]))).toMatch(
      /its content can no longer change/,
    )
  })

  it('cannot be deleted', async () => {
    const p = await project()
    for (const status of ['sent', 'accepted', 'declined', 'withdrawn']) {
      const id = await revision(p, status, { number: ['sent', 'accepted', 'declined', 'withdrawn'].indexOf(status) + 1 })
      expect(await failure(admin.query(`delete from project_revisions where id = $1`, [id]))).toMatch(/is never deleted/)
    }
    // A draft was never a statement to anyone, so it goes.
    const draft = await revision(p, 'draft', { number: 9 })
    expect(await failure(admin.query(`delete from project_revisions where id = $1`, [draft]))).toBe('')
  })
})

describe('what the shape of a revision refuses', () => {
  it('refuses a priced extension, and an undated one', async () => {
    const p = await project()
    const write = (kind: string, amount: number, dueDate: string | null) =>
      admin.query(
        `insert into project_revisions (id, organization_id, project_id, number, kind, title, currency, amount_minor, new_due_date, requested_on)
         values ($1, $2, $3, $4, $5, 'X', 'AUD', $6, $7, '2026-09-16')`,
        [crypto.randomUUID(), ORG, p, Math.floor(Math.random() * 100000), kind, amount, dueDate],
      )
    expect(await failure(write('extension', 100000, '2030-06-30'))).toMatch(/project_revisions_extension_check/)
    expect(await failure(write('extension', 0, null))).toMatch(/project_revisions_extension_date_check/)
    expect(await failure(write('extension', 0, '2030-06-30'))).toBe('')
    // A variation may be priced and undated: taking work out moves no date.
    expect(await failure(write('variation', -50000, null))).toBe('')
  })

  it('refuses a revision in a currency the project is not in, by foreign key', async () => {
    // Not a trigger and not a service rule: the currency is part of the key to
    // the project, so a revision can only ever be in its project's currency.
    const p = await project('AUD')
    expect(await failure(revision(p, 'draft', { currency: 'JPY' }))).toMatch(/project_revisions_project_fk/)
  })

  it('refuses two revisions with the same number on one project', async () => {
    const p = await project()
    await revision(p, 'draft', { number: 1 })
    expect(await failure(revision(p, 'draft', { number: 1 }))).toMatch(/project_revisions_project_number_key/)
    // The same number on another project is another project's revision 1.
    expect(await failure(revision(await project(), 'draft', { number: 1 }))).toBe('')
  })

  it('refuses an accepted revision that records no application, and the reverse', async () => {
    const p = await project()
    const id = await revision(p, 'sent')
    expect(await failure(admin.query(`update project_revisions set status = 'accepted', accepted_at = now() where id = $1`, [id]))).toMatch(
      /project_revisions_applied_check/,
    )
  })

  it('refuses a decline reason on anything that was not declined', async () => {
    const p = await project()
    const id = await revision(p, 'sent')
    expect(await failure(admin.query(`update project_revisions set decline_reason = 'No' where id = $1`, [id]))).toMatch(
      /project_revisions_decline_reason_check|its content can no longer change/,
    )
  })
})

describe('what the shape of a billing stage refuses', () => {
  /** A draft invoice for the project, written straight in. */
  async function invoice(projectId: string, org = ORG): Promise<string> {
    const id = crypto.randomUUID()
    const company = crypto.randomUUID()
    await admin.query(`insert into companies (id, organization_id, name) values ($1, $2, 'Client')`, [company, org])
    await admin.query(`insert into invoices (id, organization_id, company_id, project_id, title, currency) values ($1, $2, $3, $4, 'I', 'AUD')`, [
      id,
      org,
      company,
      projectId,
    ])
    return id
  }

  function stage(
    projectId: string,
    options: { position?: number; basis?: string; percent?: number | null; amount?: number | null; invoiceId?: string; org?: string } = {},
  ): Promise<unknown> {
    const invoiced = options.invoiceId !== undefined
    return admin.query(
      `insert into project_billing_stages
         (id, organization_id, project_id, position, name, basis, percent, amount_minor, currency, status, invoice_id, released_amount_minor, released_at)
       values ($1, $2, $3, $4, 'Advance', $5, $6, $7, 'AUD', $8, $9, $10, $11)`,
      [
        crypto.randomUUID(),
        options.org ?? ORG,
        projectId,
        options.position ?? Math.floor(Math.random() * 100000),
        options.basis ?? 'amount',
        options.percent ?? null,
        options.amount === undefined ? 100000 : options.amount,
        invoiced ? 'invoiced' : 'pending',
        options.invoiceId ?? null,
        invoiced ? 100000 : null,
        invoiced ? new Date() : null,
      ],
    )
  }

  it('refuses two stages pointing at one invoice', async () => {
    const p = await project()
    const i = await invoice(p)
    expect(await failure(stage(p, { invoiceId: i, position: 1 }))).toBe('')
    expect(await failure(stage(p, { invoiceId: i, position: 2 }))).toMatch(/project_billing_stages_invoice_key/)
  })

  it('refuses a half-released stage, in either direction', async () => {
    const p = await project()
    const i = await invoice(p)
    // An invoice with no amount and no timestamp.
    expect(
      await failure(
        admin.query(
          `insert into project_billing_stages (id, organization_id, project_id, position, name, basis, amount_minor, currency, status, invoice_id)
           values ($1, $2, $3, 1, 'A', 'amount', 100000, 'AUD', 'invoiced', $4)`,
          [crypto.randomUUID(), ORG, p, i],
        ),
      ),
    ).toMatch(/project_billing_stages_released_check/)
    // An amount with no invoice.
    expect(
      await failure(
        admin.query(
          `insert into project_billing_stages (id, organization_id, project_id, position, name, basis, amount_minor, currency, released_amount_minor)
           values ($1, $2, $3, 2, 'A', 'amount', 100000, 'AUD', 100000)`,
          [crypto.randomUUID(), ORG, p],
        ),
      ),
    ).toMatch(/project_billing_stages_released_check/)
  })

  it('refuses a stage that says it is worth two things, or nothing', async () => {
    const p = await project()
    expect(await failure(stage(p, { basis: 'percent', percent: 50, amount: 100000 }))).toMatch(/project_billing_stages_amount_check/)
    expect(await failure(stage(p, { basis: 'amount', amount: null }))).toMatch(/project_billing_stages_amount_check/)
    expect(await failure(stage(p, { basis: 'percent', percent: null, amount: null }))).toMatch(/project_billing_stages_percent_check/)
    expect(await failure(stage(p, { basis: 'percent', percent: 150, amount: null }))).toMatch(/project_billing_stages_percent_check/)
    expect(await failure(stage(p, { basis: 'percent', percent: 50, amount: null }))).toBe('')
  })

  it('refuses two stages in the same position on one project', async () => {
    const p = await project()
    await stage(p, { position: 1 })
    expect(await failure(stage(p, { position: 1 }))).toMatch(/project_billing_stages_project_position_key/)
    // The same position on another project is that project's first stage.
    expect(await failure(stage(await project(), { position: 1 }))).toBe('')
  })

  it('refuses a stage in a currency the project is not in, by foreign key', async () => {
    const p = await project('JPY')
    // The stage inserts as AUD; the project is JPY, so the composite key fails.
    expect(await failure(stage(p, { position: 1 }))).toMatch(/project_billing_stages_project_fk/)
  })
})

describe('an organization leaving', () => {
  it('takes its revisions with it, however they ended', async () => {
    const org = crypto.randomUUID()
    await admin.query(`insert into organization (id, name, slug) values ($1, 'Leaving', $2)`, [org, `rev-leaving-${org.slice(0, 8)}`])
    const p = await project('AUD', org)
    await revision(p, 'accepted', { org, number: 1 })
    await revision(p, 'sent', { org, number: 2 })

    // As in the other guard tests: the cascade needs a right the application
    // role is denied, and granting it here isolates what this test is about.
    await admin.query('grant delete on audit_logs to workloom_app_test')
    try {
      await admin.query(`delete from organization where id = $1`, [org])
    } finally {
      await admin.query('revoke delete on audit_logs from workloom_app_test')
    }
    const { rowCount } = await admin.query(`select 1 from project_revisions where organization_id = $1`, [org])
    expect(rowCount).toBe(0)
  })
})
