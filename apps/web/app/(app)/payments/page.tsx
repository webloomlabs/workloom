import { paymentList } from '@workloom/core/modules'
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param } from '@/components/crm/list-controls'
import { formatDate } from '@/lib/format'
import { PAYMENT_METHOD_LABELS } from '@/lib/finance-labels'
import { money } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Payments · Workloom' }

const VIEWS = {
  all: { label: 'All', filter: {} },
  payments: { label: 'Received', filter: { kind: 'payment' as const } },
  refunds: { label: 'Refunded', filter: { kind: 'refund' as const } },
  unallocated: { label: 'On account', filter: { unallocated: true } },
}

export default async function PaymentsPage({ searchParams }: PageProps<'/payments'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const view = (param(query.view) ?? 'all') as keyof typeof VIEWS
  const { filter } = VIEWS[view] ?? VIEWS.all
  const cursor = param(query.cursor)
  const payments = await call(paymentList, { ...filter, ...(cursor ? { cursor } : {}), limit: 50 })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        actions={
          viewer.permissions.has('payment:create') && (
            <Link href="/payments/new" className={buttonStyles()}>
              Record a payment
            </Link>
          )
        }
      />
      <Card>
        <CardHeader
          title={VIEWS[view]?.label ?? 'All'}
          description="Money received from clients, and money refunded to them."
          action={
            <FilterTabs
              active={view}
              tabs={Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label, href: key === 'all' ? '/payments' : `/payments?view=${key}` }))}
            />
          }
        />
        {payments.data.length === 0 ? (
          <EmptyState>No payments{view === 'all' ? ' yet' : ' match'}.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Client</Th>
                <Th>Reference</Th>
                <Th>Against</Th>
                <Th className="text-right">Amount</Th>
                <Th className="text-right">On account</Th>
              </tr>
            </thead>
            <tbody>
              {payments.data.map((payment) => (
                <Tr key={payment.id}>
                  <Td className="whitespace-nowrap">
                    <Link href={`/payments/${payment.id}`} className="font-medium hover:underline">{formatDate(payment.receivedOn)}</Link>
                    <div className="text-xs text-muted">{PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}</div>
                  </Td>
                  <Td><Link href={`/companies/${payment.companyId}?tab=payments`} className="text-muted hover:underline">{payment.companyName}</Link></Td>
                  <Td className="text-muted">{payment.reference ?? '—'}</Td>
                  <Td className="text-muted">
                    {payment.allocations.length === 0
                      ? <span className="text-faint">Nothing yet</span>
                      : payment.allocations.map((a) => (
                          <Link key={a.id} href={`/invoices/${a.invoiceId}`} className="mr-2 hover:underline">{a.invoiceNumber ?? a.invoiceTitle}</Link>
                        ))}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {payment.kind === 'refund' ? <Badge tone="caution">Refund</Badge> : null} {money(payment.amountMinor, payment.currency)}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-muted">
                    {payment.unallocatedMinor === 0 ? '—' : money(payment.unallocatedMinor, payment.currency)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base="/payments" params={view === 'all' ? {} : { view }} cursor={cursor} nextCursor={payments.nextCursor} />
      </Card>
    </div>
  )
}
