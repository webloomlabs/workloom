import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Resetting an organization, end to end: who may, the password, the emailed
 * code, and what is left afterwards.
 *
 * The data is made through the procedures, as the product makes it -- issued
 * and paid invoices, a sent quote, locked books -- because those are what the
 * database guards refuse to let go of. The guards' exception itself is tested
 * in packages/db/test/wipe.test.ts.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let reset: typeof import('../src/organization-reset.ts')
let provisioning: typeof import('../src/provisioning.ts')
let auth: typeof import('../src/auth.ts').auth
let core: typeof import('@workloom/core')
let registry: typeof import('@workloom/core/registry')
let emails: typeof import('@workloom/emails')

const PASSWORD = 'a-sufficiently-long-password'
const ORG_B = '01a0ab00-0000-7000-8000-0000000000bb'

let orgA: string
let owner: { id: string; email: string }
let admin: { id: string }
let ownerB: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  ;({ auth } = await import('../src/auth.ts'))
  provisioning = await import('../src/provisioning.ts')
  reset = await import('../src/organization-reset.ts')
  core = await import('@workloom/core')
  registry = await import('@workloom/core/registry')
  await import('@workloom/core/modules')
  emails = await import('@workloom/emails')

  const setup = await provisioning.completeSetup({
    admin: { name: 'Olive Owner', email: 'owner@reset.test', password: PASSWORD },
    organizationName: 'Resettable Agency',
  })
  orgA = setup.organizationId
  owner = { id: setup.userId, email: 'owner@reset.test' }
  const added = await provisioning.provisionMember({
    organizationId: orgA,
    role: 'admin',
    person: { name: 'Adam Admin', email: 'admin@reset.test', password: PASSWORD },
    createdBy: { type: 'user', id: owner.id, label: 'Olive' },
  })
  admin = { id: added.userId }

  // A second organization on the same installation, which must not notice.
  ownerB = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`insert into organization (id, name, slug) values (${ORG_B}::uuid, 'Bystander', 'bystander')`)
    await db.execute(sql`insert into "user" (id, name, email) values (${ownerB}::uuid, 'Bea', 'bea@other.test')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values (${core.newId()}::uuid, ${ORG_B}::uuid, ${ownerB}::uuid, 'owner')`)
  })

  await seed(orgA, owner.id)
  await seed(ORG_B, ownerB)
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

function run<T = any>(organizationId: string, userId: string, name: string, input: unknown): Promise<T> {
  return registry.executeProcedure(name, {
    organizationId,
    actor: { type: 'user', id: userId, label: 'test' },
    role: 'owner',
    permissions: core.permissionsForRole('owner'),
    input,
  }) as Promise<T>
}

/** One of nearly everything, including what the guards hold on to. */
async function seed(org: string, userId: string) {
  const r = <T = any>(name: string, input: unknown) => run<T>(org, userId, name, input)
  const company = (await r('company.create', { name: 'Harbour Co' })).id
  await r('contact.create', { companyId: company, firstName: 'Hana', email: 'hana@harbour.test' })
  const project = (await r('project.create', { name: 'Harbour site', companyId: company })).id
  await r('task.create', { projectId: project, title: 'Wireframes' })
  await r('taxRate.create', { name: 'GST', rate: '10' })
  await r('bankAccount.create', { name: 'Operating', kind: 'bank', currency: 'AUD', openingBalanceOn: '2025-01-01', openingBalanceMinor: 0 })
  await r('webhook.create', { url: 'https://93.184.215.14/hook', eventTypes: ['invoice.*'] })

  const quote = await r('quote.create', { companyId: company, title: 'Proposal', lines: [{ description: 'Design', unitAmountMinor: 500_00 }] })
  await r('quote.send', { id: quote.id })

  const draft = await r('invoice.create', { companyId: company, title: 'Deposit', currency: 'AUD', paymentTermsDays: 0, lines: [{ description: 'Deposit', unitAmountMinor: 1000_00 }] })
  const invoice = await r('invoice.send', { id: draft.id, issueDate: '2025-06-01' })
  await r('payment.record', { companyId: company, amountMinor: 400_00, receivedOn: '2025-06-10', allocations: [{ invoiceId: invoice.id }] })
  await r('expense.create', { description: 'Hosting', amountMinor: 30_00, incurredOn: '2025-06-15' })
  await r('books.lock', { through: '2025-12-31', reason: 'Year filed' })

  // A stored file, where the organization's files live.
  const dir = join(process.env.STORAGE_LOCAL_PATH!, org, 'documents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'contract.pdf'), 'pdf')
}

async function rows(org: string, table: string): Promise<number> {
  const { rows } = await mod.withTenant(org, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`))
  return rows[0]!.n
}

async function tenantTables(): Promise<string[]> {
  const { rows } = await mod.withoutTenant('test: tables', (db) =>
    db.execute<{ t: string }>(sql`
      select c.relname as t from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
      where c.relkind = 'r' and n.nspname = 'public' and c.relrowsecurity`),
  )
  return rows.map((r) => r.t)
}

async function snapshot(org: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const table of await tenantTables()) result[table] = await rows(org, table)
  return result
}

const ownerActor = () => ({ type: 'user' as const, id: owner.id, label: 'Olive' })

/** Asks for a code as the owner and returns it, as read from the email. */
async function codeFor(): Promise<string> {
  emails.clearSentEmails()
  await reset.requestOrganizationReset({ organizationId: orgA, userId: owner.id, password: PASSWORD, actor: ownerActor() })
  const sent = emails.sentEmails()
  expect(sent).toHaveLength(1)
  expect(sent[0]!.to).toBe(owner.email)
  return /Code: (\d{6})/.exec(sent[0]!.text!)![1]!
}

const confirm = (code: string) =>
  reset.confirmOrganizationReset({ organizationId: orgA, userId: owner.id, code, actor: ownerActor() })

/** The limits are per minute; these tests make more attempts than a person would. */
const clearRateLimits = () => mod.withoutTenant('test: rate limits', (db) => db.execute(sql`delete from rate_limits`))

describe('who may ask', () => {
  it('refuses an admin, even with their own correct password', async () => {
    emails.clearSentEmails()
    await expect(
      reset.requestOrganizationReset({ organizationId: orgA, userId: admin.id, password: PASSWORD, actor: { type: 'user', id: admin.id, label: 'Adam' } }),
    ).rejects.toBeInstanceOf(core.ForbiddenError)
    await expect(
      reset.confirmOrganizationReset({ organizationId: orgA, userId: admin.id, code: '000000', actor: { type: 'user', id: admin.id, label: 'Adam' } }),
    ).rejects.toBeInstanceOf(core.ForbiddenError)
    expect(emails.sentEmails()).toHaveLength(0)
  })

  it('refuses an owner of another organization', async () => {
    await expect(
      reset.requestOrganizationReset({ organizationId: orgA, userId: ownerB, password: PASSWORD, actor: { type: 'user', id: ownerB, label: 'Bea' } }),
    ).rejects.toBeInstanceOf(core.ForbiddenError)
  })
})

describe('step one: the password', () => {
  it('sends nothing for a wrong password', async () => {
    emails.clearSentEmails()
    await expect(
      reset.requestOrganizationReset({ organizationId: orgA, userId: owner.id, password: 'not-my-password-at-all', actor: ownerActor() }),
    ).rejects.toMatchObject({ code: 'invalid_password', field: 'password' })
    expect(emails.sentEmails()).toHaveLength(0)
  })

  it('emails a six-digit code, and keeps only a digest of it', async () => {
    const code = await codeFor()
    expect(code).toMatch(/^\d{6}$/)
    const { rows: stored } = await mod.withoutTenant('test: verification', (db) =>
      db.execute<{ value: string }>(sql`select value from verification where identifier like 'organization-reset:%'`),
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]!.value).not.toContain(code)
  })
})

describe('step two: the code', () => {
  it('refuses a wrong code and deletes nothing', async () => {
    await clearRateLimits()
    const code = await codeFor()
    const wrong = code === '000000' ? '000001' : '000000'
    await expect(confirm(wrong)).rejects.toMatchObject({ code: 'invalid_code', field: 'code' })
    expect(await rows(orgA, 'invoices')).toBe(1)
  })

  it('spends the code after five wrong guesses, so the right one no longer works', async () => {
    await clearRateLimits()
    const code = await codeFor()
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 4; i++) await expect(confirm(wrong)).rejects.toMatchObject({ code: 'invalid_code' })
    await expect(confirm(wrong)).rejects.toMatchObject({ code: 'code_spent' })
    await expect(confirm(code)).rejects.toMatchObject({ code: 'code_expired' })
    expect(await rows(orgA, 'invoices')).toBe(1)
  })

  it('refuses an expired code', async () => {
    await clearRateLimits()
    const code = await codeFor()
    await mod.withoutTenant('test: expire', (db) =>
      db.execute(sql`update verification set expires_at = now() - interval '1 second' where identifier like 'organization-reset:%'`),
    )
    await expect(confirm(code)).rejects.toMatchObject({ code: 'code_expired' })
  })

  it('accepts only the newest code', async () => {
    await clearRateLimits()
    const first = await codeFor()
    const second = await codeFor()
    if (first !== second) await expect(confirm(first)).rejects.toMatchObject({ code: 'invalid_code' })
    expect(await rows(orgA, 'invoices')).toBe(1)
    // Leave no live code behind for the next test.
    await mod.withoutTenant('test: clear', (db) => db.execute(sql`delete from verification where identifier like 'organization-reset:%'`))
  })
})

describe('the reset', () => {
  it('deletes every record and file of the organization, and nothing of another', async () => {
    await clearRateLimits()
    const otherBefore = await snapshot(ORG_B)
    const auditBefore = await rows(orgA, 'audit_logs')
    expect(await rows(orgA, 'payments')).toBe(1)

    const code = await codeFor()
    const result = await confirm(code)

    expect(result.deleted).toMatchObject({ invoices: 1, quotes: 1, payments: 1, companies: 1, webhook_endpoints: 1, tax_rates: 1 })
    expect(result.files).toBe(1)

    const after = await snapshot(orgA)
    expect(Object.entries(after).filter(([t, n]) => n > 0 && t !== 'audit_logs' && t !== 'audit_seals')).toEqual([])
    expect(existsSync(join(process.env.STORAGE_LOCAL_PATH!, orgA))).toBe(false)

    // Untouched next door.
    expect(await snapshot(ORG_B)).toEqual(otherBefore)
    expect(existsSync(join(process.env.STORAGE_LOCAL_PATH!, ORG_B, 'documents', 'contract.pdf'))).toBe(true)

    // The log is kept, and says what happened.
    expect(after.audit_logs).toBeGreaterThan(auditBefore)
    const { rows: entries } = await mod.withTenant(orgA, (tx) =>
      tx.execute<{ action: string; actor_id: string; snapshot: { deleted: Record<string, number> } }>(
        sql`select action, actor_id, snapshot from audit_logs where action = 'organization.reset'`,
      ),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.actor_id).toBe(owner.id)
    expect(entries[0]!.snapshot.deleted.invoices).toBe(1)
  })

  it('keeps the organization, its members and their sign-ins, and opens its books', async () => {
    const { rows: org } = await mod.withoutTenant('test: org', (db) =>
      db.execute<{ name: string; books_locked_through: string | null; logo_key: string | null }>(
        sql`select name, books_locked_through, logo_key from organization where id = ${orgA}::uuid`,
      ),
    )
    expect(org[0]).toEqual({ name: 'Resettable Agency', books_locked_through: null, logo_key: null })
    const { rows: members } = await mod.withoutTenant('test: members', (db) =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from member where organization_id = ${orgA}::uuid`),
    )
    expect(members[0]!.n).toBe(2)
    await expect(auth.api.signInEmail({ body: { email: owner.email, password: PASSWORD } })).resolves.toBeTruthy()
  })

  it('cannot be confirmed twice with one code', async () => {
    await clearRateLimits()
    const code = await codeFor()
    await confirm(code)
    await expect(confirm(code)).rejects.toMatchObject({ code: 'code_expired' })
  })

  it('leaves an organization that works from scratch, numbering included', async () => {
    const r = <T = any>(name: string, input: unknown) => run<T>(orgA, owner.id, name, input)
    const company = (await r('company.create', { name: 'First client again' })).id
    const draft = await r('invoice.create', { companyId: company, title: 'Fresh', currency: 'AUD', lines: [{ description: 'Work', unitAmountMinor: 100_00 }] })
    const sent = await r('invoice.send', { id: draft.id, issueDate: '2025-03-01' })
    expect(sent.number).toMatch(/0*1$/)
  })
})
