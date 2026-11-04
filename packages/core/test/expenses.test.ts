import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Expenses v2 (S15): drafts that count for nothing until a person confirms
 * them, numbers given on confirmation, receipts checked by their bytes, the
 * agency's own categories, and tax that is a cost when it is not reclaimed.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let storage: typeof import('@workloom/storage')

const ORG = '01a0aa00-0000-7000-8000-0000000015aa'
const OTHER = '01a0aa00-0000-7000-8000-0000000015bb'
let owner: string
let manager: string
let otherOwner: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  await import('../src/modules/index.ts')
  storage = await import('@workloom/storage')
  owner = core.newId()
  manager = core.newId()
  otherOwner = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone, reclaims_input_tax) values
        (${ORG}::uuid, 'Webloom', 'webloom-s15', 'LKR', 'Asia/Colombo', false),
        (${OTHER}::uuid, 'Other', 'other-s15', 'LKR', 'Asia/Colombo', true)`)
    await db.execute(sql`insert into "user" (id, name, email) values
      (${owner}::uuid, 'Owner', 's15-owner@example.com'),
      (${manager}::uuid, 'Manager', 's15-manager@example.com'),
      (${otherOwner}::uuid, 'Other owner', 's15-other@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values
      (${core.newId()}::uuid, ${ORG}::uuid, ${owner}::uuid, 'owner'),
      (${core.newId()}::uuid, ${ORG}::uuid, ${manager}::uuid, 'manager'),
      (${core.newId()}::uuid, ${OTHER}::uuid, ${otherOwner}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'manager'
const as = (organizationId: string, userId: string, role: Role) => ({
  organizationId,
  actor: { type: 'user' as const, id: userId, label: role },
  role,
  permissions: core.permissionsForRole(role),
})
const asOwner = () => as(ORG, owner, 'owner')
const asManager = () => as(ORG, manager, 'manager')

function run<T = any>(name: string, input: unknown, actor = asOwner()): Promise<T> {
  return registry.executeProcedure(name, { ...actor, input }) as Promise<T>
}
async function refused(name: string, input: unknown, code: string, actor = asOwner()) {
  await expect(run(name, input, actor)).rejects.toMatchObject({ code })
}

const unique = () => core.newId().slice(-8)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF receipt photo')])
const file = (bytes: Buffer | string, name: string, type: string) => new File([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], name, { type })

describe('drafts', () => {
  it('count for nothing until a person confirms them, and are numbered then', async () => {
    const companyId = (await run('company.create', { name: `Client ${unique()}` })).id
    const project = await run('project.create', { companyId, name: `Project ${unique()}`, currency: 'LKR' })

    const draft = await run('expense.create', {
      description: 'Hostinger renewal',
      amountMinor: 4_350_00,
      projectId: project.id,
      billable: true,
      status: 'draft',
      category: 'hosting',
    })
    expect(draft).toMatchObject({ status: 'draft', number: null, confirmedAt: null })

    // Not a cost on the project, the dashboard, the revenue report, or a rebill.
    const financials = await run('project.financials', { id: project.id })
    expect(financials.currencies.find((c: any) => c.currency === 'LKR')?.expenseCostMinor ?? 0).toBe(0)
    const revenue = await run('report.revenue', { from: '2000-01-01', to: '2100-01-01', companyId })
    expect(revenue.currencies.find((c: any) => c.currency === 'LKR')?.expenseCostMinor ?? 0).toBe(0)
    const invoice = await run('invoice.create', { companyId, title: 'Rebill' })
    const rebilled = await run('invoice.billExpenses', { id: invoice.id })
    expect(rebilled.rebilled.linesAdded).toBe(0)

    const confirmed = await run('expense.confirm', { id: draft.id })
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.number).toMatch(/^EXP-\d{4}$/)
    // Confirming again changes nothing.
    expect((await run('expense.confirm', { id: draft.id })).number).toBe(confirmed.number)

    const after = await run('project.financials', { id: project.id })
    // This organization does not reclaim tax, but this expense had none: its cost is its amount.
    expect(after.currencies.find((c: any) => c.currency === 'LKR').expenseCostMinor).toBe(4_350_00)
  })

  it('numbers confirmed expenses one after another, whether confirmed at once or later', async () => {
    const a = await run('expense.create', { description: 'A', amountMinor: 1_00 })
    const b = await run('expense.create', { description: 'B', amountMinor: 1_00, status: 'draft' })
    const c = await run('expense.create', { description: 'C', amountMinor: 1_00 })
    const bConfirmed = await run('expense.confirm', { id: b.id })
    const n = (x: string) => Number(x.slice(4))
    expect(n(c.number)).toBe(n(a.number) + 1)
    expect(n(bConfirmed.number)).toBe(n(c.number) + 1)
  })

  it('cannot be confirmed without an amount, and someone else’s needs the right to change expenses', async () => {
    const blank = await run('expense.create', { description: 'Receipt from Telegram', amountMinor: 0, status: 'draft' })
    await refused('expense.confirm', { id: blank.id }, 'amount_required')
    await refused('expense.create', { description: 'Nothing', amountMinor: 0 }, 'amount_required')

    // The owner's draft: a manager may record expenses, but not confirm someone else's.
    const ownersDraft = await run('expense.create', { description: 'Owner’s', amountMinor: 10_00, status: 'draft' })
    await expect(run('expense.confirm', { id: ownersDraft.id }, asManager())).rejects.toBeInstanceOf(core.ForbiddenError)
    // Their own, they may.
    const managersDraft = await run('expense.create', { description: 'Manager’s', amountMinor: 10_00, status: 'draft' }, asManager())
    expect((await run('expense.confirm', { id: managersDraft.id }, asManager())).status).toBe('confirmed')
  })

  it('cannot be rebilled or numbered while a draft, at the database', async () => {
    const draft = await run('expense.create', { description: 'Draft', amountMinor: 10_00, status: 'draft' })
    const refusedWrite = await mod
      .withTenant(ORG, (tx) => tx.execute(sql`update expenses set number = 'EXP-9999' where id = ${draft.id}::uuid`))
      .then(() => null, (e: any) => `${e.message} ${e.cause?.message ?? ''}`)
    expect(refusedWrite).toMatch(/expenses_draft_check/)
  })
})

describe('tax as a cost', () => {
  it('counts the tax on an expense when the organization does not claim it back', async () => {
    const vat = (await run('taxRate.create', { name: `VAT ${unique()}`, rate: '18' })).id
    const project = await run('project.create', { name: `Internal ${unique()}`, currency: 'LKR' })
    // The receipt says 11,800 including tax: 10,000 net, 1,800 tax.
    const expense = await run('expense.create', { description: 'Laptop bag', amountMinor: 11_800_00, amountIncludesTax: true, taxRateId: vat, projectId: project.id })
    expect(expense).toMatchObject({ amountMinor: 10_000_00, taxMinor: 1_800_00, totalMinor: 11_800_00 })
    const financials = await run('project.financials', { id: project.id })
    expect(financials.currencies.find((c: any) => c.currency === 'LKR').expenseCostMinor).toBe(11_800_00)

    // An organization that reclaims it costs only the net.
    const otherOwnerCtx = as(OTHER, otherOwner, 'owner')
    const otherVat = (await run('taxRate.create', { name: 'VAT', rate: '18' }, otherOwnerCtx)).id
    const otherProject = await run('project.create', { name: 'Reclaiming', currency: 'LKR' }, otherOwnerCtx)
    await run('expense.create', { description: 'Laptop bag', amountMinor: 10_000_00, taxRateId: otherVat, projectId: otherProject.id }, otherOwnerCtx)
    const otherFinancials = await run('project.financials', { id: otherProject.id }, otherOwnerCtx)
    expect(otherFinancials.currencies.find((c: any) => c.currency === 'LKR').expenseCostMinor).toBe(10_000_00)
  })
})

describe('receipts', () => {
  it('are kept, checked by their bytes, and flagged when the same file arrives twice', async () => {
    const expense = await run('expense.create', { description: 'Fuel', amountMinor: 5_000_00 })
    const uploaded = await run('expenseReceipt.upload', { expenseId: expense.id, file: file(JPEG, 'IMG_2041.JPG', 'image/jpeg') })
    expect(uploaded).toMatchObject({ contentType: 'image/jpeg', filename: 'IMG_2041.jpg', previewable: true, duplicateOf: null })
    expect((await run('expense.get', { id: expense.id })).receiptCount).toBe(1)

    const download = await run('expenseReceipt.download', { id: uploaded.id })
    expect(download.inline).toBe(true)
    expect(new URL(download.url).searchParams.get('disposition')).toBe('inline')

    const another = await run('expense.create', { description: 'Fuel again', amountMinor: 5_000_00 })
    const again = await run('expenseReceipt.upload', { expenseId: another.id, file: file(JPEG, 'copy.jpg', 'image/jpeg') })
    expect(again.duplicateOf).toMatchObject({ expenseId: expense.id })

    // A PDF downloads; it is not shown.
    const pdf = await run('expenseReceipt.upload', { expenseId: expense.id, file: file('%PDF-1.7\n', 'invoice.pdf', 'application/pdf') })
    expect((await run('expenseReceipt.download', { id: pdf.id })).inline).toBe(false)
  })

  it('refuses what is not a photo or a PDF, whatever it is called, and what is too big', async () => {
    const expense = await run('expense.create', { description: 'Lunch', amountMinor: 2_000_00 })
    await refused('expenseReceipt.upload', { expenseId: expense.id, file: file('<html><script>alert(1)</script>', 'receipt.jpg', 'image/jpeg') }, 'file_type')
    await refused('expenseReceipt.upload', { expenseId: expense.id, file: file('', 'empty.jpg', 'image/jpeg') }, 'file_empty')
    const huge = Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)])
    await refused('expenseReceipt.upload', { expenseId: expense.id, file: file(huge, 'huge.jpg', 'image/jpeg') }, 'file_too_large')
  })

  it('go when they are deleted, and go with their expense', async () => {
    const expense = await run('expense.create', { description: 'Taxi', amountMinor: 1_500_00 })
    const one = await run('expenseReceipt.upload', { expenseId: expense.id, file: file(Buffer.concat([JPEG, Buffer.from(unique())]), 'a.jpg', 'image/jpeg') })
    const two = await run('expenseReceipt.upload', { expenseId: expense.id, file: file(Buffer.concat([JPEG, Buffer.from(unique())]), 'b.jpg', 'image/jpeg') })
    const keys = await mod.withTenant(ORG, (tx) => tx.execute<{ storage_key: string; id: string }>(sql`select id, storage_key from expense_receipts where expense_id = ${expense.id}::uuid`))
    const keyOf = (id: string) => keys.rows.find((r) => r.id === id)!.storage_key
    expect(await storage.storage().exists(keyOf(one.id))).toBe(true)

    await run('expenseReceipt.delete', { id: one.id })
    expect(await storage.storage().exists(keyOf(one.id))).toBe(false)
    await run('expense.delete', { id: expense.id })
    expect(await storage.storage().exists(keyOf(two.id))).toBe(false)
  })

  it('leave no file behind when the upload is rolled back', async () => {
    const expense = await run('expense.create', { description: 'Rolled back', amountMinor: 1_00 })
    const before = (await mod.withTenant(ORG, (tx) => tx.execute(sql`select count(*)::int as n from expense_receipts`))).rows[0] as { n: number }
    // A manager may not attach a receipt to the owner's expense: the upload fails after nothing was written.
    await expect(run('expenseReceipt.upload', { expenseId: expense.id, file: file(JPEG, 'x.jpg', 'image/jpeg') }, asManager())).rejects.toBeInstanceOf(core.ForbiddenError)
    const after = (await mod.withTenant(ORG, (tx) => tx.execute(sql`select count(*)::int as n from expense_receipts`))).rows[0] as { n: number }
    expect(after.n).toBe(before.n)
  })

  it('stay in their organization', async () => {
    const expense = await run('expense.create', { description: 'Private', amountMinor: 1_00 })
    const receipt = await run('expenseReceipt.upload', { expenseId: expense.id, file: file(Buffer.concat([JPEG, Buffer.from('private')]), 'p.jpg', 'image/jpeg') })
    const otherOwnerCtx = as(OTHER, otherOwner, 'owner')
    await expect(run('expenseReceipt.download', { id: receipt.id }, otherOwnerCtx)).rejects.toBeInstanceOf(core.NotFoundError)
    await expect(run('expenseReceipt.list', { expenseId: expense.id }, otherOwnerCtx)).rejects.toBeInstanceOf(core.NotFoundError)
  })
})

describe('categories', () => {
  it("are the organization's own, with how the tax pack treats them", async () => {
    const list = await run('expenseCategory.list', {})
    expect(list.data.map((c: any) => c.key)).toContain('hosting')
    expect(list.data.find((c: any) => c.key === 'hardware').taxTreatment).toBe('capital')

    const ads = await run('expenseCategory.create', { name: 'Meta ads' })
    expect(ads.key).toBe('meta_ads')
    const expense = await run('expense.create', { description: 'Boosted post', amountMinor: 3_000_00, category: 'meta_ads' })
    expect(expense).toMatchObject({ category: 'meta_ads', categoryName: 'Meta ads', taxTreatment: 'deductible' })

    await run('expenseCategory.update', { key: 'meta_ads', archived: true })
    await refused('expense.create', { description: 'More ads', amountMinor: 1_00, category: 'meta_ads' }, 'category_archived')
    // The expense already filed keeps its category.
    expect((await run('expense.get', { id: expense.id })).categoryName).toBe('Meta ads')
    await refused('expense.create', { description: 'Nowhere', amountMinor: 1_00, category: 'no_such' }, 'category_unknown')
    await refused('expenseCategory.update', { key: 'other', archived: true }, 'category_required')
  })

  it('are given their defaults the first time a new organization asks', async () => {
    const fresh = '01a0aa00-0000-7000-8000-0000000015cc'
    const freshOwner = core.newId()
    await mod.withoutTenant('fresh org', async (db) => {
      await db.execute(sql`insert into organization (id, name, slug, base_currency) values (${fresh}::uuid, 'Fresh', 'fresh-s15', 'LKR')`)
      await db.execute(sql`insert into "user" (id, name, email) values (${freshOwner}::uuid, 'Fresh', 's15-fresh@example.com')`)
      await db.execute(sql`insert into member (id, organization_id, user_id, role) values (${core.newId()}::uuid, ${fresh}::uuid, ${freshOwner}::uuid, 'owner')`)
    })
    const expense = await run('expense.create', { description: 'First', amountMinor: 1_00 }, as(fresh, freshOwner, 'owner'))
    expect(expense.category).toBe('other')
    expect(expense.currency).toBe('LKR')
  })
})
