import { maintenancePlanList, maintenanceVisitList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr, buttonStyles } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilterTabs, Pager, param, SearchBox } from '@/components/crm/list-controls'
import { PlanStatusBadge } from '@/components/service/badges'
import { label } from '@/lib/crm-labels'
import { formatDate } from '@/lib/format'
import { MAINTENANCE_VISIT_KIND_LABELS } from '@/lib/service-labels'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Maintenance · Workloom' }

const VIEWS = {
  active: { label: 'Active', filter: { status: 'active' as const } },
  paused: { label: 'Paused', filter: { status: 'paused' as const } },
  ended: { label: 'Ended', filter: { status: 'ended' as const } },
  all: { label: 'All', filter: {} },
}

export default async function MaintenancePage({ searchParams }: PageProps<'/maintenance'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const view = (param(query.view) ?? 'active') as keyof typeof VIEWS
  const { filter } = VIEWS[view] ?? VIEWS.active
  const q = param(query.q)
  const cursor = param(query.cursor)

  const [plans, visits] = await Promise.all([
    call(maintenancePlanList, { ...filter, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}), limit: 50 }),
    call(maintenanceVisitList, { limit: 8 }),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Maintenance"
        description="The agreements that continue after delivery, and the work done under them."
        actions={
          viewer.permissions.has('maintenancePlan:create') && (
            <Link href="/maintenance/new" className={buttonStyles()}>
              New plan
            </Link>
          )
        }
      />

      <Card>
        <CardHeader
          title={VIEWS[view]?.label ?? 'Active'}
          action={
            <div className="flex flex-wrap items-center gap-3">
              <FilterTabs
                active={view}
                tabs={Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label, href: key === 'active' ? '/maintenance' : `/maintenance?view=${key}` }))}
              />
              <SearchBox action="/maintenance" q={q} hidden={view === 'active' ? {} : { view }} placeholder="Plan or client" />
            </div>
          }
        />
        {plans.data.length === 0 ? (
          <EmptyState>{q || view !== 'active' ? 'Nothing matches.' : 'No plans yet. Put a client on one after their project ships.'}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Plan</Th>
                <Th>Client</Th>
                <Th>Status</Th>
                <Th>Response</Th>
                <Th>Billed</Th>
                <Th className="text-right">Visits</Th>
                <Th>Last visit</Th>
              </tr>
            </thead>
            <tbody>
              {plans.data.map((plan) => (
                <Tr key={plan.id}>
                  <Td>
                    <Link href={`/maintenance/${plan.id}`} className="font-medium hover:underline">{plan.name}</Link>
                    {plan.items.length > 0 && (
                      <div className="text-xs text-muted">{plan.items.map((i) => i.label).join(' · ')}</div>
                    )}
                  </Td>
                  <Td className="text-muted">
                    <Link href={`/companies/${plan.companyId}?tab=maintenance`} className="hover:underline">{plan.companyName}</Link>
                  </Td>
                  <Td><PlanStatusBadge status={plan.status} /></Td>
                  <Td className="whitespace-nowrap text-muted">{plan.responseHours ? `${plan.responseHours}h` : 'By priority'}</Td>
                  <Td className="text-muted">
                    {plan.billingScheduleId ? (
                      <Link href={`/recurring/${plan.billingScheduleId}`} className="hover:underline">
                        {plan.nextInvoiceOn ? `Next ${formatDate(plan.nextInvoiceOn)}` : plan.billingScheduleName}
                      </Link>
                    ) : (
                      'Not automatic'
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{plan.visitCount}</Td>
                  <Td className="whitespace-nowrap text-muted">{plan.lastVisitOn ? formatDate(plan.lastVisitOn) : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager
          base="/maintenance"
          params={{ ...(view === 'active' ? {} : { view }), ...(q ? { q } : {}) }}
          cursor={cursor}
          nextCursor={plans.nextCursor}
        />
      </Card>

      <Card>
        <CardHeader title="Recently done" description="The last few pieces of maintenance recorded, across every plan." />
        {visits.data.length === 0 ? (
          <EmptyState>Nothing recorded yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {visits.data.map((visit) => (
              <li key={visit.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
                <span>
                  <span className="font-medium text-ink">{visit.summary}</span>
                  <span className="text-muted"> · {label(MAINTENANCE_VISIT_KIND_LABELS, visit.kind)}</span>
                </span>
                <span className="text-xs text-muted">
                  <Link href={`/maintenance/${visit.planId}`} className="hover:text-ink">{visit.companyName}</Link>
                  {' · '}
                  {formatDate(visit.performedOn)}
                  {visit.performedByName ? ` · ${visit.performedByName}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
