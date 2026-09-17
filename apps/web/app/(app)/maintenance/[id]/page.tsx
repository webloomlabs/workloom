import { billingScheduleList, maintenancePlanGet, maintenanceVisitList, ticketList } from '@workloom/core/modules'
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DeletePlanButton, DeleteVisitButton, EditPlanForm, LogVisitForm, PlanStatusControl } from '@/components/service/plan-forms'
import { PlanStatusBadge, TicketStatusBadge } from '@/components/service/badges'
import { label } from '@/lib/crm-labels'
import { formatDate, todayIn } from '@/lib/format'
import { MAINTENANCE_VISIT_KIND_LABELS } from '@/lib/service-labels'
import { memberChoices, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Maintenance plan · Workloom' }

export default async function PlanPage({ params }: PageProps<'/maintenance/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (permission: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(permission)

  const plan = await call(maintenancePlanGet, { id }).catch(() => null)
  if (!plan) notFound()

  const [visits, settings, members, schedules, tickets] = await Promise.all([
    call(maintenanceVisitList, { planId: id, limit: 50 }),
    organizationSettings(),
    memberChoices(),
    can('billingSchedule:read') ? call(billingScheduleList, { companyId: plan.companyId, limit: 50 }) : Promise.resolve({ data: [] }),
    can('ticket:read') ? call(ticketList, { companyId: plan.companyId, open: true, limit: 10 }) : Promise.resolve({ data: [] }),
  ])

  const minutes = visits.data.reduce((total, visit) => total + (visit.minutesSpent ?? 0), 0)

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/maintenance" className="text-sm text-muted hover:text-ink">← Maintenance</Link>}
        title={plan.name}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <PlanStatusBadge status={plan.status} />
            <Link href={`/companies/${plan.companyId}?tab=maintenance`} className="hover:text-ink">{plan.companyName}</Link>
            <span>· Since {formatDate(plan.startedOn)}</span>
            {plan.endedOn && <span>· Ended {formatDate(plan.endedOn)}</span>}
            <span>· {plan.ownerName ?? 'No account manager'}</span>
          </div>
        }
        actions={
          <>
            {can('maintenancePlan:update') && <PlanStatusControl id={plan.id} status={plan.status} />}
            {can('maintenancePlan:delete') && <DeletePlanButton id={plan.id} />}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="History"
              description={`What has been done under this plan.${minutes > 0 ? ` ${Math.round((minutes / 60) * 10) / 10} hours recorded.` : ''}`}
            />
            {visits.data.length === 0 ? (
              <EmptyState>Nothing recorded yet.</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>What</Th>
                    <Th>Kind</Th>
                    <Th>By</Th>
                    <Th className="text-right">Minutes</Th>
                    <Th>When</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {visits.data.map((visit) => (
                    <Tr key={visit.id}>
                      <Td>
                        <span className="font-medium">{visit.summary}</span>
                        {visit.notes && <div className="text-xs text-muted">{visit.notes}</div>}
                      </Td>
                      <Td className="text-muted">{label(MAINTENANCE_VISIT_KIND_LABELS, visit.kind)}</Td>
                      <Td className="text-muted">{visit.performedByName ?? '—'}</Td>
                      <Td className="text-right tabular-nums">{visit.minutesSpent ?? '—'}</Td>
                      <Td className="whitespace-nowrap text-muted">{formatDate(visit.performedOn)}</Td>
                      <Td className="text-right">
                        {can('maintenancePlan:update') && <DeleteVisitButton id={visit.id} planId={plan.id} />}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
            {can('maintenancePlan:update') && plan.status !== 'ended' && (
              <CardBody className="border-t border-line">
                <LogVisitForm planId={plan.id} members={members.choices} today={todayIn(settings.timezone)} />
              </CardBody>
            )}
          </Card>

          {can('maintenancePlan:update') && (
            <Card>
              <details>
                <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-ink">Edit plan</summary>
                <CardBody className="border-t border-line">
                  <EditPlanForm
                    plan={plan}
                    companies={[{ id: plan.companyId, name: plan.companyName }]}
                    members={members.choices}
                    schedules={schedules.data.map((s) => ({ id: s.id, name: s.name }))}
                  />
                </CardBody>
              </details>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="What it covers" />
            {plan.items.length === 0 ? (
              <EmptyState>Nothing listed. Edit the plan to say what the client is promised.</EmptyState>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {plan.items.map((item) => (
                  <li key={item.id} className="px-5 py-2.5 text-ink">{item.label}</li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Terms" />
            <CardBody className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted">Response</span>
                <span className="text-ink">{plan.responseHours ? `${plan.responseHours} hours` : "The priority's default"}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted">Resolution</span>
                <span className="text-ink">{plan.resolutionHours ? `${plan.resolutionHours} hours` : "The priority's default"}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted">Included hours</span>
                <span className="text-ink">{plan.includedHours ?? 'Not capped'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted">Billing</span>
                <span className="text-ink">
                  {plan.billingScheduleId ? (
                    <Link href={`/recurring/${plan.billingScheduleId}`} className="hover:underline">
                      {plan.billingScheduleName}
                    </Link>
                  ) : (
                    'Not automatic'
                  )}
                </span>
              </div>
              {plan.nextInvoiceOn && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted">Next invoice</span>
                  <span className="text-ink">{formatDate(plan.nextInvoiceOn)}</span>
                </div>
              )}
            </CardBody>
            {plan.description && <CardBody className="border-t border-line text-sm text-muted">{plan.description}</CardBody>}
          </Card>

          {can('ticket:read') && (
            <Card>
              <CardHeader title="Open tickets" description="What this client is waiting on." />
              {tickets.data.length === 0 ? (
                <EmptyState>Nothing outstanding.</EmptyState>
              ) : (
                <ul className="divide-y divide-line">
                  {tickets.data.map((ticket) => (
                    <li key={ticket.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                      <Link href={`/tickets/${ticket.id}`} className="truncate hover:underline">{ticket.title}</Link>
                      <TicketStatusBadge status={ticket.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
