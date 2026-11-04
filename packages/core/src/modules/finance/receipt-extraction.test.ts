import { describe, expect, it } from 'vitest'
import { FakeReceiptExtractor, normaliseReading, readReceipt, type ReceiptReading } from './receipt-extraction.ts'

const hints = {
  baseCurrency: 'LKR',
  today: '2026-11-04',
  categories: [
    { key: 'software', name: 'Software' },
    { key: 'travel', name: 'Travel' },
  ],
}

const reading = (patch: Partial<ReceiptReading> = {}): ReceiptReading => ({
  isReceipt: true,
  supplier: 'Hostinger',
  description: 'Web hosting, 12 months',
  date: '2026-10-30',
  currency: 'LKR',
  total: '12,500.00',
  tax: '1,906.78',
  category: 'software',
  paymentMethod: 'card',
  ...patch,
})

describe('normaliseReading', () => {
  it('turns a reading into minor units, a date, and a known category', () => {
    expect(normaliseReading(reading(), hints, 'fake')).toEqual({
      supplier: 'Hostinger',
      description: 'Web hosting, 12 months',
      incurredOn: '2026-10-30',
      currency: 'LKR',
      amountMinor: 1_250_000,
      taxMinor: 190_678,
      category: 'software',
      paymentMethod: 'card',
      reader: 'fake',
    })
  })

  it('reads symbols, spaces, and a decimal comma', () => {
    expect(normaliseReading(reading({ total: 'Rs. 1 250.50' }), hints, 'fake')!.amountMinor).toBe(125_050)
    expect(normaliseReading(reading({ total: '1.250,50', currency: 'EUR' }), hints, 'fake')).toMatchObject({ currency: 'EUR', amountMinor: 125_050 })
  })

  it('drops what it cannot trust rather than guessing', () => {
    const draft = normaliseReading(
      reading({ total: 'about twelve thousand', tax: '99999', date: '2026-12-01', category: 'yachts', paymentMethod: 'barter', currency: 'XXX' }),
      hints,
      'fake',
    )!
    expect(draft).toMatchObject({ amountMinor: null, taxMinor: null, incurredOn: null, category: null, paymentMethod: null, currency: 'LKR' })
  })

  it('refuses impossible dates and ones a decade old', () => {
    expect(normaliseReading(reading({ date: '2026-02-30' }), hints, 'fake')!.incurredOn).toBeNull()
    expect(normaliseReading(reading({ date: '2015-01-01' }), hints, 'fake')!.incurredOn).toBeNull()
    expect(normaliseReading(reading({ date: '30/10/2026' }), hints, 'fake')!.incurredOn).toBeNull()
  })

  it('keeps tax only when it fits inside the total', () => {
    expect(normaliseReading(reading({ total: '100.00', tax: '150.00' }), hints, 'fake')!.taxMinor).toBeNull()
  })

  it('gives nothing for a picture that is not a receipt', () => {
    expect(normaliseReading(reading({ isReceipt: false }), hints, 'fake')).toBeNull()
    expect(normaliseReading(null, hints, 'fake')).toBeNull()
  })
})

describe('readReceipt', () => {
  const jpeg = { bytes: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' }

  it('leaves a blank draft when the reader fails', async () => {
    expect(await readReceipt(jpeg, hints, new FakeReceiptExtractor(new Error('overloaded')))).toBeNull()
  })

  it('does not show a reader what it cannot read', async () => {
    const fake = new FakeReceiptExtractor(reading())
    expect(await readReceipt({ ...jpeg, contentType: 'image/heic' }, hints, fake)).toBeNull()
    expect(fake.calls).toHaveLength(0)
    expect(await readReceipt(jpeg, hints, fake)).toMatchObject({ amountMinor: 1_250_000 })
  })

  it('does nothing with no reader installed', async () => {
    expect(await readReceipt(jpeg, hints, null)).toBeNull()
  })
})
