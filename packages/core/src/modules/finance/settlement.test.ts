import { describe, expect, it } from 'vitest'
import { paidAt, settlementEvent, settlementStatus, type Settlement, type SettlementStatus } from './settlement.ts'

/**
 * The invoice status table.
 *
 * These are the states a client and an accountant both read off the invoice, so
 * each combination is spelled out rather than derived -- if one of these
 * changes, it is a product decision, not a refactor.
 */

const base: Settlement = {
  totalMinor: 330_00,
  amountPaidMinor: 0,
  refundedMinor: 0,
  dueDate: '2026-03-31',
  viewed: false,
  today: '2026-03-01',
}

const at = (patch: Partial<Settlement>) => settlementStatus({ ...base, ...patch })

describe('what an issued invoice reads as', () => {
  const cases: Array<[string, Partial<Settlement>, SettlementStatus]> = [
    ['issued, unopened, not yet due', {}, 'sent'],
    ['opened by the client', { viewed: true }, 'viewed'],
    ['part paid', { amountPaidMinor: 100_00 }, 'partially_paid'],
    ['paid to the cent', { amountPaidMinor: 330_00 }, 'paid'],
    ['overpaid', { amountPaidMinor: 400_00 }, 'paid'],
    ['a cent short', { amountPaidMinor: 329_99 }, 'partially_paid'],
    ['past its due date', { today: '2026-04-01' }, 'overdue'],
    ['due today is not yet late', { today: '2026-03-31' }, 'sent'],
    ['part paid and late', { amountPaidMinor: 100_00, today: '2026-04-01' }, 'overdue'],
    ['paid late is paid, not overdue', { amountPaidMinor: 330_00, today: '2026-06-01' }, 'paid'],
    ['opened and late', { viewed: true, today: '2026-04-01' }, 'overdue'],
    ['no due date never goes late', { dueDate: null, today: '2030-01-01' }, 'sent'],
    ['paid, then fully refunded', { amountPaidMinor: 0, refundedMinor: 330_00 }, 'refunded'],
    ['refunded stays refunded once late', { amountPaidMinor: 0, refundedMinor: 330_00, today: '2026-04-01' }, 'refunded'],
    ['part of a payment refunded, some still owing', { amountPaidMinor: 230_00, refundedMinor: 100_00 }, 'partially_paid'],
    ['refunded down to nothing owing', { amountPaidMinor: 330_00, refundedMinor: 50_00 }, 'paid'],
    ['an invoice asking for nothing', { totalMinor: 0 }, 'paid'],
  ]

  it.each(cases)('%s', (_name, patch, expected) => {
    expect(at(patch)).toBe(expected)
  })

  it('is the same answer however many times it is asked', () => {
    // The sweep runs nightly over invoices it has already swept.
    const settled = { ...base, today: '2026-04-01' }
    expect(settlementStatus(settled)).toBe(settlementStatus(settled))
  })
})

describe('what a change of status announces', () => {
  it('announces reaching a settled state', () => {
    expect(settlementEvent('sent', 'partially_paid')).toBe('invoice.partially_paid')
    expect(settlementEvent('partially_paid', 'paid')).toBe('invoice.paid')
    expect(settlementEvent('viewed', 'overdue')).toBe('invoice.overdue')
    expect(settlementEvent('paid', 'refunded')).toBe('invoice.refunded')
  })

  it('says nothing when the status did not move', () => {
    // The nightly sweep depends on this: an invoice already overdue is not
    // announced overdue again every night.
    expect(settlementEvent('overdue', 'overdue')).toBeNull()
    expect(settlementEvent('paid', 'paid')).toBeNull()
  })

  it('says nothing for going back to merely sent or opened', () => {
    expect(settlementEvent('partially_paid', 'sent')).toBeNull()
    expect(settlementEvent('overdue', 'viewed')).toBeNull()
  })
})

describe('when it was paid', () => {
  const now = new Date('2026-03-10T00:00:00Z')
  const earlier = new Date('2026-03-02T00:00:00Z')

  it('is the moment it was first settled in full', () => {
    expect(paidAt('paid', null, now)).toBe(now)
  })

  it('does not move once set', () => {
    expect(paidAt('paid', earlier, now)).toBe(earlier)
  })

  it('survives a refund, which does not unmake the fact', () => {
    expect(paidAt('refunded', earlier, now)).toBe(earlier)
  })

  it('is cleared if the invoice owes something again', () => {
    expect(paidAt('partially_paid', earlier, now)).toBeNull()
    expect(paidAt('overdue', earlier, now)).toBeNull()
  })
})
