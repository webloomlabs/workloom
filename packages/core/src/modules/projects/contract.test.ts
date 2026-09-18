import { describe, expect, it } from 'vitest'
import { acceptedRevisionsMinor, contractedValue } from './contract.ts'

/**
 * The function the whole revisions slice hangs on: it decides what a billing
 * plan may draw against, so every branch is pinned rather than the interesting
 * ones.
 */

const revision = (status: string, amountMinor: number) => ({ status, amountMinor })

describe('acceptedRevisionsMinor', () => {
  it('counts only what was accepted', () => {
    expect(
      acceptedRevisionsMinor([
        revision('accepted', 2_000_00),
        revision('sent', 5_000_00),
        revision('draft', 9_000_00),
        revision('declined', 7_000_00),
        revision('withdrawn', 3_000_00),
      ]),
    ).toBe(2_000_00)
  })

  it('subtracts a descope', () => {
    expect(acceptedRevisionsMinor([revision('accepted', 2_000_00), revision('accepted', -500_00)])).toBe(1_500_00)
  })

  it('is nothing when there are no revisions', () => {
    expect(acceptedRevisionsMinor([])).toBe(0)
  })
})

describe('contractedValue', () => {
  it('is the agreed price plus everything accepted since', () => {
    expect(contractedValue(10_000_00, [revision('accepted', 2_000_00)])).toBe(12_000_00)
    expect(contractedValue(10_000_00, [])).toBe(10_000_00)
  })

  it('ignores revisions that are not accepted', () => {
    expect(contractedValue(10_000_00, [revision('sent', 2_000_00), revision('declined', 4_000_00)])).toBe(10_000_00)
  })

  it('stays null for a project that was never given a price', () => {
    // Not zero: "no agreed total" and "an agreed total of nothing" are
    // different, and only the second should let a billing plan draw on it.
    expect(contractedValue(null, [])).toBeNull()
    expect(contractedValue(null, [revision('sent', 2_000_00)])).toBeNull()
  })

  it('takes a price from accepted revisions alone, when that is all there is', () => {
    // A project that started open-ended and had one agreed change is contracted
    // for that change, whatever else remains loose.
    expect(contractedValue(null, [revision('accepted', 2_000_00)])).toBe(2_000_00)
  })

  it('reads a price of zero as a price', () => {
    expect(contractedValue(0, [])).toBe(0)
    expect(contractedValue(0, [revision('accepted', 1_000_00)])).toBe(1_000_00)
  })
})
