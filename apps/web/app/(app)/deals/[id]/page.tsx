import { minorToDecimalString } from '@workloom/core'
import { activityList, contactList, dealGet, quoteList } from '@workloom/core/modules'
import { Alert, Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { LogActivityForm, Timeline } from '@/components/crm/activity'
import { ArchivedBadge, DealStageBadge } from '@/components/crm/badges'
import { QuoteStatusBadge } from '@/components/finance/badges'
import { ArchiveControl, DealStageControl, EditDealForm } from '@/components/crm/record-forms'
import { formatDate } from '@/lib/format'
import { memberChoices, money, organizationSettings, timeline } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Deal · Workloom' }

export default async function DealPage({ params }: PageProps<'/deals/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (p: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(p)

  const [deal, members, settings] = await Promise.all([call(dealGet, { id }), memberChoices(), organizationSettings()])
  const [activities, contacts, quotes] = await Promise.all([
    can('activity:read') ? call(activityList, { dealId: id, limit: 100 }) : null,
    can('deal:update') && can('contact:read') ? call(contactList, { companyId: deal.companyId, limit: 100 }) : null,
    can('quote:read') ? call(quoteList, { dealId: id, limit: 50 }) : null,
  ])
  const returnTo = `/deals/${id}`
  const live = !deal.archivedAt

  const contactChoices = (contacts?.data ?? []).map((c) => ({ id: c.id, name: c.fullName }))
  if (deal.contactId && deal.contactName && !contactChoices.some((c) => c.id === deal.contactId)) {
    contactChoices.unshift({ id: deal.contactId, name: deal.contactName })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/pipeline" className="text-sm text-neutral-500 hover:underline">← Pipeline</Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{deal.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
            <DealStageBadge stage={deal.stage} />
            {deal.archivedAt && <ArchivedBadge />}
            <span className="font-medium tabular-nums text-neutral-800 dark:text-neutral-200">{money(deal.valueMinor, deal.currency)}</span>
            <Link href={`/companies/${deal.companyId}`} className="hover:underline">· {deal.companyName}</Link>
            {deal.contactId && <Link href={`/contacts/${deal.contactId}`} className="hover:underline">· {deal.contactName}</Link>}
            <span>· {members.nameOf(deal.ownerId)}</span>
          </p>
        </div>
        {can('deal:archive') && <ArchiveControl entity="deal" id={deal.id} archived={!live} label="deal" />}
      </div>

      {deal.stage === 'won' && (
        <Alert tone="success">
          Won {formatDate(deal.closedAt, settings.timezone)}.
          {can('project:create') && (
            <>
              {' '}
              <Link href={`/projects/new?dealId=${deal.id}`} className="font-medium underline">Start the project</Link>
            </>
          )}
        </Alert>
      )}
      {deal.stage === 'lost' && (
        <Alert tone="warning">Lost {formatDate(deal.closedAt, settings.timezone)}{deal.lostReason ? `: ${deal.lostReason}` : '.'}</Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {live && can('deal:update') && (
            <Card>
              <CardHeader title="Stage" description="Winning the deal makes the company a client." />
              <div className="p-5"><DealStageControl id={deal.id} stage={deal.stage} /></div>
            </Card>
          )}
          <Card>
            <CardHeader title="Details" />
            <div className="p-5">
              {can('deal:update') ? (
                <EditDealForm
                  deal={{ ...deal, value: minorToDecimalString(deal.valueMinor, deal.currency) }}
                  members={members.choices}
                  contacts={contactChoices}
                />
              ) : (
                <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
                  <dt className="text-neutral-500">Expected close</dt><dd>{formatDate(deal.expectedCloseDate)}</dd>
                  <dt className="text-neutral-500">Opened</dt><dd>{formatDate(deal.createdAt, settings.timezone)}</dd>
                </dl>
              )}
            </div>
          </Card>

          {quotes && (
            <Card>
              <CardHeader
                title="Quotes"
                action={live && can('quote:create') && deal.stage !== 'lost' ? <Link href={`/quotes/new?dealId=${deal.id}`} className="text-sm font-medium hover:underline">Create quote</Link> : null}
              />
              {quotes.data.length === 0 ? (
                <EmptyState>No quotes for this deal.</EmptyState>
              ) : (
                <Table>
                  <thead><tr><Th>Quote</Th><Th>Status</Th><Th className="text-right">Total</Th></tr></thead>
                  <tbody>
                    {quotes.data.map((q) => (
                      <tr key={q.id}>
                        <Td>
                          <Link href={`/quotes/${q.id}`} className="font-medium hover:underline">{q.title}</Link>
                          <div className="text-xs text-neutral-500">{q.number ?? 'Draft'}</div>
                        </Td>
                        <Td><QuoteStatusBadge status={q.status} /></Td>
                        <Td className="whitespace-nowrap text-right tabular-nums">{money(q.totalMinor, q.currency)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}
        </div>

        {activities && (
          <Card className="self-start">
            <CardHeader title="Activity" />
            {live && can('activity:create') && (
              <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
                <LogActivityForm target="dealId" targetId={deal.id} returnTo={returnTo} />
              </div>
            )}
            <Timeline entries={timeline(activities.data, settings.timezone)} canDelete={can('activity:delete')} returnTo={returnTo} />
          </Card>
        )}
      </div>
    </div>
  )
}
