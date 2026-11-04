import { deflateSync } from 'node:zlib'
import { extractText, getDocumentProxy } from 'unpdf'
import { describe, expect, it } from 'vitest'
import { renderDocumentPdf, type DocumentPdfInput } from './index.ts'

/** The text a reader would copy out of the PDF, every page joined. */
async function textOf(pdf: Buffer): Promise<string> {
  const document = await getDocumentProxy(new Uint8Array(pdf))
  const { text } = await extractText(document, { mergePages: true })
  return text.replace(/\s+/g, ' ')
}

/** A 2×2 PNG, built by hand so the test needs no image file. */
function tinyPng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolour
  const raw = Buffer.from([0, 11, 138, 94, 11, 138, 94, 0, 11, 138, 94, 11, 138, 94])
  return new Uint8Array(
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  )
}

/** The final invoice from the agency's sample: the whole project, less the deposit already paid. */
const statement: DocumentPdfInput = {
  kind: 'invoice',
  number: 'WL-2026-0144',
  title: 'Kyla & Co. store development',
  issuer: { name: 'Webloom Labs (Pvt) Ltd', addressLines: ['No. 400/A, Sellakanda Road,', 'Negombo, Sri Lanka.'], logo: { data: tinyPng(), format: 'png' } },
  client: { name: 'Kyla & Co.', addressLines: ['kylaandcoclothing.com'] },
  facts: [
    { label: 'Date', value: '27 October 2026' },
    { label: 'Due', value: 'At launch' },
  ],
  accentColor: '#0b8a5e',
  headline: { label: 'BALANCE DUE', amount: 'LKR 54,000.00', caption: 'After payment received of LKR 26,000.00' },
  currency: 'LKR',
  columns: { billing: true, unitPrice: false, discount: false, tax: false },
  taxIncluded: false,
  lines: [
    { title: 'Kyla & Co. store development', subtitle: 'Initially quoted project fee', billing: 'One-time', quantity: '1', amount: '65,000.00' },
    { title: 'Gift vouchers and store credits', subtitle: 'Additional scope', billing: 'One-time', quantity: '1', amount: '5,000.00' },
    { title: 'Meta Pixel & CAPI setup', subtitle: 'Additional scope', billing: 'One-time', quantity: '1', amount: '3,000.00' },
    { title: 'Business email setup', subtitle: 'Additional scope', billing: 'One-time', quantity: '1', amount: '2,000.00' },
    { title: 'Additional product adjustments', subtitle: 'Additional scope', billing: 'One-time', quantity: '1', amount: '5,000.00' },
  ],
  totals: {
    rows: [
      { label: 'Project total', amount: 'LKR 80,000.00', style: 'strong' },
      { label: 'Already paid', amount: '– LKR 26,000.00' },
    ],
    bar: { label: 'Balance Due', amount: 'LKR 54,000.00' },
  },
  paymentDetails: [
    { label: 'Account Name', value: 'M A M S Ilham' },
    { label: 'Account Number', value: '93389900' },
    { label: 'Bank', value: 'Bank of Ceylon (BOC)' },
    { label: 'Branch', value: 'Kaduruwela' },
  ],
  notes: 'Please quote invoice number WL-2026-0144 as the payment reference and share the transfer slip once payment has been made.',
  terms: 'The LKR 26,000.00 deposit has been deducted. The remaining LKR 54,000.00 is payable at launch.',
  closing: 'Thank you for your business.',
  footer: 'Webloom Labs (Pvt) Ltd · This is a computer-generated invoice and is valid without a signature.',
}

/** An ordinary taxed invoice with every optional column. */
const taxed: DocumentPdfInput = {
  kind: 'invoice',
  number: 'INV-0001',
  title: 'Website rebuild',
  issuer: { name: 'Webloom Labs', addressLines: ['1 Harbour St', 'Sydney NSW 2000'], taxNumber: 'ABN 12 345 678 901' },
  client: { name: 'Harbour Co', addressLines: ['200 George St', 'Sydney'] },
  facts: [
    { label: 'Date', value: '16 Sept 2026' },
    { label: 'Due', value: '30 Sept 2026' },
  ],
  currency: 'AUD',
  columns: { billing: false, unitPrice: true, discount: true, tax: true },
  taxIncluded: false,
  lines: [
    { title: 'Design — Ελληνικά, Привет, ümlaut', quantity: '12.5', unitAmount: '150.00', tax: 'GST 10%', amount: '1,875.00' },
    { title: 'Hosting setup', quantity: '1', unitAmount: '300.00', discount: '10%', amount: '270.00' },
  ],
  totals: {
    rows: [
      { label: 'Subtotal', amount: '$2,145.00' },
      { label: 'Discount (10%)', amount: '-$214.50' },
      { label: 'GST 10%', amount: '$168.75' },
    ],
    bar: { label: 'Total', amount: '$2,099.25' },
  },
  paymentInstructions: 'Transfer to BSB 000-000, account 1234567.',
  notes: 'Thanks for the work.',
}

describe('the document renderer', () => {
  it.skipIf(!process.env.PDF_PREVIEW_DIR)('writes previews for a person to look at', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${process.env.PDF_PREVIEW_DIR}/statement.pdf`, await renderDocumentPdf(statement))
    writeFileSync(`${process.env.PDF_PREVIEW_DIR}/taxed.pdf`, await renderDocumentPdf(taxed))
  })

  it('produces a PDF with its fonts embedded', async () => {
    const pdf = await renderDocumentPdf(taxed)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(2000)
    // A font programme is embedded, so no reader has to substitute one.
    expect(pdf.toString('latin1')).toContain('FontFile')
  })

  it("prints a final invoice the way the agency's sample does", async () => {
    const pdf = await renderDocumentPdf(statement)
    const text = await textOf(pdf)
    for (const expected of [
      'INVOICE',
      'Invoice No.',
      'WL-2026-0144',
      '27 October 2026',
      'At launch',
      'BILL TO',
      'Kyla & Co.',
      'kylaandcoclothing.com',
      'BALANCE DUE',
      'After payment received of LKR 26,000.00',
      'DESCRIPTION',
      'BILLING',
      'AMOUNT (LKR)',
      'Initially quoted project fee',
      'Additional scope',
      'One-time',
      'Project total',
      'LKR 80,000.00',
      'Already paid',
      '– LKR 26,000.00',
      'Balance Due',
      'LKR 54,000.00',
      'PAYMENT DETAILS',
      'Account Number',
      '93389900',
      'Bank of Ceylon (BOC)',
      'NOTES AND TERMS',
      'Thank you for your business.',
      'computer-generated invoice',
    ]) {
      expect(text).toContain(expected)
    }
    // Everything fits on one page, as the sample does.
    expect(/\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]).toBe('1')
    // The logo is drawn, not fetched.
    expect(pdf.toString('latin1')).toContain('/Subtype /Image')
  })

  it('prints the optional columns only when asked', async () => {
    const withColumns = await textOf(await renderDocumentPdf(taxed))
    expect(withColumns).toContain('UNIT PRICE')
    expect(withColumns).toContain('TAX')
    expect(withColumns).not.toContain('BILLING')
    expect(withColumns).toContain('Transfer to BSB 000-000')
    const statementText = await textOf(await renderDocumentPdf(statement))
    expect(statementText).not.toContain('UNIT PRICE')
  })

  it('renders a draft quote with no number and a marker', async () => {
    const pdf = await renderDocumentPdf({ ...taxed, kind: 'quote', number: null, marker: 'DRAFT' })
    const text = await textOf(pdf)
    expect(text).toContain('QUOTE')
    expect(text).toMatch(/D ?R ?A ?F ?T/)
    expect(text).toContain('PREPARED FOR')
  })

  it('renders many lines across pages, numbering them', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({ title: `Line ${i + 1}`, quantity: '1', amount: '10.00' }))
    const pdf = await renderDocumentPdf({ ...statement, lines })
    const pages = /\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]
    expect(Number(pages)).toBeGreaterThan(1)
    expect(await textOf(pdf)).toContain('Line 80')
  })

  it('falls back to its own accent when given something that is not a colour', async () => {
    const pdf = await renderDocumentPdf({ ...statement, accentColor: 'url(http://example.com)' })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
