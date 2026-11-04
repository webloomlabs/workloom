import { eq, schema } from '@workloom/db'
import type { DocumentImage, DocumentPdfInput, DocumentPdfLine, DocumentPdfTotalRow } from '@workloom/pdf'
import type { ActorContext } from '../../context.ts'
import { formatAmount, formatAmountPlain } from '../../money/currency.ts'
import type { Invoice } from './invoices.ts'
import type { Quote } from './quotes.ts'
import { periodText as periodWords, wholeMonths } from './recurrence.ts'

/** A line's period in words, its dates in the organization's format where they are not whole months. */
export function linePeriodText(start: string, end: string, format = 'D MMM YYYY'): string {
  return periodWords(start, end, (d) => formatDocumentDate(d, format))
}

/**
 * What a quote or invoice looks like on paper.
 *
 * Every value is formatted here, in the organization's currency and date
 * format, so that the PDF package holds no money or date logic and the page and
 * the print say the same thing.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The date formats an organization can choose. */
export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D MMM YYYY', 'D MMMM YYYY'] as const

/** A calendar date in the organization's format. Never a time zone conversion: it is already a date. */
export function formatDocumentDate(date: string, format: string): string {
  const [year = '', month = '', day = ''] = date.split('-')
  switch (format) {
    case 'MM/DD/YYYY':
      return `${month}/${day}/${year}`
    case 'YYYY-MM-DD':
      return date
    case 'D MMM YYYY':
      return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`
    case 'D MMMM YYYY':
      return `${Number(day)} ${LONG_MONTHS[Number(month) - 1]} ${year}`
    default:
      return `${day}/${month}/${year}`
  }
}

/** What the Billing column says for a line. */
export function billingLabel(line: { billingType: string | null; periodStart?: string | null; periodEnd?: string | null }): string | null {
  if (line.billingType === 'one_off') return 'One-time'
  if (line.billingType !== 'recurring') return null
  if (line.periodStart && line.periodEnd) {
    const months = wholeMonths(line.periodStart, line.periodEnd)
    if (months === 1) return 'Monthly'
    if (months === 3) return 'Quarterly'
    if (months === 12) return 'Yearly'
    if (months !== null) return `${months} months`
  }
  return 'Recurring'
}

const textLines = (value: string | null | undefined) => (value ? value.split('\n').map((l) => l.trim()).filter(Boolean) : [])

type InvoiceDocument = Invoice
type QuoteDocument = Quote

/** The organization's logo, read from storage. A missing or unreadable logo prints nothing rather than failing the document. */
async function loadLogo(key: string | null | undefined): Promise<DocumentImage | null> {
  if (!key) return null
  try {
    const { storage } = await import('@workloom/storage')
    const data = await storage().get(key)
    const format = data[0] === 0x89 && data[1] === 0x50 ? 'png' : data[0] === 0xff && data[1] === 0xd8 ? 'jpg' : null
    return format ? { data: new Uint8Array(data), format } : null
  } catch {
    return null
  }
}

export async function documentPdfInput(ctx: ActorContext, document: InvoiceDocument | QuoteDocument, kind: 'invoice' | 'quote'): Promise<DocumentPdfInput> {
  const [organization] = await ctx.tx.select().from(schema.organization).where(eq(schema.organization.id, ctx.organizationId)).limit(1)
  const [company] = await ctx.tx.select().from(schema.companies).where(eq(schema.companies.id, document.companyId)).limit(1)
  const currency = document.currency
  const money = (minor: number) => formatAmount(minor, currency)
  const minus = (minor: number) => `– ${formatAmount(minor, currency)}`
  const dateFormat = organization?.dateFormat ?? 'DD/MM/YYYY'
  const date = (value: string) => formatDocumentDate(value, dateFormat)
  const invoice = kind === 'invoice' ? (document as InvoiceDocument) : null
  const quote = kind === 'quote' ? (document as QuoteDocument) : null
  const issuerName = organization?.legalName || organization?.name || 'Workloom'

  const facts: DocumentPdfInput['facts'] = []
  if (document.issueDate) facts.push({ label: 'Date', value: date(document.issueDate) })
  if (invoice) {
    if (invoice.dueDate) facts.push({ label: 'Due', value: date(invoice.dueDate) })
    else if (invoice.dueLabel) facts.push({ label: 'Due', value: invoice.dueLabel })
  }
  if (quote?.validUntil) facts.push({ label: 'Valid until', value: date(quote.validUntil) })

  // Deductions are not lines of work: they print in the totals, as a statement does.
  const items = invoice ? invoice.lines.filter((l) => l.kind === 'item') : document.lines
  const lines: DocumentPdfLine[] = items.map((line) => {
    const { periodStart = null, periodEnd = null } = line as { periodStart?: string | null; periodEnd?: string | null }
    const period = periodStart && periodEnd ? linePeriodText(periodStart, periodEnd, dateFormat) : null
    return {
      title: line.description,
      subtitle: [line.detail, period].filter(Boolean).join(' · ') || null,
      billing: billingLabel({ billingType: line.billingType, periodStart, periodEnd }),
      quantity: line.quantity,
      unitAmount: formatAmountPlain(line.unitAmountMinor, currency),
      discount: line.discountPercent ? `${line.discountPercent}%` : null,
      tax: line.taxName ? `${line.taxName} ${line.taxRate}%` : null,
      amount: formatAmountPlain(line.netMinor, currency),
    }
  })
  const columns = {
    billing: items.some((l) => l.billingType !== null),
    unitPrice: items.some((l) => l.quantity !== '1'),
    discount: items.some((l) => l.discountPercent !== null),
    tax: items.some((l) => l.taxRateId !== null),
  }

  const inclusive = document.taxMode === 'inclusive'
  const rows: DocumentPdfTotalRow[] = []
  const after: DocumentPdfTotalRow[] = []
  let bar: DocumentPdfInput['totals']['bar']
  let headline: DocumentPdfInput['headline'] = null

  if (invoice && invoice.totals.statement) {
    rows.push({ label: 'Project total', amount: money(invoice.totals.itemsTotalMinor), style: 'strong' })
    for (const deduction of invoice.totals.deductions) {
      const label =
        deduction.settled === true ? 'Already paid' : deduction.settled === false ? `Previously invoiced (${deduction.number})` : `Less ${deduction.number}`
      rows.push({ label, amount: minus(deduction.amountMinor) })
    }
    if (invoice.amountPaidMinor > 0) rows.push({ label: 'Paid', amount: minus(invoice.amountPaidMinor) })
    bar = { label: 'Balance Due', amount: money(invoice.amountDueMinor) }
    for (const tax of invoice.taxes) after.push({ label: `${inclusive ? 'Includes' : 'Of which'} ${tax.name} ${tax.rate}%`, amount: money(tax.taxMinor), style: 'muted' })
  } else {
    const showSubtotal = document.discountMinor !== 0 || (!inclusive && document.taxes.length > 0)
    if (showSubtotal) rows.push({ label: 'Subtotal', amount: money(document.subtotalMinor) })
    if (document.discountMinor !== 0) {
      rows.push({ label: document.discountPercent ? `Discount (${document.discountPercent}%)` : 'Discount', amount: minus(document.discountMinor) })
    }
    if (!inclusive) for (const tax of document.taxes) rows.push({ label: `${tax.name} ${tax.rate}%`, amount: money(tax.taxMinor) })
    if (invoice && invoice.amountPaidMinor > 0) {
      rows.push({ label: 'Total', amount: money(invoice.totalMinor), style: 'strong' })
      rows.push({ label: 'Paid', amount: minus(invoice.amountPaidMinor) })
      bar = { label: 'Balance Due', amount: money(invoice.amountDueMinor) }
    } else {
      bar = { label: invoice ? 'Balance Due' : 'Total', amount: money(document.totalMinor) }
    }
    if (inclusive) for (const tax of document.taxes) after.push({ label: `Includes ${tax.name} ${tax.rate}%`, amount: money(tax.taxMinor), style: 'muted' })
  }
  if (document.baseCurrency && document.totalBaseMinor !== null && document.baseCurrency !== currency) {
    after.push({ label: `In ${document.baseCurrency} at ${document.exchangeRateToBase}`, amount: formatAmount(document.totalBaseMinor, document.baseCurrency), style: 'muted' })
  }

  if (invoice) {
    headline = {
      label: 'BALANCE DUE',
      amount: money(invoice.amountDueMinor),
      caption: invoice.totals.receivedMinor > 0 ? `After payment received of ${money(invoice.totals.receivedMinor)}` : null,
    }
  } else {
    headline = { label: 'TOTAL', amount: money(document.totalMinor), caption: null }
  }

  const marker =
    document.status === 'draft'
      ? 'DRAFT'
      : document.status === 'cancelled'
        ? 'CANCELLED'
        : document.status === 'paid'
          ? 'PAID'
          : document.status === 'declined' || document.status === 'expired'
            ? document.status.toUpperCase()
            : null

  const clientLines = [...textLines(company?.address), ...(company?.website ? [company.website.replace(/^https?:\/\//, '').replace(/\/$/, '')] : [])]
  const footerText = organization?.documentFooter?.trim()

  return {
    kind,
    number: document.number,
    title: document.title,
    marker,
    issuer: {
      name: issuerName,
      addressLines: textLines(organization?.billingAddress),
      taxNumber: organization?.taxNumber ?? null,
      logo: await loadLogo(organization?.logoKey),
    },
    client: { name: company?.name ?? document.companyName, addressLines: clientLines },
    facts,
    accentColor: organization?.brandColor ?? null,
    headline,
    currency,
    columns,
    taxIncluded: inclusive,
    lines,
    totals: { rows, bar, after },
    paymentDetails: invoice ? (organization?.paymentDetails ?? []) : [],
    paymentInstructions: invoice ? (organization?.paymentInstructions ?? null) : null,
    notes: document.notes,
    terms: document.terms,
    closing: invoice ? 'Thank you for your business.' : null,
    footer: footerText ? `${issuerName} · ${footerText}` : null,
  }
}
