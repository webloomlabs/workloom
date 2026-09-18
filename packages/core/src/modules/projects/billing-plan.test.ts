import { describe, expect, it } from 'vitest'
import { planTotals, type StageForTotals } from './billing-plan.ts'

/**
 * The arithmetic a client sees on three invoices. Every branch is pinned,
 * because a cent that goes missing here goes missing on a real invoice.
 */

let seq = 0
const stage = (over: Partial<StageForTotals> = {}): StageForTotals => ({
  id: `s${++seq}`,
  position: seq,
  basis: 'amount',
  percent: null,
  amountMinor: null,
  status: 'pending',
  releasedAmountMinor: null,
  invoiceStatus: null,
  ...over,
})

const percent = (p: string, over: Partial<StageForTotals> = {}) => stage({ basis: 'percent', percent: p, ...over })
const amount = (a: number, over: Partial<StageForTotals> = {}) => stage({ basis: 'amount', amountMinor: a, ...over })

describe('planTotals', () => {
  it('splits a round contract exactly', () => {
    const stages = [percent('50', { position: 1 }), percent('40', { position: 2 }), percent('10', { position: 3 })]
    const { stageAmounts, plannedMinor } = planTotals({ contractedValueMinor: 10_000_00, stages })
    expect([...stageAmounts.values()]).toEqual([5_000_00, 4_000_00, 1_000_00])
    expect(plannedMinor).toBe(10_000_00)
  })

  it('gives the rounding remainder to the last stage still to be billed', () => {
    // 50/40/10 of 1,000.01 rounds to 500.01 + 400.00 + 100.00 = 1,000.01 only
    // because the last one absorbs the difference.
    const stages = [percent('50', { position: 1 }), percent('40', { position: 2 }), percent('10', { position: 3 })]
    const { stageAmounts, plannedMinor } = planTotals({ contractedValueMinor: 100_001, stages })
    expect(plannedMinor).toBe(100_001)
    expect([...stageAmounts.values()].reduce((a, b) => a + b, 0)).toBe(100_001)
  })

  it('leaves a mixed plan alone, because it is not meant to exhaust the contract', () => {
    const stages = [amount(2_000_00, { position: 1 }), percent('50', { position: 2 })]
    const { stageAmounts, plannedMinor, overCommittedMinor } = planTotals({ contractedValueMinor: 10_000_00, stages })
    expect([...stageAmounts.values()]).toEqual([2_000_00, 5_000_00])
    expect(plannedMinor).toBe(7_000_00)
    expect(overCommittedMinor).toBe(0)
  })

  it('reports how far a plan over-commits, without refusing it', () => {
    const stages = [amount(8_000_00, { position: 1 }), amount(5_000_00, { position: 2 })]
    const totals = planTotals({ contractedValueMinor: 10_000_00, stages })
    expect(totals.plannedMinor).toBe(13_000_00)
    expect(totals.overCommittedMinor).toBe(3_000_00)
    // Nothing has been billed, so the whole contract is still available.
    expect(totals.remainingMinor).toBe(10_000_00)
  })

  it('counts what has been billed, and what is left of the contract', () => {
    const stages = [
      amount(5_000_00, { position: 1, status: 'invoiced', releasedAmountMinor: 5_000_00, invoiceStatus: 'sent' }),
      amount(5_000_00, { position: 2 }),
    ]
    const totals = planTotals({ contractedValueMinor: 10_000_00, stages })
    expect(totals.releasedMinor).toBe(5_000_00)
    expect(totals.remainingMinor).toBe(5_000_00)
  })

  it('gives the headroom back when the invoice was cancelled', () => {
    const stages = [
      amount(5_000_00, { position: 1, status: 'invoiced', releasedAmountMinor: 5_000_00, invoiceStatus: 'cancelled' }),
      amount(5_000_00, { position: 2 }),
    ]
    const totals = planTotals({ contractedValueMinor: 10_000_00, stages })
    // The money was never demanded, so it never drew on the contract.
    expect(totals.releasedMinor).toBe(0)
    expect(totals.remainingMinor).toBe(10_000_00)
  })

  it('holds a released stage at what it was worth when it was billed', () => {
    // The contract has since grown; the invoice already sent has not.
    const stages = [
      percent('50', { position: 1, status: 'invoiced', releasedAmountMinor: 5_000_00, invoiceStatus: 'sent' }),
      percent('50', { position: 2 }),
    ]
    const { stageAmounts } = planTotals({ contractedValueMinor: 12_000_00, stages })
    expect(stageAmounts.get('s' + (seq - 1))).toBe(5_000_00)
    expect(stageAmounts.get('s' + seq)).toBe(7_000_00)
  })

  it('ignores cancelled stages entirely', () => {
    const stages = [amount(5_000_00, { position: 1 }), amount(3_000_00, { position: 2, status: 'cancelled' })]
    expect(planTotals({ contractedValueMinor: 10_000_00, stages }).plannedMinor).toBe(5_000_00)
  })

  it('has nothing to say about a project with no agreed price', () => {
    const stages = [percent('50', { position: 1 })]
    const totals = planTotals({ contractedValueMinor: null, stages })
    expect(totals.remainingMinor).toBeNull()
    expect(totals.overCommittedMinor).toBe(0)
    // A share of nothing agreed is nothing, not a guess.
    expect([...totals.stageAmounts.values()]).toEqual([0])
  })

  it('handles an empty plan', () => {
    const totals = planTotals({ contractedValueMinor: 10_000_00, stages: [] })
    expect(totals).toMatchObject({ plannedMinor: 0, releasedMinor: 0, remainingMinor: 10_000_00, overCommittedMinor: 0 })
  })
})
