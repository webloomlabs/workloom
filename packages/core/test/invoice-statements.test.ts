import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'
import { extractText, getDocumentProxy } from 'unpdf'

/**
 * The invoice as the agency prints it (S14): numbers like WL-2026-0144 that
 * restart each year, an invoice due "At launch", and a final invoice that
 * states the whole project and takes the deposit off it -- without the
 * deposit ever being counted twice.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')
let pdf: typeof import('@workloom/pdf')

const ORG = '01a0aa00-0000-7000-8000-0000000014aa'
let owner: string

beforeAll(async () => {
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')
  pdf = await import('@workloom/pdf')
  owner = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`
      insert into organization (id, name, slug, base_currency, timezone, legal_name, billing_address, fiscal_year_start_month, date_format) values
        (${ORG}::uuid, 'Webloom', 'webloom-s14', 'LKR', 'Asia/Colombo', 'Webloom Labs (Pvt) Ltd', E'No. 400/A, Sellakanda Road,\\nNegombo, Sri Lanka.', 4, 'D MMMM YYYY')`)
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}::uuid, 'Owner', 's14-owner@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values (${core.newId()}::uuid, ${ORG}::uuid, ${owner}::uuid, 'owner')`)
  })
})

afterAll(async () => {
  await mod?.closePool()
  await database?.stop()
})

const actor = () => ({
  organizationId: ORG,
  actor: { type: 'user' as const, id: owner, label: 'owner' },
  role: 'owner' as const,
  permissions: core.permissionsForRole('owner'),
})

function run<T = any>(name: string, input: unknown, now?: Date): Promise<T> {
  return registry.executeProcedure(name, { ...actor(), input, ...(now ? { now } : {}) }) as Promise<T>
}

/** Expects the database itself to refuse: the message is on the driver's error, under the query library's. */
async function databaseRefuses(write: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await write.then(
    () => null,
    (e: unknown) => e as { message: string; cause?: { message?: string } },
  )
  expect(error, 'the write should have been refused').not.toBeNull()
  expect(`${error!.message} ${error!.cause?.message ?? ''}`).toMatch(pattern)
}

/** Expects the procedure to refuse, with this code. */
async function refused(name: string, input: unknown, code: string, now?: Date): Promise<void> {
  await expect(run(name, input, now)).rejects.toMatchObject({ code })
}

const unique = () => core.newId().slice(-8)
const company = async (input: Record<string, unknown> = {}) => (await run('company.create', { name: `Client ${unique()}`, ...input })).id as string

async function sweep(now: Date) {
  return mod.withTenant(ORG, (tx) =>
    modules.markOverdueInvoices(registry.buildContext({ organizationId: ORG, actor: { type: 'job', label: 'overdue' }, role: null, permissions: new Set(), now }, tx)),
  )
}

async function pdfText(invoiceId: string): Promise<string> {
  const rendered = await modules.renderInvoicePdf(ORG, invoiceId)
  const document = await getDocumentProxy(new Uint8Array(rendered!.bytes))
  const { text } = await extractText(document, { mergePages: true })
  return text.replace(/\s+/g, ' ')
}

describe('numbering', () => {
  it('prints numbers in the agency format, restarting each calendar year from the issue date', async () => {
    await run('documentSequence.update', { kind: 'quote', format: 'WQ-{YYYY}-{NNNN}', reset: 'yearly' })
    const companyId = await company()
    const issue = async (issueDate: string) => {
      const quote = await run('quote.create', { companyId, title: `Quote ${unique()}`, validUntil: '2030-12-31', lines: [{ description: 'Work', unitAmountMinor: 100_00 }] })
      return (await run('quote.send', { id: quote.id, issueDate })).number as string
    }
    expect(await issue('2026-12-30')).toBe('WQ-2026-0001')
    expect(await issue('2026-12-31')).toBe('WQ-2026-0002')
    expect(await issue('2027-01-01')).toBe('WQ-2027-0001')
    // Backdated into last year: last year's run, not this one.
    expect(await issue('2026-11-15')).toBe('WQ-2026-0003')
    expect(await issue('2027-01-02')).toBe('WQ-2027-0002')
  })

  it('restarts with the financial year when told to, and prints it', async () => {
    await run('documentSequence.update', { kind: 'ticket', format: 'T{FY}-{NNN}', reset: 'fiscal_yearly' })
    const list = await run('documentSequence.list', {}, new Date('2026-03-31T12:00:00Z'))
    const ticket = list.data.find((s: any) => s.kind === 'ticket')
    // 31 March is the last day of the 2025/26 year when it starts in April.
    expect(ticket.nextNumber).toBe('T2025-26-001')
    expect(ticket.scope).toBe('FY2025')
    const april = await run('documentSequence.list', {}, new Date('2026-04-01T12:00:00Z'))
    expect(april.data.find((s: any) => s.kind === 'ticket').nextNumber).toBe('T2026-27-001')
  })

  it('starts an existing agency part-way through the year, but never onto a number already issued', async () => {
    const now = new Date('2026-10-27T05:00:00Z')
    const set = await run('documentSequence.update', { kind: 'invoice', format: 'WL-{YYYY}-{NNNN}', reset: 'yearly', nextValue: 143 }, now)
    expect(set.nextNumber).toBe('WL-2026-0143')

    const companyId = await company()
    const invoice = await run('invoice.create', { companyId, title: 'Deposit', lines: [{ description: 'Deposit', unitAmountMinor: 100_00 }] }, now)
    expect((await run('invoice.send', { id: invoice.id }, now)).number).toBe('WL-2026-0143')

    // Moving the count back onto 143 would issue it twice.
    await refused('documentSequence.update', { kind: 'invoice', nextValue: 140 }, 'number_taken', now)
    await refused('documentSequence.update', { kind: 'invoice', nextValue: 143 }, 'number_taken', now)
    // Forward is fine.
    expect((await run('documentSequence.update', { kind: 'invoice', nextValue: 144 }, now)).nextNumber).toBe('WL-2026-0144')
  })

  it('refuses a format that would repeat numbers, or that has no counter', async () => {
    await refused('documentSequence.update', { kind: 'quote', format: 'Q-{NNNN}', reset: 'yearly' }, 'format_year')
    await refused('documentSequence.update', { kind: 'quote', format: 'Q-{YYYY}' }, 'format_counter')
    await refused('documentSequence.update', { kind: 'quote', format: 'Q-{MM}-{NNNN}' }, 'format_token')
  })

  it('hands out numbers without gaps or repeats when issued at once', async () => {
    await run('documentSequence.update', { kind: 'invoice', format: 'P-{YYYY}-{NNNN}', reset: 'yearly' })
    const companyId = await company()
    const drafts = await Promise.all(
      Array.from({ length: 8 }, () => run('invoice.create', { companyId, title: `Race ${unique()}`, lines: [{ description: 'Work', unitAmountMinor: 10_00 }] })),
    )
    const numbers = (await Promise.all(drafts.map((d) => run('invoice.send', { id: d.id, issueDate: '2031-06-01' })))).map((i) => i.number).sort()
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, i) => `P-2031-${String(i + 1).padStart(4, '0')}`))
  })
})

describe('an invoice due at launch', () => {
  it('is issued without a due date, is not overdue, and is given its date once', async () => {
    const companyId = await company()
    const invoice = await run('invoice.create', {
      companyId,
      title: 'Balance at launch',
      dueLabel: 'At launch',
      lines: [{ description: 'Balance', unitAmountMinor: 54_000_00 }],
    })
    const sent = await run('invoice.send', { id: invoice.id, issueDate: '2026-01-10' })
    expect(sent.dueDate).toBeNull()
    expect(sent.dueLabel).toBe('At launch')

    // Months later, nothing has launched: it is not late.
    await sweep(new Date('2026-09-01T00:00:00Z'))
    expect((await run('invoice.get', { id: invoice.id })).status).toBe('sent')

    await refused('invoice.setDueDate', { id: invoice.id, dueDate: '2026-01-01' }, 'due_before_issue')
    const dated = await run('invoice.setDueDate', { id: invoice.id, dueDate: '2026-02-01' })
    expect(dated.dueDate).toBe('2026-02-01')
    await sweep(new Date('2026-09-01T00:00:00Z'))
    expect((await run('invoice.get', { id: invoice.id })).status).toBe('overdue')

    // The date, once given, is as fixed as any other issued date.
    await refused('invoice.setDueDate', { id: invoice.id, dueDate: '2026-03-01' }, 'due_date_fixed')
  })

  it('keeps an ordinary invoice to its terms, and refuses to date one that was never due on an event', async () => {
    const invoice = await run('invoice.create', { companyId: await company(), title: 'Terms', paymentTermsDays: 7, lines: [{ description: 'Work', unitAmountMinor: 10_00 }] })
    const sent = await run('invoice.send', { id: invoice.id, issueDate: '2026-05-01' })
    expect(sent.dueDate).toBe('2026-05-08')
    await refused('invoice.setDueDate', { id: invoice.id, dueDate: '2026-06-01' }, 'due_date_fixed')
  })

  it('takes an explicit due date at issue', async () => {
    const invoice = await run('invoice.create', { companyId: await company(), title: 'Fixed', lines: [{ description: 'Work', unitAmountMinor: 10_00 }] })
    expect((await run('invoice.send', { id: invoice.id, issueDate: '2026-05-01', dueDate: '2026-05-31' })).dueDate).toBe('2026-05-31')
  })
})

describe('a final invoice that takes the deposit off', () => {
  /** The Kyla & Co. project: 65,000 quoted, 15,000 of extra scope, a 26,000 deposit paid. */
  async function kyla() {
    const companyId = await company({ website: 'https://kylaandcoclothing.com/' })
    const project = await run('project.create', { companyId, name: `Kyla & Co. store ${unique()}`, currency: 'LKR' })
    const deposit = await run('invoice.create', {
      companyId,
      projectId: project.id,
      title: 'Kyla & Co. store development — deposit',
      lines: [{ description: 'Deposit', unitAmountMinor: 26_000_00, billingType: 'one_off' }],
    })
    await run('invoice.send', { id: deposit.id, issueDate: '2026-08-01' })
    const final = await run('invoice.create', {
      companyId,
      projectId: project.id,
      title: 'Kyla & Co. store development',
      dueLabel: 'At launch',
      lines: [
        { description: 'Kyla & Co. store development', detail: 'Initially quoted project fee', billingType: 'one_off', unitAmountMinor: 65_000_00 },
        { description: 'Gift vouchers and store credits', detail: 'Additional scope', billingType: 'one_off', unitAmountMinor: 5_000_00 },
        { description: 'Meta Pixel & CAPI setup', detail: 'Additional scope', billingType: 'one_off', unitAmountMinor: 3_000_00 },
        { description: 'Business email setup', detail: 'Additional scope', billingType: 'one_off', unitAmountMinor: 2_000_00 },
        { description: 'Additional product adjustments', detail: 'Additional scope', billingType: 'one_off', unitAmountMinor: 5_000_00 },
      ],
    })
    return { companyId, project, deposit, final }
  }

  it('states the whole project, takes off what was paid, and demands only the rest', async () => {
    const { companyId, project, deposit, final } = await kyla()
    await run('payment.record', { companyId, amountMinor: 26_000_00, receivedOn: '2026-08-05', allocations: [{ invoiceId: deposit.id }] })

    const withDeduction = await run('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: deposit.id })
    expect(withDeduction.totalMinor).toBe(54_000_00)
    expect(withDeduction.totals).toMatchObject({ statement: true, itemsTotalMinor: 80_000_00, balanceDueMinor: 54_000_00, receivedMinor: 26_000_00 })
    expect(withDeduction.totals.deductions).toEqual([{ invoiceId: deposit.id, number: deposit.number ?? expect.any(String), amountMinor: 26_000_00, settled: true }])

    const sent = await run('invoice.send', { id: final.id, issueDate: '2026-10-27' })
    expect(sent.lines.filter((l: any) => l.kind === 'deduction').map((l: any) => l.deductionSettled)).toEqual([true])

    const text = await pdfText(final.id)
    for (const expected of [
      sent.number,
      '27 October 2026',
      'At launch',
      'kylaandcoclothing.com',
      'BALANCE DUE',
      'After payment received of LKR 26,000.00',
      'AMOUNT (LKR)',
      'Initially quoted project fee',
      'One-time',
      'Project total',
      'LKR 80,000.00',
      'Already paid',
      '– LKR 26,000.00',
      'LKR 54,000.00',
    ]) {
      expect(text).toContain(expected)
    }

    await run('payment.record', { companyId, amountMinor: 54_000_00, receivedOn: '2026-11-01', allocations: [{ invoiceId: final.id }] })
    expect((await run('invoice.get', { id: final.id })).status).toBe('paid')

    // Revenue is the project's price, once: 26,000 + 54,000.
    const revenue = await run('report.revenue', { from: '2026-01-01', to: '2026-12-31', companyId })
    expect(revenue.currencies.find((c: any) => c.currency === 'LKR').billedMinor).toBe(80_000_00)
    const financials = await run('project.financials', { id: project.id })
    expect(financials.currencies.find((c: any) => c.currency === 'LKR').billedMinor).toBe(80_000_00)
  })

  it('says "previously invoiced" when the deposit had not been paid, and the deposit can then not be cancelled', async () => {
    const { deposit, final } = await kyla()
    await run('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: deposit.id })
    const sent = await run('invoice.send', { id: final.id })
    expect(sent.totals.deductions[0].settled).toBe(false)
    expect(sent.totals.receivedMinor).toBe(0)
    expect(await pdfText(final.id)).toContain(`Previously invoiced (${deposit.number ?? (await run('invoice.get', { id: deposit.id })).number})`)

    // Cancelling the deposit now would credit the client for money never asked for twice.
    await refused('invoice.cancel', { id: deposit.id }, 'invoice_deducted')
    await run('invoice.cancel', { id: final.id })
    await run('invoice.cancel', { id: deposit.id })
  })

  it('takes one deposit off one invoice only', async () => {
    const { companyId, deposit, final } = await kyla()
    await run('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: deposit.id })
    await refused('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: deposit.id }, 'deduction_duplicate')

    const second = await run('invoice.create', { companyId, title: 'Another final', lines: [{ description: 'Again', unitAmountMinor: 80_000_00 }] })
    await run('invoiceLine.addDeduction', { id: second.id, deductsInvoiceId: deposit.id })
    await run('invoice.send', { id: final.id })
    // Both drafts could take it off; only the first issued does.
    await refused('invoice.send', { id: second.id }, 'deduction_already_used')
  })

  it('refuses what would not add up: drafts, other clients, itself, discounts, and more than the invoice', async () => {
    const { companyId, final } = await kyla()
    const unissued = await run('invoice.create', { companyId, title: 'Not yet', lines: [{ description: 'Work', unitAmountMinor: 1_00 }] })
    await refused('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: unissued.id }, 'deduction_not_issued')
    await refused('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: final.id }, 'deduction_self')

    const other = await run('invoice.create', { companyId: await company(), title: 'Other client', lines: [{ description: 'Work', unitAmountMinor: 1_00 }] })
    await run('invoice.send', { id: other.id })
    await refused('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: other.id }, 'deduction_company_mismatch')

    const big = await run('invoice.create', { companyId, title: 'Big deposit', lines: [{ description: 'Deposit', unitAmountMinor: 100_000_00 }] })
    await run('invoice.send', { id: big.id })
    await run('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: big.id })
    await refused('invoice.update', { id: final.id, discountPercent: '10' }, 'deduction_with_discount')
    await refused('invoice.send', { id: final.id }, 'deductions_exceed_total')

    // Removing the deduction removes all of it, and the invoice adds up again.
    const draft = await run('invoice.get', { id: final.id })
    const line = draft.lines.find((l: any) => l.kind === 'deduction')
    await refused('invoiceLine.update', { id: line.id, description: 'Edited' }, 'deduction_not_editable')
    const cleared = await run('invoiceLine.remove', { id: line.id })
    expect(cleared.totalMinor).toBe(80_000_00)
    expect(cleared.totals.statement).toBe(false)
  })

  it('nets the deposit tax out exactly, rate by rate', async () => {
    const companyId = await company()
    const vat = (await run('taxRate.create', { name: `VAT ${unique()}`, rate: '18' })).id
    const deposit = await run('invoice.create', {
      companyId,
      title: 'Deposit with tax',
      discountPercent: '10',
      lines: [
        { description: 'Taxed', unitAmountMinor: 10_000_00, taxRateId: vat },
        { description: 'Untaxed', unitAmountMinor: 3_333_33 },
      ],
    })
    const issued = await run('invoice.send', { id: deposit.id })
    const final = await run('invoice.create', {
      companyId,
      title: 'Final with tax',
      lines: [
        { description: 'Taxed scope', unitAmountMinor: 50_000_00, taxRateId: vat },
        { description: 'Untaxed scope', unitAmountMinor: 20_000_00 },
      ],
    })
    const before = final.totalMinor
    const after = await run('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: deposit.id })
    // One deduction line per tax the deposit used.
    expect(after.lines.filter((l: any) => l.kind === 'deduction')).toHaveLength(2)
    // What is taken off is what the deposit charged, give or take the rounding of one tax total.
    expect(Math.abs(before - after.totalMinor - issued.totalMinor)).toBeLessThanOrEqual(1)
    expect(after.totals.itemsTotalMinor).toBe(before)
  })

  it('cannot change a deduction once issued, at the database', async () => {
    const { deposit, final } = await kyla()
    await run('invoiceLine.addDeduction', { id: final.id, deductsInvoiceId: deposit.id })
    await run('invoice.send', { id: final.id })
    await databaseRefuses(
      mod.withTenant(ORG, (tx) => tx.execute(sql`update invoice_lines set deduction_settled = true where invoice_id = ${final.id}::uuid and kind = 'deduction'`)),
      /only while the invoice is a draft/,
    )
    await databaseRefuses(mod.withTenant(ORG, (tx) => tx.execute(sql`update invoices set due_label = 'Soon' where id = ${final.id}::uuid`)), /can no longer change/)
    // A due date given once, while it was due on an event, is as fixed as any other.
    await mod.withTenant(ORG, (tx) => tx.execute(sql`update invoices set due_date = '2026-12-01' where id = ${final.id}::uuid`))
    await databaseRefuses(
      mod.withTenant(ORG, (tx) => tx.execute(sql`update invoices set due_date = '2027-01-01' where id = ${final.id}::uuid`)),
      /can no longer change/,
    )
  })
})

describe('branding on the printed invoice', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

  it('prints the logo, the bank details, and the footer the organization set', async () => {
    await run('organization.update', {
      brandColor: '#0B8A5E',
      paymentDetails: [
        { label: 'Account Name', value: 'M A M S Ilham' },
        { label: 'Account Number', value: '93389900' },
        { label: 'Bank', value: 'Bank of Ceylon (BOC)' },
        { label: 'Branch', value: 'Kaduruwela' },
      ],
      documentFooter: 'This is a computer-generated invoice and is valid without a signature.',
      invoiceNotesDefault: 'Please quote the invoice number as the payment reference.',
    })
    const org = await run('organization.uploadLogo', { file: new File([png], 'logo.png', { type: 'image/png' }) })
    expect(org.hasLogo).toBe(true)
    expect(org.brandColor).toBe('#0b8a5e')

    const invoice = await run('invoice.create', { companyId: await company(), title: 'Branded', lines: [{ description: 'Work', unitAmountMinor: 10_00 }] })
    expect(invoice.notes).toBe('Please quote the invoice number as the payment reference.')
    const rendered = await modules.renderInvoicePdf(ORG, invoice.id)
    expect(rendered!.bytes.toString('latin1')).toContain('/Subtype /Image')
    const text = await pdfText(invoice.id)
    expect(text).toContain('PAYMENT DETAILS')
    expect(text).toContain('93389900')
    expect(text).toContain('Webloom Labs (Pvt) Ltd · This is a computer-generated invoice')
    expect(text).toContain('Please quote the invoice number')
  })

  it('refuses a logo that is not a PNG or JPEG, whatever it is called', async () => {
    const html = new File(['<html><script>alert(1)</script></html>'], 'logo.png', { type: 'image/png' })
    await refused('organization.uploadLogo', { file: html }, 'file_type')
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' })
    await refused('organization.uploadLogo', { file: svg }, 'file_type')
    await expect(run('organization.update', { paymentDetails: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: 'v' })) })).rejects.toThrow(/eight/)
  })

  it('renders an invoice whose logo has gone missing from storage, without it', async () => {
    await mod.withoutTenant('break the logo', (db) => db.execute(sql`update organization set logo_key = ${`${ORG}/branding/missing`} where id = ${ORG}::uuid`))
    const invoice = await run('invoice.create', { companyId: await company(), title: 'No logo', lines: [{ description: 'Work', unitAmountMinor: 10_00 }] })
    expect((await modules.renderInvoicePdf(ORG, invoice.id))!.bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf).toBeDefined()
  })
})
