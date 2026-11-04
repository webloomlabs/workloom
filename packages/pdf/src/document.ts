import { Document, Image, Page, StyleSheet, Text, View, type DocumentProps, type Styles } from '@react-pdf/renderer'
import { createElement, type ReactElement } from 'react'
import { FONT_FAMILY, registerFonts } from './fonts.ts'
import type { DocumentPdfInput, DocumentPdfLine, DocumentPdfTotalRow } from './types.ts'

/**
 * The printed form of a quote or an invoice.
 *
 * Everything arrives formatted: amounts as strings in their currency, dates as
 * the organization writes them. This package holds no money or date logic, so
 * what the PDF says and what the screen says cannot drift apart.
 *
 * Written with `createElement` rather than JSX so that the package compiles as
 * plain TypeScript: every consumer -- the web app, the worker, the domain --
 * can then import it without a JSX setting or React types of its own.
 *
 * The layout: issuer and logo top left, the document's kind and number top
 * right; the client beside the figure that matters (the balance due); the
 * lines under a coloured heading; totals ending in a coloured bar; then how to
 * pay, notes and terms, and a footer on every page.
 */

const e = createElement

const DEFAULT_ACCENT = '#0b8a5e'
const INK = '#1f2a24'
const MUTED = '#6b7570'
const RULE = '#e3e7e5'

/** A lighter tint of the accent, for the short band at the top of the page. */
function tint(hex: string, amount = 0.55): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

const styles = StyleSheet.create({
  page: { fontFamily: FONT_FAMILY, fontSize: 9, color: INK, paddingTop: 40, paddingBottom: 56, paddingHorizontal: 44 },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: 6, flexDirection: 'row' },
  between: { flexDirection: 'row', justifyContent: 'space-between' },
  row: { flexDirection: 'row' },
  left: { width: '55%', paddingRight: 16 },
  right: { width: '45%', alignItems: 'flex-end' },
  rightBlock: { width: '45%' },
  logo: { maxHeight: 56, maxWidth: 160, objectFit: 'contain', marginBottom: 12, alignSelf: 'flex-start' },
  issuerName: { fontSize: 14, fontWeight: 700, marginBottom: 4 },
  muted: { color: MUTED },
  mutedLine: { color: MUTED, marginBottom: 2 },
  kind: { fontSize: 28, fontWeight: 700, letterSpacing: 1, color: INK },
  numberRow: { flexDirection: 'row', marginTop: 8 },
  numberLabel: { fontWeight: 700, marginRight: 8 },
  number: { fontWeight: 700 },
  fact: { flexDirection: 'row', marginTop: 4, color: INK },
  factLabel: { marginRight: 6 },
  label: { fontSize: 8, fontWeight: 700, letterSpacing: 0.8, marginBottom: 6 },
  clientName: { fontSize: 13, fontWeight: 700, marginBottom: 4 },
  headlineAmount: { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  marker: { marginTop: 18, padding: 6, backgroundColor: '#f2f4f3', textAlign: 'center', fontWeight: 700, letterSpacing: 2, color: MUTED },
  title: { fontSize: 11, fontWeight: 700, marginTop: 16 },
  table: { marginTop: 20 },
  tableHead: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 10, color: '#ffffff', fontWeight: 700, fontSize: 8, letterSpacing: 0.5 },
  line: { flexDirection: 'row', paddingVertical: 7, paddingHorizontal: 10, borderBottomWidth: 0.75, borderBottomColor: RULE },
  description: { flex: 1, paddingRight: 8 },
  lineTitle: { fontSize: 10, fontWeight: 700 },
  lineSubtitle: { fontSize: 8.5, color: MUTED, marginTop: 2 },
  billing: { width: 92 },
  quantity: { width: 36, textAlign: 'center' },
  unit: { width: 70, textAlign: 'right' },
  discount: { width: 40, textAlign: 'right' },
  tax: { width: 64, paddingLeft: 8 },
  amount: { width: 92, textAlign: 'right' },
  totals: { marginTop: 10, alignSelf: 'flex-end', width: 270 },
  totalRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingVertical: 4, paddingRight: 10 },
  totalLabel: { color: MUTED, fontSize: 10, textAlign: 'right', flex: 1, marginRight: 18 },
  totalAmount: { width: 110, textAlign: 'right', fontSize: 10 },
  bar: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, paddingHorizontal: 12, marginTop: 8, color: '#ffffff', fontWeight: 700, fontSize: 13 },
  after: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 4, paddingRight: 10, fontSize: 8, color: MUTED },
  lower: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 22 },
  lowerLeft: { width: '48%' },
  lowerRight: { width: '46%' },
  detailsBox: { borderWidth: 0.75, borderColor: RULE, borderLeftWidth: 3, paddingVertical: 8, paddingHorizontal: 12 },
  detailRow: { flexDirection: 'row', paddingVertical: 3 },
  detailLabel: { width: 90, color: MUTED },
  detailValue: { flex: 1, fontWeight: 700 },
  paragraph: { color: MUTED, marginBottom: 8 },
  closing: { fontSize: 12, fontWeight: 700, marginTop: 18 },
  footer: { position: 'absolute', bottom: 26, left: 44, right: 44, borderTopWidth: 0.75, borderTopColor: RULE, paddingTop: 8, fontSize: 7.5, color: MUTED },
  footerText: { textAlign: 'center' },
  pageNumber: { position: 'absolute', right: 0, top: 8 },
})

type Style = Styles[string]

const text = (style: Style | Style[], value: string, key?: string | number) => e(Text, { style, key }, value)

function tableRow(input: DocumentPdfInput, cells: Record<'description' | 'billing' | 'quantity' | 'unit' | 'discount' | 'tax' | 'amount', ReactElement | string>) {
  const cell = (style: Style, content: ReactElement | string, key: string) =>
    typeof content === 'string' ? text(style, content, key) : e(View, { style, key }, content)
  return [
    cell(styles.description, cells.description, 'description'),
    input.columns.billing ? cell(styles.billing, cells.billing, 'billing') : null,
    cell(styles.quantity, cells.quantity, 'quantity'),
    input.columns.unitPrice ? cell(styles.unit, cells.unit, 'unit') : null,
    input.columns.discount ? cell(styles.discount, cells.discount, 'discount') : null,
    input.columns.tax ? cell(styles.tax, cells.tax, 'tax') : null,
    cell(styles.amount, cells.amount, 'amount'),
  ]
}

function lineRow(input: DocumentPdfInput, line: DocumentPdfLine, index: number): ReactElement {
  const description = e(
    View,
    {},
    text(styles.lineTitle, line.title),
    line.subtitle ? text(styles.lineSubtitle, line.subtitle) : null,
  )
  return e(
    View,
    { style: styles.line, wrap: false, key: index },
    ...tableRow(input, {
      description,
      billing: line.billing ?? '',
      quantity: line.quantity,
      unit: line.unitAmount ?? '',
      discount: line.discount ?? '',
      tax: line.tax ?? '',
      amount: line.amount,
    }),
  )
}

function totalRow(row: DocumentPdfTotalRow, index: number): ReactElement {
  const strong = row.style === 'strong'
  return e(
    View,
    { style: styles.totalRow, key: index },
    text(styles.totalLabel, row.label),
    text([styles.totalAmount, strong ? { fontWeight: 700 } : {}], row.amount),
  )
}

export function documentElement(input: DocumentPdfInput): ReactElement<DocumentProps> {
  registerFonts()
  const accent = input.accentColor && /^#[0-9a-f]{6}$/i.test(input.accentColor) ? input.accentColor : DEFAULT_ACCENT
  const heading = input.kind === 'invoice' ? 'INVOICE' : 'QUOTE'
  const accentText = { color: accent }

  const band = e(
    View,
    { style: styles.band, fixed: true },
    e(View, { style: { width: '26%', backgroundColor: tint(accent) } }),
    e(View, { style: { flex: 1, backgroundColor: accent } }),
  )

  const issuerDetails = [...(input.issuer.addressLines ?? []), input.issuer.taxNumber, input.issuer.email, input.issuer.phone].filter(Boolean) as string[]
  const header = e(
    View,
    { style: styles.between },
    e(
      View,
      { style: styles.left },
      input.issuer.logo ? e(Image, { style: styles.logo, src: { data: Buffer.from(input.issuer.logo.data), format: input.issuer.logo.format } }) : null,
      text([styles.issuerName, accentText], input.issuer.name),
      ...issuerDetails.map((line, i) => text(styles.mutedLine, line, i)),
    ),
    e(
      View,
      { style: styles.right },
      text(styles.kind, heading),
      input.number
        ? e(View, { style: styles.numberRow }, text(styles.numberLabel, input.kind === 'invoice' ? 'Invoice No.' : 'Quote No.'), text(styles.number, input.number))
        : null,
      ...input.facts.map((fact) => e(View, { style: styles.fact, key: fact.label }, text(styles.factLabel, fact.label), text({}, fact.value))),
    ),
  )

  const clientDetails = [...(input.client.addressLines ?? []), input.client.taxNumber, input.client.email, input.client.phone].filter(Boolean) as string[]
  const parties = e(
    View,
    { style: [styles.between, { marginTop: 24 }] },
    e(
      View,
      { style: styles.left },
      text([styles.label, accentText], input.kind === 'invoice' ? 'BILL TO' : 'PREPARED FOR'),
      text(styles.clientName, input.client.name),
      ...clientDetails.map((line, i) => text(styles.mutedLine, line, i)),
    ),
    input.headline
      ? e(
          View,
          { style: styles.rightBlock },
          text([styles.label, accentText], input.headline.label),
          text([styles.headlineAmount, accentText], input.headline.amount),
          input.headline.caption ? text(styles.muted, input.headline.caption) : null,
        )
      : null,
  )

  const table = e(
    View,
    { style: styles.table },
    e(
      View,
      { style: [styles.tableHead, { backgroundColor: accent }], fixed: true },
      ...tableRow(input, {
        description: 'DESCRIPTION',
        billing: 'BILLING',
        quantity: 'QTY',
        unit: 'UNIT PRICE',
        discount: 'DISC.',
        tax: 'TAX',
        amount: `AMOUNT (${input.currency})`,
      }),
    ),
    ...input.lines.map((line, i) => lineRow(input, line, i)),
  )

  const totals = e(
    View,
    { style: styles.totals, wrap: false },
    ...input.totals.rows.map(totalRow),
    e(View, { style: [styles.bar, { backgroundColor: accent }] }, text({}, input.totals.bar.label), text({}, input.totals.bar.amount)),
    ...(input.totals.after ?? []).map((row, i) => e(View, { style: styles.after, key: `after${i}` }, text({ marginRight: 12 }, row.label), text({}, row.amount))),
  )

  const details = input.paymentDetails ?? []
  const payment =
    details.length > 0 || input.paymentInstructions
      ? e(
          View,
          { style: styles.lowerLeft, wrap: false },
          text([styles.label, accentText], 'PAYMENT DETAILS'),
          e(
            View,
            { style: [styles.detailsBox, { borderLeftColor: accent }] },
            ...details.map((row, i) => e(View, { style: styles.detailRow, key: i }, text(styles.detailLabel, row.label), text(styles.detailValue, row.value))),
            input.paymentInstructions ? text([styles.paragraph, { marginBottom: 0, marginTop: details.length > 0 ? 6 : 0 }], input.paymentInstructions) : null,
          ),
        )
      : e(View, { style: styles.lowerLeft })

  const paragraphs = [input.notes, input.terms].filter((p): p is string => Boolean(p && p.trim()))
  const notes =
    paragraphs.length > 0
      ? e(
          View,
          { style: styles.lowerRight, wrap: false },
          text([styles.label, accentText], 'NOTES AND TERMS'),
          ...paragraphs.flatMap((p, i) => p.split(/\n{2,}/).map((para, j) => text(styles.paragraph, para.trim(), `${i}.${j}`))),
        )
      : null

  return e<DocumentProps>(
    Document,
    { title: `${input.number ?? heading} ${input.title}`, author: input.issuer.name },
    e(
      Page,
      { size: 'A4', style: styles.page },
      band,
      header,
      parties,
      input.marker ? text(styles.marker, input.marker) : null,
      input.kind === 'quote' ? text(styles.title, input.title) : null,
      table,
      totals,
      e(View, { style: styles.lower }, payment, notes),
      input.closing ? text([styles.closing, accentText], input.closing) : null,
      e(
        View,
        { style: styles.footer, fixed: true },
        text(styles.footerText, input.footer ?? `${input.number ? `${input.number} · ` : ''}${input.issuer.name}`),
        e(Text, {
          style: styles.pageNumber,
          render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => (totalPages > 1 ? `${pageNumber} / ${totalPages}` : ''),
        }),
      ),
    ),
  )
}
