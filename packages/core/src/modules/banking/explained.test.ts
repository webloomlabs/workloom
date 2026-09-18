import { describe, expect, it } from 'vitest'
import { explainedStatus, unexplainedMinor } from './explained.ts'

/**
 * The precedence, exhaustively. This function decides whether a line still
 * needs a person, which is the number the whole module is judged on, so every
 * combination is pinned rather than the interesting ones.
 */

const line = (over: Partial<Parameters<typeof explainedStatus>[0]> = {}) => ({
  amountMinor: 1_000,
  matchedMinor: 0,
  ignoredAt: null,
  reconciliationId: null,
  ...over,
})

describe('what state a line is in', () => {
  it('is unexplained until something matches it', () => {
    expect(explainedStatus(line())).toBe('unexplained')
  })

  it('is part explained while some of it is left', () => {
    expect(explainedStatus(line({ matchedMinor: 1 }))).toBe('part_explained')
    expect(explainedStatus(line({ matchedMinor: 999 }))).toBe('part_explained')
  })

  it('is explained once the whole line is accounted for', () => {
    expect(explainedStatus(line({ matchedMinor: 1_000 }))).toBe('explained')
  })

  it('reads a withdrawal by magnitude, not by sign', () => {
    expect(explainedStatus(line({ amountMinor: -1_000, matchedMinor: -400 }))).toBe('part_explained')
    expect(explainedStatus(line({ amountMinor: -1_000, matchedMinor: -1_000 }))).toBe('explained')
  })

  it('is ignored when it was set aside, whatever it was matched to', () => {
    const ignoredAt = new Date('2026-09-16T00:00:00Z')
    expect(explainedStatus(line({ ignoredAt }))).toBe('ignored')
    expect(explainedStatus(line({ ignoredAt, matchedMinor: 400 }))).toBe('ignored')
  })

  it('is reconciled above everything else, because a closed period is history', () => {
    const reconciliationId = '01a0a400-0000-7000-8000-00000000000a'
    expect(explainedStatus(line({ reconciliationId }))).toBe('reconciled')
    expect(explainedStatus(line({ reconciliationId, matchedMinor: 1_000 }))).toBe('reconciled')
    // Ignored, then reconciled: the reconciliation is the statement being made.
    expect(explainedStatus(line({ reconciliationId, ignoredAt: new Date() }))).toBe('reconciled')
  })
})

describe('what is left to explain', () => {
  it('keeps the line’s own sign', () => {
    expect(unexplainedMinor({ amountMinor: 1_000, matchedMinor: 400 })).toBe(600)
    expect(unexplainedMinor({ amountMinor: -1_000, matchedMinor: -400 })).toBe(-600)
    expect(unexplainedMinor({ amountMinor: 1_000, matchedMinor: 1_000 })).toBe(0)
  })
})
