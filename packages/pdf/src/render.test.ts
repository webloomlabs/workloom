import { describe, expect, it } from 'vitest'
import { renderDocumentPdf, type DocumentPdfInput } from './index.ts'

/** The renderer runs in plain Node and embeds its font, so every reader sees the same page. */
const input: DocumentPdfInput = {
  kind: 'invoice',
  number: 'INV-0001',
  title: 'Website rebuild',
  issuer: { name: 'Webloom Labs', addressLines: ['1 Harbour St', 'Sydney NSW 2000'], taxNumber: 'ABN 12 345 678 901' },
  client: { name: 'Harbour Co', addressLines: ['200 George St', 'Sydney'] },
  facts: [
    { label: 'Issued', value: '16 Sept 2026' },
    { label: 'Due', value: '30 Sept 2026' },
  ],
  taxIncluded: false,
  lines: [
    { description: 'Design — Ελληνικά, Привет, ümlaut', quantity: '12.5', unitAmount: '$150.00', tax: 'GST 10%', amount: '$1,875.00' },
    { description: 'Hosting setup', quantity: '1', unitAmount: '$300.00', discount: '10%', amount: '$270.00' },
  ],
  totals: {
    subtotal: '$2,145.00',
    discount: { label: 'Discount (10%)', amount: '-$214.50' },
    taxes: [{ label: 'GST 10%', amount: '$168.75' }],
    total: '$2,099.25',
    extras: [{ label: 'Amount due', amount: '$2,099.25' }],
  },
  paymentInstructions: 'Transfer to BSB 000-000, account 1234567.',
  notes: 'Thanks for the work.',
}

describe('the document renderer', () => {
  it('produces a PDF with the document embedded and its fonts subsetted', async () => {
    const pdf = await renderDocumentPdf(input)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(2000)
    // A font programme is embedded, so no reader has to substitute one.
    expect(pdf.toString('latin1')).toContain('FontFile')
  })

  it('renders a draft quote with no number and a marker', async () => {
    const pdf = await renderDocumentPdf({ ...input, kind: 'quote', number: null, marker: 'DRAFT' })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('renders many lines across pages', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({ description: `Line ${i + 1}`, quantity: '1', unitAmount: '$10.00', amount: '$10.00' }))
    const pdf = await renderDocumentPdf({ ...input, lines })
    const pages = /\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]
    expect(Number(pages)).toBeGreaterThan(1)
  })
})
