/**
 * Taking an earlier invoice off a later one.
 *
 * A deposit invoice demands part of a project's price; the final invoice then
 * states the whole project and subtracts what the deposit already demanded, so
 * the client sees one complete statement and the agency never bills the same
 * money twice: deposit 26,000 + final 54,000 = project 80,000.
 *
 * The deduction is built from the earlier invoice's own priced lines, one
 * negative line per tax it used, each for exactly the taxable amount that
 * invoice charged under that tax. Priced by the same calculator, the tax on the
 * later invoice therefore nets the earlier one out instead of guessing at it.
 * The earlier invoice's deductions are included too, so a chain of progress
 * invoices each deducting the last still adds up.
 *
 * Pure: no database, so the arithmetic is tested on its own.
 */

export type PriorInvoiceLine = {
  /** Net less this line's share of the document discount: what tax was worked out on. */
  taxableMinor: number
  taxRateId: string | null
  taxName: string | null
  taxRate: string | null
}

export type PriorInvoice = {
  id: string
  number: string
  title: string
  taxMode: string
  lines: readonly PriorInvoiceLine[]
}

export type DeductionLine = {
  kind: 'deduction'
  deductsInvoiceId: string
  description: string
  detail: string
  quantity: '1'
  unitAmountMinor: number
  discountPercent: null
  serviceId: null
  taxRateId: string | null
  taxName: string | null
  taxRatePctSnapshot: string | null
}

export class DeductionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'DeductionError'
  }
}

/** The lines that take `prior` off an invoice priced in `taxMode`. */
export function deductionLinesFor(prior: PriorInvoice, taxMode: string): DeductionLine[] {
  if (prior.taxMode !== taxMode) {
    throw new DeductionError(
      `${prior.number} prices tax ${prior.taxMode === 'inclusive' ? 'inclusive' : 'exclusive'}ly and this invoice does not, so its tax cannot be taken off exactly. Match the tax mode first.`,
      'deduction_tax_mode_mismatch',
    )
  }
  const groups = new Map<string, { amount: number; taxRateId: string | null; taxName: string | null; taxRate: string | null }>()
  for (const line of prior.lines) {
    const key = line.taxRateId ?? ''
    const group = groups.get(key) ?? { amount: 0, taxRateId: line.taxRateId, taxName: line.taxName, taxRate: line.taxRate }
    group.amount += line.taxableMinor
    groups.set(key, group)
  }
  const lines: DeductionLine[] = []
  for (const group of groups.values()) {
    if (group.amount === 0) continue
    if (group.amount < 0) {
      throw new DeductionError(`${prior.number} comes to less than nothing, so there is nothing to take off.`, 'deduction_not_positive')
    }
    lines.push({
      kind: 'deduction',
      deductsInvoiceId: prior.id,
      description: prior.title,
      detail: prior.number,
      quantity: '1',
      unitAmountMinor: -group.amount,
      discountPercent: null,
      serviceId: null,
      taxRateId: group.taxRateId,
      taxName: group.taxName,
      taxRatePctSnapshot: group.taxRate,
    })
  }
  if (lines.length === 0) throw new DeductionError(`${prior.number} is for nothing, so there is nothing to take off.`, 'deduction_not_positive')
  return lines
}
