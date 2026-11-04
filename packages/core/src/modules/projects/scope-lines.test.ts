import { describe, expect, it } from 'vitest'
import { contractedValue } from './contract.ts'
import { contractScopeLines } from './scope-lines.ts'

describe('the whole project as invoice lines', () => {
  it('lists the original fee and each accepted change, as the agency’s sample does', () => {
    const lines = contractScopeLines({ name: 'Kyla & Co. store development', contractValueMinor: 65_000_00 }, [
      { number: 1, title: 'Gift vouchers and store credits', amountMinor: 5_000_00, status: 'accepted' },
      { number: 2, title: 'Meta Pixel & CAPI setup', amountMinor: 3_000_00, status: 'accepted' },
      { number: 3, title: 'Declined idea', amountMinor: 9_000_00, status: 'declined' },
      { number: 4, title: 'Business email setup', amountMinor: 2_000_00, status: 'accepted' },
      { number: 5, title: 'Additional product adjustments', amountMinor: 5_000_00, status: 'accepted' },
    ])
    expect(lines).toEqual([
      { description: 'Kyla & Co. store development', detail: 'Initially quoted project fee', amountMinor: 65_000_00 },
      { description: 'Gift vouchers and store credits', detail: 'Additional scope', amountMinor: 5_000_00 },
      { description: 'Meta Pixel & CAPI setup', detail: 'Additional scope', amountMinor: 3_000_00 },
      { description: 'Business email setup', detail: 'Additional scope', amountMinor: 2_000_00 },
      { description: 'Additional product adjustments', detail: 'Additional scope', amountMinor: 5_000_00 },
    ])
  })

  it('always adds up to what the project is contracted for', () => {
    // A seeded walk through many plans: random base prices and revisions, some negative, some declined.
    let seed = 7
    const next = () => (seed = (seed * 48271) % 2147483647)
    for (let run = 0; run < 500; run++) {
      const base = next() % 3 === 0 ? null : next() % 10_000_000
      const revisions = Array.from({ length: next() % 6 }, (_, i) => ({
        number: i + 1,
        title: `Change ${i + 1}`,
        amountMinor: (next() % 2_000_000) - 500_000,
        status: ['accepted', 'accepted', 'declined', 'sent'][next() % 4]!,
      }))
      const lines = contractScopeLines({ name: 'Project', contractValueMinor: base }, revisions)
      const sum = lines.reduce((total, l) => total + l.amountMinor, 0)
      expect(sum).toBe(contractedValue(base, revisions) ?? 0)
    }
  })

  it('calls a negative change what it is', () => {
    const [, reduced] = contractScopeLines({ name: 'P', contractValueMinor: 10_00 }, [{ number: 1, title: 'Drop the blog', amountMinor: -2_00, status: 'accepted' }])
    expect(reduced!.detail).toBe('Reduced scope')
  })
})
