import { eq, schema } from '@workloom/db'
import type { DocumentPdfInput } from '@workloom/pdf'
import type { ActorContext } from '../../context.ts'
import { formatAmount } from '../../money/currency.ts'
import type { Invoice } from './invoices.ts'
import type { Quote } from './quotes.ts'

/**
 * What a quote or invoice looks like on paper.
 *
 * Every value is formatted here, in the organization's currency and date
 * format, so that the PDF package holds no money or date logic and the page and
 * the print say the same thing.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
    default:
      return `${day}/${month}/${year}`
  }
}

const lines = (value: string | null | undefined) => (value ? value.split('\n').map((l) => l.trim()).filter(Boolean) : [])

type Document = (Invoice | Quote) & { dueDate?: string | null; validUntil?: string; amountDueMinor?: number; amountPaidMinor?: number }

export async function documentPdfInput(ctx: ActorContext, document: Document, kind: 'invoice' | 'quote'): Promise<DocumentPdfInput> {
  const [organization] = await ctx.tx.select().from(schema.organization).where(eq(schema.organization.id, ctx.organizationId)).limit(1)
  const [company] = await ctx.tx.select().from(schema.companies).where(eq(schema.companies.id, document.companyId)).limit(1)
  const money = (minor: number) => formatAmount(minor, document.currency)
  const date = (value: string) => formatDocumentDate(value, organization?.dateFormat ?? 'DD/MM/YYYY')

  const facts: DocumentPdfInput['facts'] = []
  if (document.issueDate) facts.push({ label: 'Issued', value: date(document.issueDate) })
  if (kind === 'invoice' && document.dueDate) facts.push({ label: 'Due', value: date(document.dueDate) })
  if (kind === 'quote' && document.validUntil) facts.push({ label: 'Valid until', value: date(document.validUntil) })

  const extras: Array<{ label: string; amount: string }> = []
  if (document.baseCurrency && document.totalBaseMinor !== null && document.baseCurrency !== document.currency) {
    extras.push({ label: `In ${document.baseCurrency} at ${document.exchangeRateToBase}`, amount: formatAmount(document.totalBaseMinor!, document.baseCurrency) })
  }
  if (kind === 'invoice' && (document.amountPaidMinor ?? 0) > 0) {
    extras.push({ label: 'Paid', amount: money(document.amountPaidMinor!) })
    extras.push({ label: 'Amount due', amount: money(document.amountDueMinor!) })
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

  return {
    kind,
    number: document.number,
    title: document.title,
    marker,
    issuer: {
      name: organization?.legalName || organization?.name || 'Workloom',
      addressLines: lines(organization?.billingAddress),
      taxNumber: organization?.taxNumber ?? null,
    },
    client: {
      name: company?.name ?? document.companyName,
      addressLines: lines(company?.address),
      email: document.contactName ? null : (company?.email ?? null),
      phone: null,
      ...(document.contactName ? { name: company?.name ?? document.companyName } : {}),
    },
    facts,
    taxIncluded: document.taxMode === 'inclusive',
    lines: document.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitAmount: money(line.unitAmountMinor),
      discount: line.discountPercent ? `${line.discountPercent}%` : null,
      tax: line.taxName ? `${line.taxName} ${line.taxRate}%` : null,
      amount: money(line.netMinor),
    })),
    totals: {
      subtotal: money(document.subtotalMinor),
      discount: document.discountMinor === 0 ? null : { label: document.discountPercent ? `Discount (${document.discountPercent}%)` : 'Discount', amount: money(-document.discountMinor) },
      taxes: document.taxes.map((tax) => ({ label: `${tax.name} ${tax.rate}%`, amount: money(tax.taxMinor) })),
      total: money(document.totalMinor),
      extras,
    },
    notes: document.notes,
    terms: document.terms,
    paymentInstructions: kind === 'invoice' ? (organization?.paymentInstructions ?? null) : null,
  }
}
