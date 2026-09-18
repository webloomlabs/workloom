/**
 * What a project's billing plan adds up to.
 *
 * Pure, and separate from the procedures, because the arithmetic is the part
 * that has to be right: a plan of 50/40/10 against an odd contracted value must
 * sum to exactly that value, or the final invoice is a cent short and someone
 * has to explain why.
 *
 * The rule that makes it exact: percentages are rounded independently, and
 * **the last pending stage absorbs whatever remains**. Not the first, because
 * the first is usually the advance and is often already billed; not spread,
 * because a cent spread across three invoices is three invoices nobody can
 * reconcile against a contract.
 */

export type StageForTotals = {
  id: string
  position: number
  basis: string
  /** A decimal string, as `numeric` comes back from the driver. */
  percent: string | null
  amountMinor: number | null
  status: string
  releasedAmountMinor: number | null
  /** The status of the invoice this stage raised, when it has one. */
  invoiceStatus: string | null
}

export type PlanTotals = {
  /** What the pending and invoiced stages come to, at today's contracted value. */
  plannedMinor: number
  /** What has actually been billed through the plan. Cancelled invoices do not count. */
  releasedMinor: number
  /** Contracted less released. Null when the project has no agreed total. */
  remainingMinor: number | null
  /** How far the plan over-commits the contract. Zero when it does not. */
  overCommittedMinor: number
  /** What each stage is worth right now, by id. */
  stageAmounts: Map<string, number>
}

/** Rounded half away from zero, once, as every other money conversion here is. */
function shareOf(contractedMinor: number, percent: string): number {
  const exact = (contractedMinor * Number(percent)) / 100
  return Math.sign(exact) * Math.round(Math.abs(exact))
}

/**
 * A stage's invoice no longer counts against the contract once it is cancelled:
 * the money was never demanded, so the headroom comes back without any row
 * changing. A draft still counts -- it exists and is about to be sent.
 */
function counts(stage: StageForTotals): boolean {
  return stage.status === 'invoiced' && stage.invoiceStatus !== 'cancelled'
}

export function planTotals(input: {
  contractedValueMinor: number | null
  stages: readonly StageForTotals[]
}): PlanTotals {
  const contracted = input.contractedValueMinor
  const live = input.stages.filter((s) => s.status !== 'cancelled')
  const ordered = [...live].sort((a, b) => a.position - b.position)

  const stageAmounts = new Map<string, number>()
  for (const stage of ordered) {
    // A released stage is worth what it was worth when it was billed, whatever
    // the contract has done since.
    if (stage.releasedAmountMinor !== null) {
      stageAmounts.set(stage.id, stage.releasedAmountMinor)
      continue
    }
    if (stage.basis === 'amount') {
      stageAmounts.set(stage.id, stage.amountMinor ?? 0)
      continue
    }
    stageAmounts.set(stage.id, contracted === null || stage.percent === null ? 0 : shareOf(contracted, stage.percent))
  }

  // The remainder lands on the last stage still to be billed, and only when the
  // plan is meant to exhaust the contract -- a plan that deliberately covers
  // part of it is not short by the difference.
  const pending = ordered.filter((s) => s.releasedAmountMinor === null)
  const last = pending.at(-1)
  const everyStageIsAShare = ordered.length > 0 && ordered.every((s) => s.basis === 'percent' || s.releasedAmountMinor !== null)
  if (contracted !== null && last && everyStageIsAShare) {
    const shares = ordered.reduce((total, s) => total + (s.percent === null ? 0 : Number(s.percent)), 0)
    if (Math.abs(shares - 100) < 0.0001) {
      const total = ordered.reduce((sum, s) => sum + (stageAmounts.get(s.id) ?? 0), 0)
      stageAmounts.set(last.id, (stageAmounts.get(last.id) ?? 0) + (contracted - total))
    }
  }

  const plannedMinor = ordered.reduce((total, s) => total + (stageAmounts.get(s.id) ?? 0), 0)
  const releasedMinor = input.stages.filter(counts).reduce((total, s) => total + (s.releasedAmountMinor ?? 0), 0)

  return {
    plannedMinor,
    releasedMinor,
    remainingMinor: contracted === null ? null : contracted - releasedMinor,
    overCommittedMinor: contracted === null ? 0 : Math.max(0, plannedMinor - contracted),
    stageAmounts,
  }
}
