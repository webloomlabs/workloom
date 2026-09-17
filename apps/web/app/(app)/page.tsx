import { dashboardGet } from '@workloom/core/modules'
import { formatDuration } from '@workloom/core/time'
import { Badge, Card, CardHeader, EmptyState, PageHeader, Stat, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { PeriodTabs } from '@/components/reports/period'
import { PERIODS } from '@workloom/core'
import { formatDate, formatDateTime } from '@/lib/format'
import { money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Dashboard · Workloom' }

/**
 * The dashboard.
 *
 * Every card is optional: the procedure returns null for anything the viewer
 * has no permission to see, and a null card is not drawn at all. A developer
 * and a finance lead open the same page and get different ones.
 */
export default async function DashboardPage({ searchParams }: PageProps<'/'>) {
  const query = await searchParams
  // The layout already refused an unauthenticated visitor; this is what makes
  // the page itself refuse one, since it is the first thing anyone lands on.
  await requireViewer()
  const period = (PERIODS as readonly string[]).includes(param(query.period) ?? '') ? (param(query.period) as (typeof PERIODS)[number]) : 'month'

  const [board, settings] = await Promise.all([call(dashboardGet, { period }), organizationSettings()])
  const amount = (minor: number) => money(minor, board.baseCurrency)
  const span = `${formatDate(board.from)} to ${formatDate(board.to)}`

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={`${span}, against the same days before`}
        actions={
          <PeriodTabs active={period} />
        }
      />

      {board.money && (
        <section aria-label={`Money in ${board.baseCurrency}`} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Revenue"
            value={amount(board.money.revenue.minor)}
            change={board.money.revenue.changePercent}
            detail={`${amount(board.money.revenue.previousMinor)} before, excluding tax`}
            href="/reports"
          />
          <Metric
            label="Outstanding"
            value={amount(board.money.outstanding.minor)}
            detail={
              board.money.outstanding.overdueCount > 0
                ? `${amount(board.money.outstanding.overdueMinor)} overdue across ${board.money.outstanding.overdueCount}`
                : `${board.money.outstanding.count} unpaid, none overdue`
            }
            tone={board.money.outstanding.overdueCount > 0 ? 'bad' : undefined}
            href="/invoices?view=outstanding"
          />
          <Metric
            label="Expenses"
            value={amount(board.money.expenses.minor)}
            change={board.money.expenses.changePercent}
            // More spending is not better, so the arrow points the other way.
            invert
            detail={`${amount(board.money.expenses.previousMinor)} before`}
            href="/expenses"
          />
          <Metric
            label="Estimated profit"
            value={amount(board.money.profit.minor)}
            change={board.money.profit.changePercent}
            detail={`after ${amount(board.money.profit.labourCostMinor)} of time`}
            tone={board.money.profit.minor < 0 ? 'bad' : undefined}
            href="/reports"
          />
        </section>
      )}

      {board.money && board.money.profit.uncountedSeconds > 0 && (
        <p className="text-xs text-muted">
          {formatDuration(board.money.profit.uncountedSeconds)} was logged in {board.money.profit.uncountedCurrencies.join(' and ')} and is not in the
          profit above: no exchange rate is recorded against tracked time.
        </p>
      )}

      <section aria-label="Delivery and sales" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {board.projects && (
          <Metric
            label="Active projects"
            value={String(board.projects.active)}
            detail={
              board.projects.overdue > 0
                ? `${board.projects.overdue} past their due date`
                : `${board.projects.completed.count} completed this period`
            }
            tone={board.projects.overdue > 0 ? 'bad' : undefined}
            href="/projects"
          />
        )}
        {board.tasks && (
          <Metric
            label="Open tasks"
            value={String(board.tasks.open)}
            detail={board.tasks.overdue > 0 ? `${board.tasks.overdue} overdue · ${board.tasks.mine} yours` : `${board.tasks.mine} of them yours`}
            tone={board.tasks.overdue > 0 ? 'bad' : undefined}
            href="/tasks"
          />
        )}
        {board.leads && (
          <Metric
            label="Leads"
            value={String(board.leads.open)}
            change={board.leads.created.changePercent}
            detail={`${board.leads.created.count} arrived, ${board.leads.converted.count} converted`}
            href="/leads"
          />
        )}
        {board.pipeline && board.pipeline[0] && (
          <Metric
            label="Pipeline"
            value={money(board.pipeline[0].openMinor, board.pipeline[0].currency)}
            detail={`${board.pipeline[0].openCount} open deals${board.pipeline[0].wonCount > 0 ? ` · ${money(board.pipeline[0].wonMinor, board.pipeline[0].currency)} won` : ''}`}
            href="/pipeline"
          />
        )}
      </section>

      {board.pipeline && board.pipeline.length > 1 && (
        <p className="text-xs text-muted">
          Pipeline also holds{' '}
          {board.pipeline.slice(1).map((row) => `${money(row.openMinor, row.currency)} in ${row.currency}`).join(', ')}. A deal records a value and a
          currency, never an exchange rate, so nothing is converted.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        {board.deadlines && (
          <Card>
            <CardHeader title="Coming up" description="Tasks and milestones due in the next fortnight, and anything already late." />
            {board.deadlines.length === 0 ? (
              <EmptyState>Nothing due in the next fortnight.</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr><Th>What</Th><Th>Project</Th><Th>Due</Th></tr>
                </thead>
                <tbody>
                  {board.deadlines.map((item) => (
                    <Tr key={`${item.kind}-${item.id}`}>
                      <Td>
                        <span className="font-medium">{item.title}</span>
                        <div className="text-xs text-muted">{item.kind === 'milestone' ? 'Milestone' : 'Task'}</div>
                      </Td>
                      <Td className="text-muted">
                        <Link href={`/projects/${item.projectId}`} className="hover:underline">{item.projectName}</Link>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {item.overdue ? <Badge tone="critical">{formatDate(item.dueDate)}</Badge> : <span className="text-muted">{formatDate(item.dueDate)}</span>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        )}

        {board.activity && (
          <Card>
            <CardHeader title="Recent activity" description="What has happened across the agency." />
            {board.activity.length === 0 ? (
              <EmptyState>Nothing recorded yet.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {board.activity.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
                    <span>
                      <span className="font-medium">{entry.action}</span>
                      {entry.entityLabel && <span className="text-muted"> · {entry.entityLabel}</span>}
                    </span>
                    <span className="text-xs text-muted">
                      {entry.actorLabel ?? 'System'} · {formatDateTime(entry.at, settings.timezone)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {!board.money && !board.projects && !board.tasks && !board.leads && !board.pipeline && (
        <Card>
          <EmptyState>Your role does not have access to any of the dashboard figures.</EmptyState>
        </Card>
      )}
    </div>
  )
}

/**
 * One figure, in a card that links to where it came from.
 *
 * The figure itself is the design system's `Stat`; what this adds is the card
 * around it and the link out, which only the dashboard needs.
 */
function Metric({
  label,
  value,
  change,
  detail,
  tone,
  invert,
  href,
}: {
  label: string
  value: string
  change?: string | null
  detail?: string | undefined
  tone?: 'bad' | undefined
  invert?: boolean | undefined
  href?: string | undefined
}) {
  const stat = (
    <Stat
      label={label}
      value={value}
      detail={detail}
      change={change}
      invert={invert}
      tone={tone === 'bad' ? 'critical' : undefined}
    />
  )
  return (
    <Card className="p-4 transition-colors hover:border-line-strong">
      {href ? (
        <Link href={href} className="block">
          {stat}
        </Link>
      ) : (
        stat
      )}
    </Card>
  )
}
