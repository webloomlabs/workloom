import type { BANK_TRANSACTION_STATUSES } from '@workloom/db/schema'

/**
 * What state a statement line is in.
 *
 * Derived from what is stored, never set independently -- the same argument
 * `settlementStatus` makes for invoices. Every path that changes a match, and
 * the reconciliation sweep, run this one function, so they cannot disagree
 * about whether a line still needs a person.
 *
 * The precedence is the whole content of the rule:
 *
 *   reconciled  a closed period outranks everything. The line is history.
 *   ignored     set aside deliberately, with a reason.
 *   explained   matched to its full value.
 *   part        matched to some of it.
 *   unexplained nobody has looked at it yet.
 *
 * Note that `ignored` sits *below* reconciled: a line can be ignored and then
 * reconciled, and after that it reads as reconciled, because that is the
 * statement being made about it.
 */
export type ExplainedStatus = (typeof BANK_TRANSACTION_STATUSES)[number]

export function explainedStatus(line: {
  amountMinor: number
  matchedMinor: number
  ignoredAt: Date | null
  reconciliationId: string | null
}): ExplainedStatus {
  if (line.reconciliationId) return 'reconciled'
  if (line.ignoredAt) return 'ignored'
  if (line.matchedMinor === 0) return 'unexplained'
  return Math.abs(line.matchedMinor) >= Math.abs(line.amountMinor) ? 'explained' : 'part_explained'
}

/** What is left to explain, keeping the line's own sign. */
export function unexplainedMinor(line: { amountMinor: number; matchedMinor: number }): number {
  return line.amountMinor - line.matchedMinor
}
