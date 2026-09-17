import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'

/**
 * Getting the data out.
 *
 * The header line of every export is asserted here, deliberately and by hand.
 * Somebody will build a spreadsheet on one of these files, and a column that
 * moves because a field was renamed breaks it silently. Changing one of these
 * assertions should feel like a decision, because it is one.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let modules: typeof import('../src/modules/index.ts')
let registry: typeof import('../src/registry/index.ts')

const ORG = '01a0ee00-0000-7000-8000-00000000000a'
let ownerId: string
let developerId: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')

  ownerId = core.newId()
  developerId = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`insert into organization (id, name, slug, base_currency, timezone) values (${ORG}::uuid, 'Org', 'exp', 'AUD', 'UTC')`)
    await db.execute(sql`
      insert into "user" (id, name, email) values
        (${ownerId}::uuid, 'Owner', 'e-owner@example.com'),
        (${developerId}::uuid, 'Dev', 'e-dev@example.com')`)
    await db.execute(sql`
      insert into member (id, organization_id, user_id, role) values
        (${core.newId()}::uuid, ${ORG}::uuid, ${ownerId}::uuid, 'owner'),
        (${core.newId()}::uuid, ${ORG}::uuid, ${developerId}::uuid, 'developer')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'developer'
const as = (role: Role) => ({
  organizationId: ORG,
  actor: { type: 'user' as const, id: role === 'owner' ? ownerId : developerId, label: role },
  role,
  permissions: core.permissionsForRole(role),
})

function run<T = any>(name: string, input: unknown, role: Role = 'owner'): Promise<T> {
  return registry.executeProcedure(name, { ...as(role), input }) as Promise<T>
}

const csv = async (resource: string, role: Role = 'owner') => {
  const result = await run('export.run', { resource }, role)
  return modules.toCsv(result.columns, result.rows)
}
const headerOf = async (resource: string) => (await csv(resource)).split('\r\n')[0]

describe('the columns of every export', () => {
  // The contract. Not generated from the catalogue: a test that derives its
  // expectation from the thing it is testing asserts nothing.
  const headers: Array<[string, string]> = [
    ['companies', 'id,name,lifecycleStage,email,phone,website,city,country,archivedAt,createdAt'],
    ['contacts', 'id,firstName,lastName,email,phone,title,companyId,companyName,archivedAt,createdAt'],
    ['leads', 'id,contactName,companyName,email,phone,source,status,convertedAt,createdAt'],
    ['deals', 'id,name,companyId,companyName,stage,currency,value,expectedCloseDate,closedAt,createdAt'],
    ['projects', 'id,name,companyId,companyName,status,startDate,dueDate,currency,budget,completedAt,createdAt'],
    ['tasks', 'id,title,projectId,projectName,status,priority,assigneeName,dueDate,estimateMinutes,completedAt,createdAt'],
    ['time-entries', 'id,spentOn,userName,projectId,projectName,taskTitle,description,durationSeconds,billable,invoiced,currency,billableRate,costRate'],
    ['invoices', 'id,number,companyId,companyName,status,issueDate,dueDate,currency,subtotal,discount,tax,total,amountPaid,amountDue'],
    ['payments', 'id,receivedOn,companyId,companyName,kind,method,reference,currency,amount,allocated,unallocated'],
    ['expenses', 'id,incurredOn,description,supplier,category,projectId,projectName,companyId,companyName,currency,amount,tax,billable,invoiceNumber'],
  ]

  it('names every resource in the catalogue', () => {
    expect([...modules.EXPORT_RESOURCES].sort()).toEqual(headers.map(([name]) => name).sort())
  })

  it.each(headers)('%s', async (resource, expected) => {
    expect(await headerOf(resource)).toBe(expected)
  })
})

describe('what a row looks like', () => {
  it('writes an amount as a decimal in its own currency, not in cents', async () => {
    const companyId = (await run('company.create', { name: 'Harbour' })).id
    const invoice = await run('invoice.create', {
      companyId,
      title: 'Design work',
      lines: [{ description: 'Design', unitAmountMinor: 1234_56 }],
    })
    await run('invoice.send', { id: invoice.id })

    const line = (await csv('invoices')).split('\r\n')[1]!
    // Nobody wants to divide a column by 100 before they can sum it, and every
    // amount carries its currency's places whether or not it needs them.
    expect(line).toContain(',AUD,1234.56,0.00,0.00,1234.56,0.00,1234.56')
  })

  it('quotes a field holding a comma, and doubles an inner quote', async () => {
    await run('company.create', { name: 'Smith, Jones & Co ("SJ")' })
    expect(await csv('companies')).toContain('"Smith, Jones & Co (""SJ"")"')
  })

  it('defuses a field a spreadsheet would run as a formula', async () => {
    // A lead form is open to the internet, so this is a real path from a
    // stranger's keyboard to a macro on somebody's machine.
    await run('lead.create', { contactName: '=HYPERLINK("http://evil.example")', companyName: 'Injected' })
    const out = await csv('leads')
    expect(out).toContain(`"'=HYPERLINK(""http://evil.example"")"`)
    expect(out).not.toContain(',=HYPERLINK')
  })

  it('writes an empty cell for a missing value, not "null"', async () => {
    await run('company.create', { name: 'No details' })
    const rows = (await csv('companies')).split('\r\n')
    // name, stage, then empty email and phone -- not the word "null".
    expect(rows.some((r) => r.includes('No details,prospect,,,'))).toBe(true)
  })

  it('ends every line the way a spreadsheet expects', async () => {
    const out = await csv('companies')
    expect(out.endsWith('\r\n')).toBe(true)
  })
})

describe('who may export what', () => {
  it('refuses a resource the role cannot read', async () => {
    // A developer reads companies but not invoices, and the export follows the
    // same permission as reading the collection any other way.
    await expect(run('export.run', { resource: 'companies' }, 'developer')).resolves.toBeTruthy()
    await expect(run('export.run', { resource: 'invoices' }, 'developer')).rejects.toBeInstanceOf(core.ForbiddenError)
    await expect(run('export.run', { resource: 'payments' }, 'developer')).rejects.toBeInstanceOf(core.ForbiddenError)
  })

  it('refuses a resource that does not exist', async () => {
    await expect(run('export.run', { resource: 'salaries' })).rejects.toThrow()
  })

  it('exports only the acting organization', async () => {
    const rows = (await run('export.run', { resource: 'companies' })).rows as Array<{ name: string }>
    // Everything in this file was created in ORG; nothing else is visible.
    expect(rows.length).toBeGreaterThan(0)
    const { rows: all } = await mod.withoutTenant('test: count every company', (db) =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from companies where organization_id <> ${ORG}::uuid`),
    )
    expect(all[0]!.n).toBe(0)
  })
})
