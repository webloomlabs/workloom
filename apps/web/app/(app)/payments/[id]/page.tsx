import { minorToDecimalString, type Permission } from '@workloom/core'
import { invoiceList, paymentGet } from '@workloom/core/modules'
import { Alert, Badge, Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { AllocateForm, DeletePaymentButton, EditPaymentForm, UnallocateButton } from '@/components/finance/payment-forms'
import { formatDate } from '@/lib/format'
import { PAYMENT_METHOD_LABELS } from '@/lib/finance-labels'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Payment · Workloom' }

export default async function PaymentPage({ params }: PageProps<'/payments/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (p: Permission) => viewer.permissions.has(p)
  const payment = await call(paymentGet, { id })
  const refund = payment.kind === 'refund'

  // What is left of it can go against anything of this client's still outstanding.
  const outstanding =
    payment.unallocatedMinor > 0 && can('payment:update') && can('invoice:read')
      ? await call(invoiceList, { companyId: payment.companyId, outstanding: !refund, limit: 100 })
      : { data: [] }
  const already = new Set(payment.allocations.map((a) => a.invoiceId))
  const open = outstanding.data.filter(
    (i) => !already.has(i.id) && i.currency === payment.currency && (refund ? i.amountPaidMinor > 0 : i.amountDueMinor > 0),
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link href="/payments" className="text-sm text-neutral-500 hover:underline">← Payments</Link>
          <h1 className="text-xl font-semibold tracking-tight">
            {money(payment.amountMinor, payment.currency)} {refund ? 'refunded' : 'received'}
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
            {refund && <Badge tone="amber">Refund</Badge>}
            <Link href={`/companies/${payment.companyId}?tab=payments`} className="hover:underline">{payment.companyName}</Link>
            <span>{formatDate(payment.receivedOn)}</span>
            <span>{PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}</span>
            {payment.reference && <span className="text-neutral-800 dark:text-neutral-200">{payment.reference}</span>}
          </div>
        </div>
        {can('payment:delete') && <DeletePaymentButton paymentId={payment.id} />}
      </div>

      {payment.unallocatedMinor > 0 && (
        <Alert tone="info">
          {money(payment.unallocatedMinor, payment.currency)} of this is on the client&apos;s account, not against any invoice.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader title={refund ? 'Taken back off' : 'Put against'} />
            {payment.allocations.length === 0 ? (
              <EmptyState>Nothing yet.</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr><Th>Invoice</Th><Th className="text-right">Amount</Th>{can('payment:update') && <Th />}</tr>
                </thead>
                <tbody>
                  {payment.allocations.map((allocation) => (
                    <tr key={allocation.id}>
                      <Td>
                        <Link href={`/invoices/${allocation.invoiceId}`} className="font-medium hover:underline">{allocation.invoiceTitle}</Link>
                        <div className="text-xs text-neutral-500">{allocation.invoiceNumber}</div>
                      </Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">{money(allocation.amountMinor, payment.currency)}</Td>
                      {can('payment:update') && (
                        <Td>
                          <UnallocateButton
                            allocationId={allocation.id}
                            invoiceId={allocation.invoiceId}
                            label={allocation.invoiceNumber ?? allocation.invoiceTitle}
                          />
                        </Td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {payment.unallocatedMinor > 0 && can('payment:update') && (
              <div className="border-t border-neutral-200 p-5 dark:border-neutral-800">
                <AllocateForm
                  paymentId={payment.id}
                  currency={payment.currency}
                  invoices={open.map((i) => ({
                    id: i.id,
                    label: `${i.number ?? i.title} · ${money(refund ? i.amountPaidMinor : i.amountDueMinor, i.currency)} ${refund ? 'paid' : 'owing'}`,
                  }))}
                />
              </div>
            )}
          </Card>

          {can('payment:update') && (
            <Card>
              <CardHeader title="Details" description="Correcting what was recorded. The amount cannot go below what it is already put against." />
              <div className="p-5">
                <EditPaymentForm
                  payment={{
                    id: payment.id,
                    currency: payment.currency,
                    amount: minorToDecimalString(payment.amountMinor, payment.currency),
                    receivedOn: payment.receivedOn,
                    method: payment.method,
                    reference: payment.reference,
                    notes: payment.notes,
                  }}
                />
              </div>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader title="Summary" />
          <dl className="space-y-2 p-5 text-sm" aria-label="Payment summary">
            <Row label={refund ? 'Refunded' : 'Received'} value={money(payment.amountMinor, payment.currency)} />
            <Row label="Allocated" value={money(payment.allocatedMinor, payment.currency)} />
            <div className="flex justify-between gap-4 border-t border-neutral-200 pt-2 font-semibold dark:border-neutral-800">
              <dt>On account</dt>
              <dd className="tabular-nums">{money(payment.unallocatedMinor, payment.currency)}</dd>
            </div>
            {payment.baseCurrency !== payment.currency && (
              <Row label={`In ${payment.baseCurrency} at ${payment.exchangeRateToBase}`} value={money(payment.amountBaseMinor, payment.baseCurrency)} />
            )}
          </dl>
          {payment.notes && <p className="whitespace-pre-wrap border-t border-neutral-200 p-5 text-sm dark:border-neutral-800">{payment.notes}</p>}
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
