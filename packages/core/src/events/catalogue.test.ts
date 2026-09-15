import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, isValidPattern, matchesAny } from './catalogue.ts'

describe('the event catalogue', () => {
  it('names every event entity.past_tense in snake_case', () => {
    for (const type of EVENT_TYPES) {
      expect(type).toMatch(/^[a-z]+(_[a-z]+)*\.[a-z]+(_[a-z]+)*$/)
    }
  })

  it('contains the types integrations are promised', () => {
    // A tripwire, not a spec. Removing or renaming any of these breaks every
    // automation subscribed to it; this list only ever grows.
    for (const type of [
      'deal.won',
      'invoice.paid',
      'invoice.overdue',
      'payment.recorded',
      'project.completed',
      'member.joined',
      'webhook.test',
    ]) {
      expect(EVENT_TYPES).toContain(type)
    }
  })
})

describe('subscription patterns', () => {
  it('accept exact types, known families, and everything', () => {
    expect(isValidPattern('invoice.paid')).toBe(true)
    expect(isValidPattern('invoice.*')).toBe(true)
    expect(isValidPattern('*')).toBe(true)
  })

  it('reject typos rather than silently never firing', () => {
    expect(isValidPattern('invoice.payed')).toBe(false)
    expect(isValidPattern('invoices.*')).toBe(false)
    expect(isValidPattern('invoice*')).toBe(false)
    expect(isValidPattern('')).toBe(false)
  })

  it('match families without matching lookalike prefixes', () => {
    expect(matchesAny('invoice.paid', ['invoice.*'])).toBe(true)
    expect(matchesAny('invoice_line.created', ['invoice.*'])).toBe(false)
    expect(matchesAny('deal.won', ['invoice.*', 'deal.won'])).toBe(true)
    expect(matchesAny('deal.lost', ['deal.won'])).toBe(false)
    expect(matchesAny('anything.at_all', ['*'])).toBe(true)
  })
})
