import { convert, toSafeNumber } from '../money/money.ts'
import { minorToDecimalString } from '../money/currency.ts'

/**
 * The income tax pack: a year's books, laid out for whoever prepares the
 * return. Pure -- the queries live in the module that builds the pack, and
 * everything here is tested on plain rows.
 *
 * The basis is accrual, in the organization's own currency, before tax:
 *
 * - **Income** is every invoice issued in the year and not cancelled, at its
 *   total less tax. A final invoice that takes an earlier one off ("Already
 *   paid") carries a negative line, so the deposit and the final invoice
 *   together come to the contract once -- never twice.
 * - **Expenses** are confirmed expenses dated in the year, at what they cost:
 *   net, plus tax where the organization cannot reclaim it. Each counts by its
 *   category's treatment: deductible in the year, not deductible (added back),
 *   or capital (claimed through capital allowances instead).
 * - **Cash received** is listed alongside for reconciliation; it does not
 *   change the profit.
 *
 * Foreign-currency amounts are converted at the rate recorded on the document.
 */

export type TaxTreatment = 'deductible' | 'non_deductible' | 'capital'

export type PackInvoice = {
  number: string
  issueDate: string
  client: string
  currency: string
  totalMinor: number
  taxMinor: number
  /** Null for an invoice in the base currency, or one issued before rates were recorded. */
  exchangeRateToBase: string | null
  status: string
}

export type PackExpense = {
  number: string | null
  incurredOn: string
  supplier: string | null
  description: string
  category: string
  categoryName: string
  treatment: TaxTreatment
  currency: string
  amountMinor: number
  taxMinor: number
  /** What it cost in the base currency, tax included where it is not reclaimed. */
  costBaseMinor: number
  receipts: Array<{ filename: string; storageKey: string; contentType: string }>
  project: string | null
}

export type PackPayment = {
  receivedOn: string
  client: string
  method: string
  reference: string | null
  currency: string
  amountMinor: number
  amountBaseMinor: number
  invoices: string
}

export type PackInput = {
  organization: string
  baseCurrency: string
  year: { label: string; from: string; to: string }
  invoices: PackInvoice[]
  expenses: PackExpense[]
  payments: PackPayment[]
  /** Counts the pack warns about rather than includes. */
  draftInvoices: number
  draftExpenses: number
  booksLockedThrough: string | null
  generatedAt: string
}

/** An invoice's income before tax, in the base currency. */
export function incomeBase(invoice: PackInvoice, base: string): number {
  const net = BigInt(invoice.totalMinor - invoice.taxMinor)
  if (invoice.currency === base) return Number(net)
  return toSafeNumber(convert(net, invoice.currency, base, invoice.exchangeRateToBase ?? '1'))
}

export type ProfitAndLoss = {
  income: number
  expensesByCategory: Array<{ category: string; name: string; treatment: TaxTreatment; amount: number; count: number }>
  deductible: number
  nonDeductible: number
  capital: number
  /** Income less every expense charged in the accounts (not capital). */
  accountingProfit: number
  /** Accounting profit with non-deductible expenses added back: the starting point for the return. */
  adjustedProfit: number
}

export function profitAndLoss(input: Pick<PackInput, 'invoices' | 'expenses' | 'baseCurrency'>): ProfitAndLoss {
  const income = input.invoices.reduce((sum, i) => sum + incomeBase(i, input.baseCurrency), 0)
  const byCategory = new Map<string, ProfitAndLoss['expensesByCategory'][number]>()
  for (const e of input.expenses) {
    const row = byCategory.get(e.category) ?? { category: e.category, name: e.categoryName, treatment: e.treatment, amount: 0, count: 0 }
    row.amount += e.costBaseMinor
    row.count += 1
    byCategory.set(e.category, row)
  }
  const expensesByCategory = [...byCategory.values()].sort((a, b) => a.treatment.localeCompare(b.treatment) || b.amount - a.amount)
  const total = (t: TaxTreatment) => expensesByCategory.filter((c) => c.treatment === t).reduce((s, c) => s + c.amount, 0)
  const deductible = total('deductible')
  const nonDeductible = total('non_deductible')
  const capital = total('capital')
  const accountingProfit = income - deductible - nonDeductible
  return { income, expensesByCategory, deductible, nonDeductible, capital, accountingProfit, adjustedProfit: accountingProfit + nonDeductible }
}

export type PackWarning = { code: string; message: string; count: number }

export function packWarnings(input: PackInput): PackWarning[] {
  const warnings: PackWarning[] = []
  const add = (code: string, count: number, message: string) => count > 0 && warnings.push({ code, count, message })
  add('draft_invoices', input.draftInvoices, `${input.draftInvoices} draft invoice(s) dated in the year are not included. Issue or delete them.`)
  add('draft_expenses', input.draftExpenses, `${input.draftExpenses} draft expense(s) dated in the year are not included. Confirm or discard them.`)
  const unreceipted = input.expenses.filter((e) => e.receipts.length === 0).length
  add('missing_receipts', unreceipted, `${unreceipted} expense(s) have no receipt attached. See missing-receipts.csv.`)
  const foreign = input.invoices.filter((i) => i.currency !== input.baseCurrency).length + input.expenses.filter((e) => e.currency !== input.baseCurrency).length
  add('foreign_currency', foreign, `${foreign} item(s) are in another currency, converted at the rate recorded on each.`)
  const unrated = input.invoices.filter((i) => i.currency !== input.baseCurrency && !i.exchangeRateToBase).length
  add('missing_rate', unrated, `${unrated} foreign-currency invoice(s) have no recorded exchange rate and are counted at 1:1. Check them.`)
  if (!input.booksLockedThrough || input.booksLockedThrough < input.year.to) {
    warnings.push({ code: 'books_open', count: 1, message: `The books are not locked through ${input.year.to}, so these figures can still change. Lock them once the year is final.` })
  }
  return warnings
}

// CSV

type Cell = string | number | null
/** Money as a plain decimal: a number to a spreadsheet, never a formula. */
const money = (minor: number, currency: string): Cell => Number(minorToDecimalString(minor, currency))

function field(value: Cell): string {
  if (value === null) return ''
  if (typeof value === 'number') return String(value)
  // Text from clients and suppliers is untrusted: a leading = + - @ would run as a formula.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** CSV that Excel opens correctly: a byte-order mark for UTF-8, and CRLF line ends. */
export function csv(header: string[], rows: Cell[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(field).join(',')).join('\r\n') + '\r\n'
}

const slug = (value: string | null) =>
  (value ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 40) || 'receipt'

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'application/pdf': 'pdf' }

/** EXP-0042_2025-06-14_hostinger.jpg -- sorted by number, readable without opening. */
export function receiptPath(expense: Pick<PackExpense, 'number' | 'incurredOn' | 'supplier' | 'description'>, receipt: { contentType: string }, index: number): string {
  const suffix = index > 0 ? `-${index + 1}` : ''
  return `receipts/${expense.number ?? 'unnumbered'}_${expense.incurredOn}_${slug(expense.supplier ?? expense.description)}${suffix}.${EXTENSIONS[receipt.contentType] ?? 'bin'}`
}

export type PackFile = { path: string; text?: string; storageKey?: string }

/** Every file in the pack but the README, which needs their checksums. */
export function packFiles(input: PackInput): { files: PackFile[]; pnl: ProfitAndLoss; warnings: PackWarning[] } {
  const base = input.baseCurrency
  const pnl = profitAndLoss(input)
  const warnings = packWarnings(input)
  const m = (minor: number) => money(minor, base)

  const pnlRows: Cell[][] = [
    ['Income', 'Fees invoiced', m(pnl.income)],
    ...pnl.expensesByCategory.filter((c) => c.treatment !== 'capital').map((c): Cell[] => [c.treatment === 'deductible' ? 'Expenses' : 'Expenses (not deductible)', c.name, m(-c.amount)]),
    ['Total', 'Deductible expenses', m(-pnl.deductible)],
    ['Total', 'Non-deductible expenses', m(-pnl.nonDeductible)],
    ['Result', 'Profit in the accounts', m(pnl.accountingProfit)],
    ['Adjustment', 'Add back non-deductible expenses', m(pnl.nonDeductible)],
    ['Result', 'Adjusted profit before capital allowances', m(pnl.adjustedProfit)],
    ...pnl.expensesByCategory.filter((c) => c.treatment === 'capital').map((c): Cell[] => ['Capital (allowances)', c.name, m(c.amount)]),
  ]

  const invoiceRows = input.invoices.map((i): Cell[] => [
    i.number,
    i.issueDate,
    i.client,
    i.status,
    i.currency,
    money(i.totalMinor - i.taxMinor, i.currency),
    money(i.taxMinor, i.currency),
    money(i.totalMinor, i.currency),
    i.currency === base ? null : i.exchangeRateToBase,
    m(incomeBase(i, base)),
  ])

  const expenseRows: Cell[][] = []
  const receiptIndex: Cell[][] = []
  const receiptFiles: PackFile[] = []
  for (const e of input.expenses) {
    const paths = e.receipts.map((r, n) => receiptPath(e, r, n))
    e.receipts.forEach((r, n) => {
      receiptFiles.push({ path: paths[n]!, storageKey: r.storageKey })
      receiptIndex.push([e.number, paths[n]!, r.filename])
    })
    expenseRows.push([
      e.number,
      e.incurredOn,
      e.supplier,
      e.description,
      e.categoryName,
      e.treatment,
      e.project,
      e.currency,
      money(e.amountMinor, e.currency),
      money(e.taxMinor, e.currency),
      m(e.costBaseMinor),
      paths.join(' '),
    ])
  }

  const files: PackFile[] = [
    { path: 'profit-and-loss.csv', text: csv(['Section', 'Line', `Amount (${base})`], pnlRows) },
    {
      path: 'revenue-schedule.csv',
      text: csv(['Invoice', 'Issued', 'Client', 'Status', 'Currency', 'Before tax', 'Tax', 'Total', 'Rate to base', `Income (${base})`], invoiceRows),
    },
    {
      path: 'cash-receipts.csv',
      text: csv(
        ['Received', 'Client', 'Method', 'Reference', 'Currency', 'Amount', `Amount (${base})`, 'Invoices'],
        input.payments.map((p) => [p.receivedOn, p.client, p.method, p.reference, p.currency, money(p.amountMinor, p.currency), m(p.amountBaseMinor), p.invoices]),
      ),
    },
    {
      path: 'expense-schedule.csv',
      text: csv(['Expense', 'Date', 'Supplier', 'Description', 'Category', 'Treatment', 'Project', 'Currency', 'Net', 'Tax', `Cost (${base})`, 'Receipts'], expenseRows),
    },
    {
      path: 'expenses-by-category.csv',
      text: csv(['Category', 'Treatment', 'Expenses', `Cost (${base})`], pnl.expensesByCategory.map((c) => [c.name, c.treatment, c.count, m(c.amount)])),
    },
    {
      path: 'missing-receipts.csv',
      text: csv(
        ['Expense', 'Date', 'Supplier', 'Description', `Cost (${base})`],
        input.expenses.filter((e) => e.receipts.length === 0).map((e) => [e.number, e.incurredOn, e.supplier, e.description, m(e.costBaseMinor)]),
      ),
    },
    { path: 'receipts-index.csv', text: csv(['Expense', 'File in this pack', 'Original name'], receiptIndex) },
    ...receiptFiles,
  ]
  return { files, pnl, warnings }
}

/** The README: what the pack is, the headline figures, what to check, and every file's checksum. */
export function packReadme(input: PackInput, pnl: ProfitAndLoss, warnings: PackWarning[], checksums: Array<{ path: string; sha256: string }>): string {
  const amount = (minor: number) => `${input.baseCurrency} ${minorToDecimalString(minor, input.baseCurrency)}`
  return [
    `Income tax pack — ${input.organization}`,
    `Year of assessment ${input.year.label}: ${input.year.from} to ${input.year.to}`,
    `Generated ${input.generatedAt} by Workloom. Accrual basis, in ${input.baseCurrency}, before tax.`,
    '',
    `Income (fees invoiced, before tax)     ${amount(pnl.income)}`,
    `Deductible expenses                    ${amount(pnl.deductible)}`,
    `Non-deductible expenses                ${amount(pnl.nonDeductible)}`,
    `Profit in the accounts                 ${amount(pnl.accountingProfit)}`,
    `Adjusted profit (non-deductible added) ${amount(pnl.adjustedProfit)}`,
    `Capital expenditure (for allowances)   ${amount(pnl.capital)}`,
    '',
    `${input.invoices.length} invoice(s), ${input.expenses.length} expense(s), ${input.payments.length} payment(s) received.`,
    input.booksLockedThrough ? `Books locked through ${input.booksLockedThrough}.` : 'Books not locked.',
    '',
    warnings.length > 0 ? 'Check before filing:' : 'Nothing to check: no drafts, every expense has a receipt.',
    ...warnings.map((w) => `  - ${w.message}`),
    '',
    'Files and their SHA-256 checksums:',
    ...checksums.map((c) => `  ${c.sha256}  ${c.path}`),
    '',
  ].join('\r\n')
}
