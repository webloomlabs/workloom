import { describe, expect, it } from 'vitest'
import { csv, incomeBase, packFiles, packReadme, packWarnings, profitAndLoss, receiptPath, type PackExpense, type PackInput, type PackInvoice } from './tax-pack.ts'

const invoice = (patch: Partial<PackInvoice> = {}): PackInvoice => ({
  number: 'WL-2025-0001',
  issueDate: '2025-06-01',
  client: 'Kyla & Co.',
  currency: 'LKR',
  totalMinor: 26_000_00,
  taxMinor: 0,
  exchangeRateToBase: null,
  status: 'paid',
  ...patch,
})

const expense = (patch: Partial<PackExpense> = {}): PackExpense => ({
  number: 'EXP-0042',
  incurredOn: '2025-06-14',
  supplier: 'Hostinger',
  description: 'Hosting',
  category: 'software',
  categoryName: 'Software',
  treatment: 'deductible',
  currency: 'LKR',
  amountMinor: 12_500_00,
  taxMinor: 0,
  costBaseMinor: 12_500_00,
  receipts: [{ filename: 'IMG_1.jpg', storageKey: 'k1', contentType: 'image/jpeg' }],
  project: null,
  ...patch,
})

const input = (patch: Partial<PackInput> = {}): PackInput => ({
  organization: 'Webloom Labs (Pvt) Ltd',
  baseCurrency: 'LKR',
  year: { label: '2025/26', from: '2025-04-01', to: '2026-03-31' },
  invoices: [],
  expenses: [],
  payments: [],
  draftInvoices: 0,
  draftExpenses: 0,
  booksLockedThrough: '2026-03-31',
  generatedAt: '2026-11-04T06:00:00.000Z',
  ...patch,
})

describe('profitAndLoss', () => {
  it('counts a deposit and the statement that takes it off once', () => {
    // 26,000 deposit, then a final invoice of 80,000 less the 26,000 already paid.
    const pnl = profitAndLoss({ baseCurrency: 'LKR', invoices: [invoice(), invoice({ number: 'WL-2026-0144', totalMinor: 54_000_00 })], expenses: [] })
    expect(pnl.income).toBe(80_000_00)
  })

  it('takes income before tax, and converts a foreign invoice at its own rate', () => {
    expect(incomeBase(invoice({ totalMinor: 118_00, taxMinor: 18_00 }), 'LKR')).toBe(100_00)
    expect(incomeBase(invoice({ currency: 'USD', totalMinor: 100_00, exchangeRateToBase: '300.5' }), 'LKR')).toBe(30_050_00)
  })

  it('keeps capital apart, and adds back what is not deductible', () => {
    const pnl = profitAndLoss({
      baseCurrency: 'LKR',
      invoices: [invoice({ totalMinor: 100_000_00 })],
      expenses: [
        expense(),
        expense({ category: 'entertainment', categoryName: 'Entertainment', treatment: 'non_deductible', costBaseMinor: 5_000_00 }),
        expense({ category: 'hardware', categoryName: 'Hardware', treatment: 'capital', costBaseMinor: 300_000_00 }),
      ],
    })
    expect(pnl).toMatchObject({ income: 100_000_00, deductible: 12_500_00, nonDeductible: 5_000_00, capital: 300_000_00, accountingProfit: 82_500_00, adjustedProfit: 87_500_00 })
  })
})

describe('packWarnings', () => {
  it('names drafts, missing receipts, foreign money, and open books', () => {
    const warnings = packWarnings(
      input({
        draftExpenses: 2,
        expenses: [expense({ receipts: [] }), expense({ currency: 'USD' })],
        invoices: [invoice({ currency: 'USD', exchangeRateToBase: null })],
        booksLockedThrough: null,
      }),
    )
    expect(warnings.map((w) => w.code)).toEqual(['draft_expenses', 'missing_receipts', 'foreign_currency', 'missing_rate', 'books_open'])
  })

  it('is quiet when the year is clean and locked', () => {
    expect(packWarnings(input({ expenses: [expense()], invoices: [invoice()] }))).toEqual([])
  })
})

describe('the files', () => {
  it('opens in Excel and never runs a formula', () => {
    const text = csv(['Supplier', 'Amount'], [['=HYPERLINK("x")', -12.5], ['Smith, Jones', 3]])
    expect(text.startsWith('﻿')).toBe(true)
    expect(text).toContain(`"'=HYPERLINK(""x"")",-12.5\r\n`)
    expect(text).toContain('"Smith, Jones",3')
  })

  it('names receipts by number, date, and supplier', () => {
    expect(receiptPath(expense(), { contentType: 'image/jpeg' }, 0)).toBe('receipts/EXP-0042_2025-06-14_hostinger.jpg')
    expect(receiptPath(expense({ supplier: 'Café Ü & Co' }), { contentType: 'application/pdf' }, 1)).toBe('receipts/EXP-0042_2025-06-14_cafe-u-co-2.pdf')
  })

  it('lists every schedule, and the receipts to fetch', () => {
    const built = packFiles(input({ invoices: [invoice()], expenses: [expense(), expense({ number: 'EXP-0043', receipts: [] })] }))
    expect(built.files.map((f) => f.path)).toEqual([
      'profit-and-loss.csv',
      'revenue-schedule.csv',
      'cash-receipts.csv',
      'expense-schedule.csv',
      'expenses-by-category.csv',
      'missing-receipts.csv',
      'receipts-index.csv',
      'receipts/EXP-0042_2025-06-14_hostinger.jpg',
    ])
    expect(built.files.find((f) => f.path === 'missing-receipts.csv')!.text).toContain('EXP-0043')
    const pnl = built.files[0]!.text!
    expect(pnl).toContain('Income,Fees invoiced,26000')
    expect(pnl).toContain('Expenses,Software,-25000')
  })

  it('writes a README with the figures and checksums', () => {
    const built = packFiles(input({ invoices: [invoice()] }))
    const readme = packReadme(input({ invoices: [invoice()] }), built.pnl, built.warnings, [{ path: 'profit-and-loss.csv', sha256: 'ab'.repeat(32) }])
    expect(readme).toContain('Year of assessment 2025/26: 2025-04-01 to 2026-03-31')
    expect(readme).toContain('Income (fees invoiced, before tax)     LKR 26000.00')
    expect(readme).toContain(`${'ab'.repeat(32)}  profit-and-loss.csv`)
  })
})
