/**
 * How an invoice's bottom line reads, once earlier invoices have been taken
 * off it.
 *
 * An ordinary invoice reads Subtotal, tax, Total. A final invoice that deducts
 * a deposit reads like a statement instead: the whole project, what has
 * already been paid or invoiced, and the balance -- "Project total 80,000 /
 * Already paid -26,000 / Balance Due 54,000". Pure, so the screen, the PDF, and
 * the email cannot disagree about it.
 */

export type TotalsLine = {
  kind: string
  totalMinor: number
  deductsInvoiceId: string | null
  deductionSettled: boolean | null
}

export type TotalsInput = {
  totalMinor: number
  amountPaidMinor: number
  lines: readonly TotalsLine[]
}

export type PresentedDeduction = {
  invoiceId: string
  /** What it took off, as a positive amount including its tax. */
  amountMinor: number
  /** Paid in full when this invoice was issued; null while this one is a draft. */
  settled: boolean | null
}

export type PresentedTotals = {
  /** True when earlier invoices are taken off, so the totals read as a statement. */
  statement: boolean
  /** What the billed lines come to, before anything is taken off. */
  itemsTotalMinor: number
  deductions: PresentedDeduction[]
  /** What is still to pay on this invoice. */
  balanceDueMinor: number
  /**
   * What the client has already paid towards what this invoice states: the
   * deductions that were settled, and anything paid on this invoice itself.
   * Printed as "After payment received of ...". Zero when there is none.
   */
  receivedMinor: number
}

export function presentTotals(invoice: TotalsInput): PresentedTotals {
  let itemsTotalMinor = 0
  const deductions = new Map<string, PresentedDeduction>()
  for (const line of invoice.lines) {
    if (line.kind === 'deduction' && line.deductsInvoiceId) {
      const entry = deductions.get(line.deductsInvoiceId) ?? { invoiceId: line.deductsInvoiceId, amountMinor: 0, settled: line.deductionSettled }
      entry.amountMinor -= line.totalMinor
      deductions.set(line.deductsInvoiceId, entry)
    } else {
      itemsTotalMinor += line.totalMinor
    }
  }
  const list = [...deductions.values()]
  const settled = list.filter((d) => d.settled === true).reduce((sum, d) => sum + d.amountMinor, 0)
  return {
    statement: list.length > 0,
    itemsTotalMinor,
    deductions: list,
    balanceDueMinor: invoice.totalMinor - invoice.amountPaidMinor,
    receivedMinor: settled + invoice.amountPaidMinor,
  }
}
