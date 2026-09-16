import { Document, Page, StyleSheet, Text, View, type DocumentProps, type Styles } from '@react-pdf/renderer'
import { createElement, type ReactElement } from 'react'
import { FONT_FAMILY, registerFonts } from './fonts.ts'
import type { DocumentParty, DocumentPdfInput } from './types.ts'

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
 */

const e = createElement

const styles = StyleSheet.create({
  page: { fontFamily: FONT_FAMILY, fontSize: 9, color: '#1c1c1c', paddingTop: 40, paddingBottom: 56, paddingHorizontal: 40 },
  row: { flexDirection: 'row' },
  between: { flexDirection: 'row', justifyContent: 'space-between' },
  headerRight: { alignItems: 'flex-end', maxWidth: 220 },
  kind: { fontSize: 22, fontWeight: 700, letterSpacing: 1 },
  number: { fontSize: 11, fontWeight: 700, marginTop: 2 },
  party: { maxWidth: 260 },
  partyName: { fontSize: 12, fontWeight: 700, marginBottom: 3 },
  muted: { color: '#6b6b6b' },
  marker: { marginTop: 14, padding: 6, backgroundColor: '#f2f2f2', textAlign: 'center', fontWeight: 700, letterSpacing: 2 },
  section: { marginTop: 22 },
  label: { fontSize: 8, fontWeight: 700, color: '#6b6b6b', letterSpacing: 1, marginBottom: 4 },
  title: { fontSize: 13, fontWeight: 700 },
  factLabel: { color: '#6b6b6b', marginRight: 8 },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1c1c1c', paddingBottom: 4, marginBottom: 2, fontWeight: 700, fontSize: 8 },
  line: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#dddddd', paddingVertical: 5 },
  description: { flex: 1, paddingRight: 8 },
  quantity: { width: 46, textAlign: 'right' },
  unit: { width: 72, textAlign: 'right' },
  discount: { width: 46, textAlign: 'right' },
  tax: { width: 78, paddingLeft: 8 },
  amount: { width: 78, textAlign: 'right' },
  totals: { marginTop: 12, alignSelf: 'flex-end', width: 240 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  grandTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#1c1c1c',
    marginTop: 4,
    fontSize: 12,
    fontWeight: 700,
  },
  note: { marginTop: 18, maxWidth: 380, lineHeight: 1.5 },
  footer: { position: 'absolute', bottom: 28, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between', color: '#6b6b6b', fontSize: 8 },
})

type Style = Styles[string]

const text = (style: Style, value: string, key?: string) => e(Text, { style, key }, value)

/** A label on the left and an amount on the right, as every total is drawn. */
const amountRow = (style: Style, label: string, amount: string, labelStyle: Style = styles.muted) =>
  e(View, { style, key: label }, text(labelStyle, label), text({}, amount))

function party(label: string, party: DocumentParty): ReactElement {
  const details = [...(party.addressLines ?? []), party.taxNumber, party.email, party.phone].filter(Boolean) as string[]
  return e(
    View,
    { style: styles.party },
    text(styles.label, label),
    text(styles.partyName, party.name),
    ...details.map((line, i) => text(i < (party.addressLines?.length ?? 0) ? {} : styles.muted, line, `d${i}`)),
  )
}

export function documentElement(input: DocumentPdfInput): ReactElement<DocumentProps> {
  registerFonts()
  const heading = input.kind === 'invoice' ? 'INVOICE' : 'QUOTE'

  const header = e(
    View,
    { style: styles.between },
    party('From', input.issuer),
    e(
      View,
      { style: styles.headerRight },
      text(styles.kind, heading),
      input.number ? text(styles.number, input.number) : null,
      ...input.facts.map((fact) => e(View, { style: styles.row, key: fact.label }, text(styles.factLabel, fact.label), text({}, fact.value))),
    ),
  )

  const lines = e(
    View,
    { style: styles.section },
    e(
      View,
      { style: styles.tableHead },
      text(styles.description, 'DESCRIPTION'),
      text(styles.quantity, 'QTY'),
      text(styles.unit, 'UNIT PRICE'),
      text(styles.discount, 'DISC.'),
      text(styles.tax, 'TAX'),
      text(styles.amount, 'AMOUNT'),
    ),
    ...input.lines.map((line, i) =>
      e(
        View,
        { style: styles.line, wrap: false, key: i },
        text(styles.description, line.description),
        text(styles.quantity, line.quantity),
        text(styles.unit, line.unitAmount),
        text(styles.discount, line.discount ?? ''),
        text(styles.tax, line.tax ?? ''),
        text(styles.amount, line.amount),
      ),
    ),
  )

  const totals = e(
    View,
    { style: styles.totals },
    amountRow(styles.totalRow, 'Subtotal', input.totals.subtotal),
    input.totals.discount ? amountRow(styles.totalRow, input.totals.discount.label, input.totals.discount.amount) : null,
    ...(input.taxIncluded ? [] : input.totals.taxes.map((tax) => amountRow(styles.totalRow, tax.label, tax.amount))),
    amountRow(styles.grandTotal, 'Total', input.totals.total, {}),
    ...(input.taxIncluded ? input.totals.taxes.map((tax) => amountRow(styles.totalRow, `Includes ${tax.label}`, tax.amount)) : []),
    ...(input.totals.extras ?? []).map((extra) => amountRow(styles.totalRow, extra.label, extra.amount)),
  )

  const note = (label: string, body: string, muted = false) =>
    e(View, { style: styles.note, key: label }, text(styles.label, label), text(muted ? styles.muted : {}, body))

  return e<DocumentProps>(
    Document,
    { title: `${input.number ?? heading} ${input.title}`, author: input.issuer.name },
    e(
      Page,
      { size: 'A4', style: styles.page },
      header,
      input.marker ? text(styles.marker, input.marker) : null,
      e(View, { style: styles.section }, party(input.kind === 'invoice' ? 'Bill to' : 'Prepared for', input.client)),
      e(View, { style: styles.section }, text(styles.title, input.title)),
      lines,
      totals,
      input.paymentInstructions ? note('HOW TO PAY', input.paymentInstructions) : null,
      input.notes ? note('NOTES', input.notes) : null,
      input.terms ? note('TERMS', input.terms, true) : null,
      e(
        View,
        { style: styles.footer, fixed: true },
        text({}, `${input.number ? `${input.number} · ` : ''}${input.issuer.name}`),
        e(Text, { render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}` }),
      ),
    ),
  )
}
