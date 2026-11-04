import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Money moved between two of the agency's own accounts.
 *
 * Generic guarantees (audit, events, cross-tenant 404s) are covered for every
 * procedure in procedures.test.ts. This file is about what a transfer does to
 * the two registers.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')

const ORG = '01a0bb00-0000-7000-8000-0000000000f1'
let owner: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  await import('../src/modules/index.ts')

  owner = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone, payment_terms_days) values
        (${ORG}::uuid, 'Transfers', 'transfers', 'AUD', 'Australia/Sydney', 14)`)
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}::uuid, 'Owner', 'transfers@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values (${core.newId()}::uuid, ${ORG}::uuid, ${owner}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

function run<T = any>(name: string, input: unknown): Promise<T> {
  return registry.executeProcedure(name, {
    organizationId: ORG,
    actor: { type: 'user' as const, id: owner, label: 'owner' },
    role: 'owner' as const,
    permissions: core.permissionsForRole('owner'),
    input,
  }) as Promise<T>
}

const unique = () => core.newId().slice(-8)
const account = async (currency = 'AUD', openingBalanceMinor = 1_000_00) =>
  (await run('bankAccount.create', { name: `Account ${unique()}`, kind: 'bank', currency, openingBalanceOn: '2026-09-01', openingBalanceMinor })).id as string
const balance = async (id: string) => (await run('bankAccount.get', { id })).currentBalanceMinor as number

describe('a transfer in one currency', () => {
  it('takes the money out of one account and puts it in the other, with nothing left to explain', async () => {
    const from = await account()
    const to = await account('AUD', 0)

    const transfer = await run('bankTransfer.create', { fromAccountId: from, toAccountId: to, amountMinor: 250_00, bookedOn: '2026-09-10', reference: 'Savings' })

    expect(await balance(from)).toBe(750_00)
    expect(await balance(to)).toBe(250_00)
    expect(transfer.from).toMatchObject({ bankAccountId: from, amountMinor: -250_00, status: 'explained', transferId: transfer.id, reference: 'Savings' })
    expect(transfer.to).toMatchObject({ bankAccountId: to, amountMinor: 250_00, status: 'explained', transferId: transfer.id })
    expect(transfer.from.description).toMatch(/^Transfer to Account /)
    expect((await run('bankAccount.get', { id: from })).unexplainedCount).toBe(0)
  })

  it('is deleted whole, and the balances go back', async () => {
    const from = await account()
    const to = await account()
    const transfer = await run('bankTransfer.create', { fromAccountId: from, toAccountId: to, amountMinor: 100_00, bookedOn: '2026-09-10' })

    // Not one side on its own.
    await expect(run('bankTransaction.delete', { id: transfer.from.id })).rejects.toMatchObject({ code: 'transfer_leg' })
    await expect(run('bankTransaction.update', { id: transfer.to.id, amountMinor: 5_00 })).rejects.toMatchObject({ code: 'transfer_leg' })
    // Words about a line are still the person's to change.
    await run('bankTransaction.update', { id: transfer.to.id, notes: 'Moved for payroll' })

    await run('bankTransfer.delete', { id: transfer.id })
    expect(await balance(from)).toBe(1_000_00)
    expect(await balance(to)).toBe(1_000_00)
    await expect(run('bankTransfer.get', { id: transfer.id })).rejects.toBeInstanceOf(core.NotFoundError)
  })
})

describe('a transfer between currencies', () => {
  it('records what left and what arrived, each in its own currency, and sets both aside', async () => {
    const from = await account('USD')
    const to = await account('AUD', 0)

    await expect(run('bankTransfer.create', { fromAccountId: from, toAccountId: to, amountMinor: 100_00, bookedOn: '2026-09-10' })).rejects.toMatchObject({
      code: 'received_required',
    })
    const transfer = await run('bankTransfer.create', { fromAccountId: from, toAccountId: to, amountMinor: 100_00, receivedMinor: 152_40, bookedOn: '2026-09-10' })

    expect(await balance(from)).toBe(900_00)
    expect(await balance(to)).toBe(152_40)
    expect(transfer.from).toMatchObject({ currency: 'USD', amountMinor: -100_00, status: 'ignored' })
    expect(transfer.to).toMatchObject({ currency: 'AUD', amountMinor: 152_40, status: 'ignored' })
    await expect(run('bankTransaction.unignore', { id: transfer.to.id })).rejects.toMatchObject({ code: 'transfer_leg' })

    await run('bankTransfer.delete', { id: transfer.id })
    expect(await balance(to)).toBe(0)
  })
})

describe('refuses', () => {
  it('the same account twice, nothing, and a day the opening balance already covers', async () => {
    const from = await account()
    const to = await account()
    await expect(run('bankTransfer.create', { fromAccountId: from, toAccountId: from, amountMinor: 1_00, bookedOn: '2026-09-10' })).rejects.toMatchObject({ code: 'same_account' })
    await expect(run('bankTransfer.create', { fromAccountId: from, toAccountId: to, amountMinor: 0, bookedOn: '2026-09-10' })).rejects.toMatchObject({ code: 'amount_not_positive' })
    await expect(run('bankTransfer.create', { fromAccountId: from, toAccountId: to, amountMinor: 1_00, bookedOn: '2026-09-01' })).rejects.toMatchObject({
      code: 'transfer_before_opening',
    })
    await expect(run('bankTransfer.create', { fromAccountId: from, toAccountId: to, amountMinor: 1_00, receivedMinor: 2_00, bookedOn: '2026-09-10' })).rejects.toMatchObject({
      code: 'received_same_currency',
    })
  })

  it('a closed account', async () => {
    const from = await account()
    const to = await account()
    await run('bankAccount.archive', { id: to })
    await expect(run('bankTransfer.create', { fromAccountId: from, toAccountId: to, amountMinor: 1_00, bookedOn: '2026-09-10' })).rejects.toBeInstanceOf(core.DomainError)
  })
})
