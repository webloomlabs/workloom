import { describe, expect, it } from 'vitest'
import { categoryNamed, combineDrafts, disagreeingCategories, parseExpenseText } from './expense-from-message.ts'
import type { ReceiptDraft } from './receipt-extraction.ts'

const hints = {
  baseCurrency: 'LKR',
  today: '2026-11-04',
  categories: [
    { key: 'software', name: 'Software and subscriptions' },
    { key: 'travel', name: 'Travel' },
    { key: 'hosting', name: 'Hosting' },
    { key: 'other', name: 'Other' },
  ],
}

const parse = (text: string) => parseExpenseText(text, hints)

describe('a typed expense', () => {
  it('takes the amount and leaves the rest as the description', () => {
    expect(parse('1500 taxi to the client')).toEqual({
      supplier: null,
      description: 'Taxi to the client',
      incurredOn: null,
      currency: 'LKR',
      amountMinor: 150_000,
      taxMinor: null,
      category: null,
      paymentMethod: null,
      reader: 'message',
    })
    expect(parse('Lunch with Acme 3,200.50')).toMatchObject({ description: 'Lunch with Acme', amountMinor: 320_050 })
    expect(parse('spent 2k on printing')).toMatchObject({ description: 'Printing', amountMinor: 200_000 })
  })

  it('reads a currency beside the amount, written or as a symbol', () => {
    expect(parse('USD 20 Figma')).toMatchObject({ currency: 'USD', amountMinor: 2000, description: 'Figma' })
    expect(parse('Figma 20usd')).toMatchObject({ currency: 'USD', amountMinor: 2000 })
    expect(parse('Rs. 1500 tea')).toMatchObject({ currency: 'LKR', amountMinor: 150_000, description: 'Tea' })
    expect(parse('$12.99 domain')).toMatchObject({ currency: 'USD', amountMinor: 1299 })
    expect(parse('tea 1500/-')).toMatchObject({ currency: 'LKR', amountMinor: 150_000 })
  })

  it('does not take an ordinary word for a currency', () => {
    // "all" is the Albanian lek's code, but here it is a word.
    expect(parse('all 3 coffees 900')).toMatchObject({ currency: 'LKR', amountMinor: 90_000, description: 'All 3 coffees' })
  })

  it('prefers the amount with a currency, then the largest number', () => {
    expect(parse('2 coffees LKR 900')).toMatchObject({ amountMinor: 90_000, description: '2 coffees' })
    expect(parse('2 coffees 900')).toMatchObject({ amountMinor: 90_000 })
  })

  it('takes the day and the category from the line', () => {
    expect(parse('1500 taxi yesterday #travel')).toMatchObject({ incurredOn: '2026-11-03', category: 'travel', description: 'Taxi' })
    expect(parse('Hosting renewal 12500 2026-10-30')).toMatchObject({ incurredOn: '2026-10-30', category: 'hosting', description: 'Hosting renewal' })
    // Not a day after today.
    expect(parse('1500 taxi 2026-12-01')?.incurredOn).toBeNull()
  })

  it('is no expense without an amount', () => {
    expect(parse('thanks!')).toBeNull()
    expect(parse('ok')).toBeNull()
    expect(parse('0 taxi')).toBeNull()
  })
})

describe('the category a caption names', () => {
  it('is a tag, a key, or a name, never Other', () => {
    expect(categoryNamed('#travel', hints.categories)).toBe('travel')
    expect(categoryNamed('trip to Kandy, travel', hints.categories)).toBe('travel')
    expect(categoryNamed('Software and subscriptions for October', hints.categories)).toBe('software')
    expect(categoryNamed('other stuff', hints.categories)).toBeNull()
    // Two named is no answer.
    expect(categoryNamed('travel and hosting', hints.categories)).toBeNull()
  })
})

const draft = (patch: Partial<ReceiptDraft> = {}): ReceiptDraft => ({
  supplier: 'Uber',
  description: 'Taxi',
  incurredOn: '2026-11-01',
  currency: 'LKR',
  amountMinor: 150_000,
  taxMinor: null,
  category: 'travel',
  paymentMethod: 'card',
  reader: 'fake',
  ...patch,
})

describe('several receipts as one expense', () => {
  it('adds up the amounts and keeps what each one said', () => {
    const drafts = [draft(), draft({ supplier: 'PickMe', amountMinor: 90_000, incurredOn: '2026-11-03' }), draft({ amountMinor: 60_000, incurredOn: '2026-10-30' })]
    const combined = combineDrafts(drafts, { currency: 'LKR' })!
    expect(combined).toMatchObject({
      amountMinor: 300_000,
      supplier: null,
      description: 'Taxi',
      incurredOn: '2026-11-03',
      category: 'travel',
      paymentMethod: 'card',
      currency: 'LKR',
    })
    expect(combined.receipts).toEqual(drafts)
  })

  it('names the suppliers when the receipts are for different things', () => {
    const combined = combineDrafts([draft({ description: 'Taxi' }), draft({ supplier: 'PickMe', description: 'Ride' })], { currency: 'LKR' })!
    expect(combined.description).toBe('2 receipts: Uber, PickMe')
  })

  it('files under what most were read as, unless the sender named one', () => {
    const drafts = [draft(), draft({ category: 'software' }), draft()]
    expect(combineDrafts(drafts, { currency: 'LKR' })!.category).toBe('travel')
    expect(combineDrafts(drafts, { currency: 'LKR', category: 'software' })!.category).toBe('software')
    expect(disagreeingCategories(drafts)).toEqual(['travel', 'software'])
    expect(disagreeingCategories([draft(), draft()])).toEqual([])
  })

  it('adds up what could be read, and adds tax only when every receipt gave it', () => {
    const combined = combineDrafts([draft({ taxMinor: 10_000 }), draft({ amountMinor: null }), null], { currency: 'LKR' })!
    expect(combined.amountMinor).toBe(150_000)
    expect(combined.taxMinor).toBe(10_000)
    expect(combineDrafts([draft({ taxMinor: 10_000 }), draft()], { currency: 'LKR' })!.taxMinor).toBeNull()
  })

  it('is nothing when none could be read', () => {
    expect(combineDrafts([null, null], { currency: 'LKR' })).toBeNull()
  })
})
