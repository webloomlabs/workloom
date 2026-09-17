import { billingScheduleGet, billingScheduleInvoiceList, taxRateList } from '@workloom/core/modules'
import { Alert, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { InvoiceStatusBadge } from '@/components/finance/badges'
import { ScheduleStatusBadge } from '@/components/service/badges'
import {
  AddScheduleLineForm,
  DeleteScheduleButton,
  EditScheduleForm,
  GenerateInvoiceButton,
  RemoveScheduleLineButton,
  ScheduleStatusControl,
} from '@/components/service/schedule-forms'
import { formatDate, formatDateTime, todayIn } from '@/lib/format'
import { describeInterval } from '@/lib/service-labels'
import { memberChoices, money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Recurring schedule · Workloom' }

export default async function SchedulePage({ params }: PageProps<'/recurring/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (permission: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(permission)

  const schedule = await call(billingScheduleGet, { id }).catch(() => null)
  if (!schedule) notFound()

  const [invoices, taxRates, members, settings] = await Promise.all([
    call(billingScheduleInvoiceList, { id, limit: 50 }),
    can('taxRate:read') ? call(taxRateList, {}) : Promise.resolve({ data: [] }),
    memberChoices(),
    organizationSettings(),
  ])
  const today = todayIn(settings.timezone)
  const due = Boolean(schedule.nextRunOn && schedule.nextRunOn <= today && schedule.status === 'active' && !schedule.blocker)
  const amount = (minor: number) => money(minor, schedule.currency)

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/recurring" className="text-sm text-muted hover:text-ink">← Recurring billing</Link>}
        title={schedule.name}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <ScheduleStatusBadge status={schedule.status} />
            <Link href={`/companies/${schedule.companyId}?tab=invoices`} className="hover:text-ink">{schedule.companyName}</Link>
            <span>· {describeInterval(schedule.intervalUnit, schedule.intervalCount)}</span>
            <span className="font-medium tabular-nums text-ink">· {amount(schedule.periodSubtotalMinor)} a period</span>
            <span>· {schedule.generatedCount} raised</span>
          </div>
        }
        actions={
          <>
            {can('billingSchedule:update') && <ScheduleStatusControl id={schedule.id} status={schedule.status} />}
            {can('billingSchedule:delete') && <DeleteScheduleButton id={schedule.id} />}
          </>
        }
      />

      {schedule.blocker && <Alert tone="warning">{schedule.blockerMessage}</Alert>}

      {schedule.status === 'active' && !schedule.blocker && schedule.nextRunOn && (
        <Alert tone={due ? 'warning' : 'info'}>
          {due
            ? `The period starting ${formatDate(schedule.nextRunOn)} is due. The worker raises it within the hour, or you can raise it now.`
            : `Next period starts ${formatDate(schedule.nextRunOn)} and runs to ${formatDate(schedule.nextPeriodEndsOn)}.`}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="What each period bills"
              action={
                can('billingSchedule:update') &&
                schedule.status === 'active' && (
                  <GenerateInvoiceButton id={schedule.id} due={due} force={!due} />
                )
              }
            />
            {schedule.lines.length === 0 ? (
              <EmptyState>Nothing to bill yet. Add a line below.</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Description</Th>
                    <Th className="text-right">Qty</Th>
                    <Th className="text-right">Unit</Th>
                    <Th className="text-right">Amount</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {schedule.lines.map((line) => (
                    <Tr key={line.id}>
                      <Td>{line.description}</Td>
                      <Td className="text-right tabular-nums text-muted">{line.quantity}</Td>
                      <Td className="text-right tabular-nums">{amount(line.unitAmountMinor)}</Td>
                      <Td className="text-right tabular-nums">{amount(Math.round(Number(line.quantity) * line.unitAmountMinor))}</Td>
                      <Td className="text-right">
                        {can('billingSchedule:update') && <RemoveScheduleLineButton scheduleId={schedule.id} lineId={line.id} />}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
            {can('billingSchedule:update') && (
              <CardBody className="border-t border-line">
                <AddScheduleLineForm
                  scheduleId={schedule.id}
                  currency={schedule.currency}
                  taxRates={taxRates.data.map((t) => ({ id: t.id, name: `${t.name} (${t.rate}%)` }))}
                />
              </CardBody>
            )}
          </Card>

          <Card>
            <CardHeader title="Invoices raised" description="One per period. Each starts as a draft." />
            {invoices.data.length === 0 ? (
              <EmptyState>Nothing raised yet.</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Period</Th>
                    <Th>Invoice</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Raised</Th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.data.map((row) => (
                    <Tr key={row.id}>
                      <Td className="whitespace-nowrap">
                        {formatDate(row.periodStart)} — {formatDate(row.periodEnd)}
                      </Td>
                      <Td>
                        <Link href={`/invoices/${row.invoiceId}`} className="font-medium hover:underline">
                          {row.invoiceNumber ?? 'Draft'}
                        </Link>
                      </Td>
                      <Td><InvoiceStatusBadge status={row.invoiceStatus} /></Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">{money(row.totalMinor, row.currency)}</Td>
                      <Td className="whitespace-nowrap text-muted">{formatDateTime(row.createdAt, settings.timezone)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="The calendar" />
            <CardBody className="space-y-2 text-sm">
              {[
                ['Started', formatDate(schedule.startOn)],
                ['Next period', schedule.nextRunOn ? `${formatDate(schedule.nextRunOn)} — ${formatDate(schedule.nextPeriodEndsOn)}` : 'None left'],
                ['Stops after', schedule.endOn ? formatDate(schedule.endOn) : schedule.maxOccurrences ? `${schedule.maxOccurrences} invoices` : 'Not set'],
                ['Payment terms', `${schedule.paymentTermsDays} days`],
                ['Last run', schedule.lastRunAt ? formatDateTime(schedule.lastRunAt, settings.timezone) : 'Never'],
              ].map(([term, value]) => (
                <div key={term} className="flex justify-between gap-4">
                  <dt className="text-muted">{term}</dt>
                  <dd className="text-right text-ink">{value}</dd>
                </div>
              ))}
            </CardBody>
          </Card>

          {can('billingSchedule:update') && (
            <Card>
              <details>
                <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-ink">Edit schedule</summary>
                <CardBody className="border-t border-line">
                  <EditScheduleForm schedule={schedule} members={members.choices} />
                </CardBody>
              </details>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
