import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { createHash } from 'node:crypto'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Closing the books (S20): the lock date, held by the database; audit entries
 * that keep what was deleted, filtered and exported; seals that show a
 * rewritten log; and the income tax pack, built and unzipped.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')
let storage: typeof import('@workloom/storage')

const ORG = '01a0dd00-0000-7000-8000-0000000020aa'
const OTHER = '01a0dd00-0000-7000-8000-0000000020bb'
let owner: string
let finance: string
let otherOwner: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')
  storage = await import('@workloom/storage')
  owner = core.newId()
  finance = core.newId()
  otherOwner = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`insert into organization (id, name, legal_name, slug, base_currency, timezone, fiscal_year_start_month) values
      (${ORG}::uuid, 'Webloom', 'Webloom Labs (Pvt) Ltd', 'webloom-s20', 'LKR', 'Asia/Colombo', 4),
      (${OTHER}::uuid, 'Other', null, 'other-s20', 'LKR', 'Asia/Colombo', 4)`)
    await db.execute(sql`insert into "user" (id, name, email) values
      (${owner}::uuid, 'Owner', 's20-owner@example.com'), (${finance}::uuid, 'Finance', 's20-finance@example.com'), (${otherOwner}::uuid, 'Other', 's20-other@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values
      (${core.newId()}::uuid, ${ORG}::uuid, ${owner}::uuid, 'owner'),
      (${core.newId()}::uuid, ${ORG}::uuid, ${finance}::uuid, 'finance'),
      (${core.newId()}::uuid, ${OTHER}::uuid, ${otherOwner}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'finance'
const as = (userId: string, role: Role, organizationId = ORG) => ({ organizationId, actor: { type: 'user' as const, id: userId, label: role }, role, permissions: core.permissionsForRole(role) })
function run<T = any>(name: string, input: unknown, actor = as(owner, 'owner'), now?: Date): Promise<T> {
  return registry.executeProcedure(name, { ...actor, input, ...(now ? { now } : {}) }) as Promise<T>
}
const unique = () => core.newId().slice(-8)
const company = async (organizationId = ORG, actor = as(owner, 'owner')) => (await run('company.create', { name: `Client ${unique()}` }, organizationId === ORG ? actor : as(otherOwner, 'owner', OTHER))).id as string
const PDF = () => new File([`%PDF-1.4\n% receipt ${unique()}\n`], 'receipt.pdf', { type: 'application/pdf' })

async function issued(companyId: string, amountMinor: number, issueDate: string, actor = as(owner, 'owner')) {
  const invoice = await run('invoice.create', { companyId, title: `Work ${unique()}`, lines: [{ description: 'Work', unitAmountMinor: amountMinor }] }, actor)
  return run('invoice.send', { id: invoice.id, issueDate }, actor)
}

describe('the lock date', () => {
  it('is set by an owner, up to today, and only forward', async () => {
    await expect(run('books.lock', { through: '2025-03-31', reason: 'Year closed' }, as(finance, 'finance'))).rejects.toBeInstanceOf(core.ForbiddenError)
    await expect(run('books.lock', { through: '2999-01-01', reason: 'Too soon' })).rejects.toMatchObject({ code: 'lock_in_future' })
    expect(await run('books.lock', { through: '2025-03-31', reason: 'YoA 2024/25 filed' })).toMatchObject({ booksLockedThrough: '2025-03-31' })
    await expect(run('books.lock', { through: '2025-01-31', reason: 'Back' })).rejects.toMatchObject({ code: 'already_locked' })
  })

  it('holds invoices, payments, and expenses of the closed period, whichever way they come', async () => {
    const client = await company()
    // Issued before the lock was set? Not possible now: issuing into the closed period is refused.
    await expect(issued(client, 1_000_00, '2025-03-15')).rejects.toMatchObject({ code: 'books_locked', message: expect.stringContaining('closed through 2025-03-31') })
    await expect(run('payment.record', { companyId: client, amountMinor: 1_00, receivedOn: '2025-03-10' })).rejects.toMatchObject({ code: 'books_locked' })
    await expect(run('expense.create', { description: 'Old taxi', amountMinor: 5_00, incurredOn: '2025-02-01' })).rejects.toMatchObject({ code: 'books_locked' })
    // A draft in the period is allowed -- it is not in the books -- but confirming it puts it there.
    const draft = await run('expense.create', { description: 'Found receipt', amountMinor: 5_00, incurredOn: '2025-02-01', status: 'draft' })
    await expect(run('expense.confirm', { id: draft.id })).rejects.toMatchObject({ code: 'books_locked' })
    // Moving a new record back into the period counts as adding it there.
    const fresh = await run('expense.create', { description: 'New taxi', amountMinor: 5_00, incurredOn: '2025-05-01' })
    await expect(run('expense.update', { id: fresh.id, incurredOn: '2025-03-01' })).rejects.toMatchObject({ code: 'books_locked' })
  })

  it('still lets an old invoice be paid, and an old expense be evidenced, after the lock', async () => {
    await run('books.unlock', { reason: 'Set up the year' })
    const client = await company()
    const old = await issued(client, 2_000_00, '2025-03-20')
    const unpaid = await issued(client, 1_500_00, '2025-03-21')
    const oldExpense = await run('expense.create', { description: 'Hosting', amountMinor: 3_00, incurredOn: '2025-03-20' })
    const receipt = await run('expenseReceipt.upload', { expenseId: oldExpense.id, file: PDF() })
    await run('books.lock', { through: '2025-03-31', reason: 'YoA 2024/25 filed' })

    await run('payment.record', { companyId: client, amountMinor: 2_000_00, receivedOn: '2025-04-10', allocations: [{ invoiceId: old.id }] })
    expect((await run('invoice.get', { id: old.id })).status).toBe('paid')
    await run('expenseReceipt.upload', { expenseId: oldExpense.id, file: PDF() })

    await expect(run('invoice.cancel', { id: unpaid.id, reason: 'Oops' })).rejects.toMatchObject({ code: 'books_locked' })
    await expect(run('expense.delete', { id: oldExpense.id })).rejects.toMatchObject({ code: 'books_locked' })
    await expect(run('expenseReceipt.delete', { id: receipt.id })).rejects.toMatchObject({ code: 'books_locked' })

    const reopened = await run('books.unlock', { to: '2025-02-28', reason: 'Late supplier credit' })
    expect(reopened.booksLockedThrough).toBe('2025-02-28')
    await run('expenseReceipt.delete', { id: receipt.id })
    const { rows } = await mod.withTenant(ORG, (tx) =>
      tx.execute<{ entity_label: string; changes: any }>(sql`select entity_label, changes from audit_logs where action = 'books.unlocked' order by created_at desc limit 1`),
    )
    expect(rows[0]).toMatchObject({ entity_label: 'Late supplier credit', changes: { booksLockedThrough: { from: '2025-03-31', to: '2025-02-28' } } })
    await run('books.unlock', { reason: 'Leave open for the rest of the tests' })
  })
})

describe('the audit log', () => {
  it('keeps the whole of a deleted money record', async () => {
    const expense = await run('expense.create', { description: 'Deleted later', amountMinor: 7_50 })
    await run('expense.delete', { id: expense.id })
    const { data } = await run('auditLog.list', { entityId: expense.id, action: 'expense.' })
    expect(data.map((e: any) => e.action)).toEqual(['expense.deleted', 'expense.created'])
    expect(data[0].snapshot).toMatchObject({ id: expense.id, description: 'Deleted later', amountMinor: 7_50 })
  })

  it('filters by who, what, how, and when, and exports what it shows', async () => {
    const byFinance = await run('auditLog.list', { actorId: finance })
    expect(byFinance.data.every((e: any) => e.actorId === finance)).toBe(true)
    const today = new Date().toISOString().slice(0, 10)
    expect((await run('auditLog.list', { from: '2000-01-01', to: '2000-01-02' })).data).toEqual([])
    expect((await run('auditLog.list', { from: today, to: today, source: 'web' })).data.length).toBeGreaterThan(0)

    const exported = await run('auditLog.export', { action: 'books.' })
    expect(exported.csv.startsWith('﻿When (UTC),Action')).toBe(true)
    expect(exported.csv).toContain('books.locked')
    expect(exported.csv).not.toContain('expense.created')
  })

  it('cannot be emptied by the application', async () => {
    const refusal = (query: ReturnType<typeof sql>) =>
      mod.withTenant(ORG, (tx) => tx.execute(query)).then(
        () => 'allowed',
        (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
      )
    expect(await refusal(sql`truncate audit_logs`)).toMatch(/permission denied/)
    expect(await refusal(sql`delete from audit_seals`)).toMatch(/permission denied/)
    expect(await refusal(sql`update audit_seals set digest = 'x'`)).toMatch(/permission denied/)
  })

  it('is sealed day by day, and a slipped-in entry shows', async () => {
    const at = (day: string) => new Date(`${day}T10:00:00Z`)
    const seal = (now: Date) =>
      mod.withTenant(ORG, (tx) => modules.sealAuditLog(registry.buildContext({ organizationId: ORG, actor: { type: 'job', label: 'seal' }, role: null, permissions: new Set(), now }, tx)))
    const tomorrow = new Date(Date.now() + 86_400_000)
    expect(await seal(tomorrow)).toBeGreaterThan(0)
    expect(await seal(tomorrow)).toBe(0)
    expect(await run('auditSeal.verify', {})).toMatchObject({ ok: true, brokenAt: null, unsealedDays: [] })

    // An entry written with a sealed day's date: the day no longer matches its seal.
    const sealed = (await run('auditSeal.verify', {})).sealedThrough as string
    await mod.withTenant(ORG, (tx) =>
      tx.execute(sql`insert into audit_logs (id, organization_id, actor_type, action, entity_type, created_at)
                     values (${core.newId()}::uuid, ${ORG}::uuid, 'system', 'invoice.cancelled', 'invoice', ${at(sealed).toISOString()}::timestamptz)`),
    )
    expect(await run('auditSeal.verify', {})).toMatchObject({ ok: false, brokenAt: sealed })
  })
})

describe('the income tax pack', () => {
  it('warns before it is made, then holds the year: figures, schedules, receipts, and checksums', async () => {
    // A deposit and a final statement in the year 2026/27 (April to March), paid; an expense with its receipt; one without.
    // (The invoice refused by the lock earlier is still a draft from this year: the pack should say so.)
    const client = await company()
    const deposit = await issued(client, 26_000_00, '2026-05-01')
    await run('payment.record', { companyId: client, amountMinor: 26_000_00, receivedOn: '2026-05-03', allocations: [{ invoiceId: deposit.id }] })
    await issued(client, 54_000_00, '2026-08-01')
    const hosting = await run('expense.create', { description: 'Hosting', supplier: 'Hostinger', amountMinor: 12_500_00, category: 'software', incurredOn: '2026-06-14' })
    await run('expenseReceipt.upload', { expenseId: hosting.id, file: PDF() })
    await run('expense.create', { description: 'Parking', amountMinor: 500_00, category: 'travel', incurredOn: '2026-06-20' })
    await run('expense.create', { description: 'Unchecked', amountMinor: 9_00, incurredOn: '2026-07-01', status: 'draft' })

    const preflight = await run('taxPack.preflight', { startYear: 2026 })
    expect(preflight).toMatchObject({ label: '2026/27', from: '2026-04-01', to: '2027-03-31', summary: { income: 80_000_00, deductible: 13_000_00, receipts: 1 } })
    expect(preflight.warnings.map((w: any) => w.code)).toEqual(['draft_invoices', 'draft_expenses', 'missing_receipts', 'books_open'])

    const requested = await run('taxPack.request', { startYear: 2026 }, as(finance, 'finance'))
    expect(requested.status).toBe('pending')
    await expect(run('taxPack.request', { startYear: 2026 })).rejects.toMatchObject({ code: 'pack_pending' })
    expect(await modules.buildDueTaxPacks()).toBeGreaterThanOrEqual(1)

    const [pack] = (await run('taxPack.list', {})).data
    expect(pack).toMatchObject({ id: requested.id, status: 'ready', summary: { income: 80_000_00, expenses: 2, receipts: 1 } })
    const link = await run('taxPack.download', { id: pack.id })
    expect(link.filename).toBe('Tax pack 2026-27.zip')

    const { rows } = await mod.withTenant(ORG, (tx) => tx.execute<{ storage_key: string }>(sql`select storage_key from tax_packs where id = ${pack.id}::uuid`))
    const zipped = await storage.storage().get(rows[0]!.storage_key)
    expect(createHash('sha256').update(zipped).digest('hex')).toBe(pack.sha256)
    const files = unzipSync(new Uint8Array(zipped))
    const names = Object.keys(files).map((n) => n.replace('Tax pack 2026-27/', ''))
    expect(names).toEqual(
      expect.arrayContaining(['README.txt', 'profit-and-loss.csv', 'revenue-schedule.csv', 'cash-receipts.csv', 'expense-schedule.csv', 'missing-receipts.csv', 'receipts-index.csv']),
    )
    const receipt = names.find((n) => n.startsWith('receipts/'))!
    expect(receipt).toMatch(/^receipts\/EXP-\d+_2026-06-14_hostinger\.pdf$/)

    const read = (name: string) => strFromU8(files[`Tax pack 2026-27/${name}`]!)
    expect(read('profit-and-loss.csv')).toContain('Income,Fees invoiced,80000')
    expect(read('missing-receipts.csv')).toContain('Parking')
    expect(read('expense-schedule.csv')).not.toContain('Unchecked')
    const readme = read('README.txt')
    expect(readme).toContain('Webloom Labs (Pvt) Ltd')
    const digest = createHash('sha256').update(files[`Tax pack 2026-27/${receipt}`]!).digest('hex')
    expect(readme).toContain(`${digest}  ${receipt}`)
  })

  it('holds nothing of another organization', async () => {
    await issued(await company(OTHER), 999_00, '2026-05-01', as(otherOwner, 'owner', OTHER))
    const theirs = await run('taxPack.preflight', { startYear: 2026 }, as(otherOwner, 'owner', OTHER))
    expect(theirs.summary).toMatchObject({ income: 999_00, expenses: 0 })
    const [ours] = (await run('taxPack.list', {})).data
    await expect(run('taxPack.download', { id: ours.id }, as(otherOwner, 'owner', OTHER))).rejects.toBeInstanceOf(core.NotFoundError)
  })
})
