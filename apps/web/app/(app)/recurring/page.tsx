import { billingScheduleList } from '@workloom/core/modules'
import { Alert, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { ScheduleStatusBadge } from '@/components/service/badges'
import { formatDate, todayIn } from '@/lib/format'
import { describeInterval } from '@/lib/service-labels'
import { money, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Recurring billing · Workloom' }

const VIEWS = {
  active: { label: 'Active', filter: { status: 'active' as const } },
  due: { label: 'Due now', filter: { due: true } },
  paused: { label: 'Paused', filter: { status: 'paused' as const } },
  ended: { label: 'Ended', filter: { status: 'ended' as const } },
  all: { label: 'All', filter: {} },
}

export default async function RecurringPage({ searchParams }: PageProps<'/recurring'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const view = (param(query.view) ?? 'active') as keyof typeof VIEWS
  const { filter } = VIEWS[view] ?? VIEWS.active
  const q = param(query.q)
  const cursor = param(query.cursor)

  const [schedules, settings] = await Promise.all([
    call(billingScheduleList, { ...filter, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}), limit: 50 }),
    organizationSettings(),
  ])
  const today = todayIn(settings.timezone)
  const blocked = schedules.data.filter((s) => s.blocker && s.status === 'active')

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recurring billing"
        description="Retainers and care plans. Each raises a draft invoice when its period arrives; a person issues it."
        actions={
          viewer.permissions.has('billingSchedule:create') && (
            <Link href="/recurring/new" className={buttonStyles()}>
              New schedule
            </Link>
          )
        }
      />

      {blocked.length > 0 && (
        <Alert tone="warning">
          {blocked.length === 1 ? 'One schedule cannot bill: ' : `${blocked.length} schedules cannot bill: `}
          {blocked.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ', '}
              <Link href={`/recurring/${s.id}`} className="font-medium underline">{s.name}</Link>
            </span>
          ))}
          . Nothing will be raised for them until it is fixed.
        </Alert>
      )}

      <Card>
        <CardHeader
          title={VIEWS[view]?.label ?? 'Active'}
          action={
            <div className="flex flex-wrap items-center gap-3">
              <FilterTabs
                active={view}
                tabs={Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label, href: key === 'active' ? '/recurring' : `/recurring?view=${key}` }))}
              />
              <SearchBox action="/recurring" q={q} hidden={view === 'active' ? {} : { view }} placeholder="Schedule or client" />
            </div>
          }
        />
        {schedules.data.length === 0 ? (
          <EmptyState>
            {q || view !== 'active' ? 'Nothing matches.' : 'No recurring billing yet. Set one up for a retainer or a care plan.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Schedule</Th>
                <Th>Client</Th>
                <Th>Status</Th>
                <Th>Every</Th>
                <Th>Next period</Th>
                <Th className="text-right">Per period</Th>
                <Th className="text-right">Raised</Th>
              </tr>
            </thead>
            <tbody>
              {schedules.data.map((schedule) => (
                <Tr key={schedule.id}>
                  <Td>
                    <Link href={`/recurring/${schedule.id}`} className="font-medium hover:underline">{schedule.name}</Link>
                    {schedule.blocker && <div className="text-xs text-critical">{schedule.blockerMessage}</div>}
                  </Td>
                  <Td className="text-muted">
                    <Link href={`/companies/${schedule.companyId}?tab=invoices`} className="hover:underline">{schedule.companyName}</Link>
                  </Td>
                  <Td><ScheduleStatusBadge status={schedule.status} /></Td>
                  <Td className="whitespace-nowrap text-muted">{describeInterval(schedule.intervalUnit, schedule.intervalCount)}</Td>
                  <Td className="whitespace-nowrap">
                    <span className={schedule.nextRunOn && schedule.nextRunOn <= today ? 'font-medium text-accent-text' : 'text-muted'}>
                      {schedule.nextRunOn ? formatDate(schedule.nextRunOn) : '—'}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{money(schedule.periodSubtotalMinor, schedule.currency)}</Td>
                  <Td className="text-right tabular-nums text-muted">
                    {schedule.generatedCount}
                    {schedule.maxOccurrences ? ` / ${schedule.maxOccurrences}` : ''}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager
          base="/recurring"
          params={{ ...(view === 'active' ? {} : { view }), ...(q ? { q } : {}) }}
          cursor={cursor}
          nextCursor={schedules.nextCursor}
        />
      </Card>
    </div>
  )
}
