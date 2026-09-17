import { reportProjects, reportRevenue } from '@workloom/core/modules'
import { Alert, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { PeriodPicker } from '@/components/reports/period'
import { formatDate } from '@/lib/format'
import { money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Reports · Workloom' }

/**
 * Where the money went.
 *
 * Each figure is dated the way that thing is dated -- an invoice by when it was
 * issued, a payment by when the money moved, an expense by when it was
 * incurred, time by when it was worked -- so the columns are not the same
 * calendar and the page says so rather than quietly averaging them.
 */
export default async function ReportsPage({ searchParams }: PageProps<'/reports'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  if (!viewer.permissions.has('report:readFinancial')) {
    return <Alert tone="warning">You do not have access to financial reports.</Alert>
  }

  const from = param(query.from)
  const to = param(query.to)
  const [revenue, portfolio, settings] = await Promise.all([
    call(reportRevenue, { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
    call(reportProjects, { sort: 'margin', limit: 20 }),
    organizationSettings(),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={`${formatDate(revenue.from)} to ${formatDate(revenue.to)}`}
        actions={
          <PeriodPicker from={revenue.from} to={revenue.to} />
        }
      />

      {revenue.currencies.length === 0 ? (
        <Card>
          <EmptyState>No money recorded in this period.</EmptyState>
        </Card>
      ) : (
        revenue.currencies.map((figures) => {
          const amount = (minor: number) => money(minor, figures.currency)
          return (
            <div key={figures.currency} className="space-y-4">
              {revenue.currencies.length > 1 && (
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{figures.currency}</h2>
              )}
              <section aria-label={`Money in ${figures.currency}`} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Billed" value={amount(figures.billedMinor)} detail={figures.taxMinor > 0 ? `plus ${amount(figures.taxMinor)} tax` : 'excluding tax'} />
                <Stat label="Collected" value={amount(figures.collectedMinor)} detail="less any refunds" />
                <Stat
                  label="Outstanding"
                  value={amount(figures.outstandingMinor)}
                  detail={figures.overdueMinor > 0 ? `${amount(figures.overdueMinor)} overdue` : 'as things stand now'}
                  tone={figures.overdueMinor > 0 ? 'warn' : undefined}
                />
                <Stat
                  label="Profit"
                  value={amount(figures.profitMinor)}
                  detail={figures.profitPercent === null ? 'Nothing billed' : `${figures.profitPercent}% of what was billed`}
                  tone={figures.profitMinor < 0 ? 'warn' : undefined}
                />
              </section>

              {figures.unattributedBilledMinor !== 0 && (
                <Alert tone="info">
                  {amount(figures.unattributedBilledMinor)} of what was billed is not attributable to any project, so it is missing from the project
                  margins below.
                </Alert>
              )}

              <Card>
                <CardHeader title="By month" description="An invoice counts when it was issued; a payment when the money moved; a cost when it was incurred." />
                <Table>
                  <thead>
                    <tr>
                      <Th>Month</Th>
                      <Th className="text-right">Billed</Th>
                      <Th className="text-right">Collected</Th>
                      <Th className="text-right">Time</Th>
                      <Th className="text-right">Expenses</Th>
                      <Th className="text-right">Profit</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {figures.byMonth.map((row) => (
                      <Tr key={row.month}>
                        <Td className="whitespace-nowrap">{row.month}</Td>
                        <Td className="whitespace-nowrap text-right tabular-nums">{amount(row.billedMinor)}</Td>
                        <Td className="whitespace-nowrap text-right tabular-nums">{amount(row.collectedMinor)}</Td>
                        <Td className="whitespace-nowrap text-right tabular-nums text-muted">{amount(row.labourCostMinor)}</Td>
                        <Td className="whitespace-nowrap text-right tabular-nums text-muted">{amount(row.expenseCostMinor)}</Td>
                        <Td className={`whitespace-nowrap text-right tabular-nums ${row.profitMinor < 0 ? 'font-medium text-critical' : ''}`}>
                          {amount(row.profitMinor)}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          )
        })
      )}

      <Card>
        <CardHeader title="Clients" description="Everyone billed in the period, biggest first." />
        {revenue.byClient.length === 0 ? (
          <EmptyState>Nobody was billed in this period.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Client</Th>
                <Th className="text-right">Billed</Th>
                <Th className="text-right">Collected</Th>
                <Th className="text-right">Outstanding</Th>
              </tr>
            </thead>
            <tbody>
              {revenue.byClient.map((row) => (
                <Tr key={`${row.companyId}-${row.currency}`}>
                  <Td>
                    <Link href={`/companies/${row.companyId}?tab=invoices`} className="font-medium hover:underline">{row.companyName}</Link>
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{money(row.billedMinor, row.currency)}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{money(row.collectedMinor, row.currency)}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-muted">{money(row.outstandingMinor, row.currency)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Projects by margin"
          description="Over each project's whole life, not the period above. Worst first — those are the ones worth looking at."
        />
        {portfolio.data.length === 0 ? (
          <EmptyState>No project has any money against it yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Project</Th>
                <Th>Client</Th>
                <Th className="text-right">Billed</Th>
                <Th className="text-right">Cost</Th>
                <Th className="text-right">Margin</Th>
                <Th className="text-right">To invoice</Th>
              </tr>
            </thead>
            <tbody>
              {portfolio.data.map((row) => (
                <Tr key={`${row.projectId}-${row.currency}`}>
                  <Td>
                    <Link href={`/projects/${row.projectId}?tab=financials`} className="font-medium hover:underline">{row.name}</Link>
                    {portfolio.data.some((r) => r.projectId === row.projectId && r.currency !== row.currency) && (
                      <div className="text-xs text-muted">{row.currency}</div>
                    )}
                  </Td>
                  <Td className="text-muted">
                    {row.companyId ? <Link href={`/companies/${row.companyId}`} className="hover:underline">{row.companyName}</Link> : 'Internal'}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{money(row.billedMinor, row.currency)}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-muted">{money(row.costMinor, row.currency)}</Td>
                  <Td className={`whitespace-nowrap text-right tabular-nums ${row.marginMinor < 0 ? 'font-medium text-critical' : ''}`}>
                    {money(row.marginMinor, row.currency)}
                    {row.marginPercent !== null && <span className="ml-2 text-xs text-muted">{row.marginPercent}%</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-muted">{money(row.uninvoicedMinor, row.currency)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <p className="text-xs text-muted">
        Figures are in the currency they were recorded in and nothing is converted between them. Amounts are shown against {settings.baseCurrency} only
        where that is the currency they were recorded in.
      </p>
    </div>
  )
}

function Stat({ label, value, detail, tone }: { label: string; value: string; detail?: string | undefined; tone?: 'warn' | undefined }) {
  return (
    <Card className="space-y-1 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone === 'warn' ? 'text-critical' : ''}`}>{value}</div>
      {detail && <div className="text-xs text-muted">{detail}</div>}
    </Card>
  )
}
