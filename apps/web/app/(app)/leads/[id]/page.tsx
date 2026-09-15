import { activityList, companyGet, companyList, contactGet, dealGet, leadGet } from '@workloom/core/modules'
import { Alert, Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { LogActivityForm, Timeline } from '@/components/crm/activity'
import { ArchivedBadge, LeadStatusBadge } from '@/components/crm/badges'
import { ConvertLeadForm, EditLeadForm, LeadStatusControls } from '@/components/crm/lead-forms'
import { ArchiveControl } from '@/components/crm/record-forms'
import { LEAD_SOURCE_LABELS, label } from '@/lib/crm-labels'
import { formatDate } from '@/lib/format'
import { memberChoices, organizationSettings, timeline } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Lead · Workloom' }

export default async function LeadPage({ params }: PageProps<'/leads/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (p: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(p)

  const [lead, members, settings] = await Promise.all([call(leadGet, { id }), memberChoices(), organizationSettings()])
  const converted = lead.status === 'converted'
  const workable = !converted && !lead.archivedAt

  const [activities, companies, convertedTo] = await Promise.all([
    can('activity:read') ? call(activityList, { leadId: id, limit: 100 }) : null,
    workable && can('lead:convert') ? call(companyList, { limit: 100 }) : null,
    converted
      ? Promise.all([
          lead.convertedCompanyId && can('company:read') ? call(companyGet, { id: lead.convertedCompanyId }) : null,
          lead.convertedContactId && can('contact:read') ? call(contactGet, { id: lead.convertedContactId }) : null,
          lead.convertedDealId && can('deal:read') ? call(dealGet, { id: lead.convertedDealId }) : null,
        ])
      : null,
  ])

  const title = lead.contactName ?? lead.companyName ?? lead.email ?? 'Lead'
  const returnTo = `/leads/${id}`

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/leads" className="text-sm text-neutral-500 hover:underline">← Leads</Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
            <LeadStatusBadge status={lead.status} />
            {lead.archivedAt && <ArchivedBadge />}
            <span>{label(LEAD_SOURCE_LABELS, lead.source)} · added {formatDate(lead.createdAt, settings.timezone)} · {members.nameOf(lead.ownerId)}</span>
          </p>
        </div>
        {can('lead:archive') && !converted && (
          <ArchiveControl entity="lead" id={lead.id} archived={Boolean(lead.archivedAt)} label="lead" />
        )}
      </div>

      {convertedTo && (
        <Alert tone="success">
          Converted {formatDate(lead.convertedAt, settings.timezone)} into{' '}
          {[
            convertedTo[0] && <Link key="c" href={`/companies/${convertedTo[0].id}`} className="font-medium underline">{convertedTo[0].name}</Link>,
            convertedTo[1] && <Link key="p" href={`/contacts/${convertedTo[1].id}`} className="font-medium underline">{convertedTo[1].fullName}</Link>,
            convertedTo[2] && <Link key="d" href={`/deals/${convertedTo[2].id}`} className="font-medium underline">{convertedTo[2].name}</Link>,
          ]
            .filter(Boolean)
            .flatMap((node, i) => (i === 0 ? [node] : [', ', node]))}
          .
        </Alert>
      )}
      {lead.status === 'disqualified' && lead.disqualifiedReason && (
        <Alert tone="warning">Disqualified: {lead.disqualifiedReason}</Alert>
      )}

      {workable && can('lead:update') && (
        <Card>
          <CardHeader title="Status" description="Work the lead through contact and qualification, then convert it." />
          <div className="p-5"><LeadStatusControls id={lead.id} status={lead.status} /></div>
        </Card>
      )}

      {workable && companies && lead.status !== 'disqualified' && (
        <Card>
          <CardHeader title="Convert" description="Turn this lead into a company and contact, and optionally open a deal. Its activity history comes along." />
          <div className="p-5">
            <ConvertLeadForm
              lead={lead}
              companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
              baseCurrency={settings.baseCurrency}
            />
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <div className="p-5">
            {!converted && can('lead:update') ? (
              <EditLeadForm lead={lead} members={members.choices} />
            ) : (
              <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
                {(
                  [
                    ['Email', lead.email],
                    ['Phone', lead.phone],
                    ['Company', lead.companyName],
                    ['Website', lead.website],
                    ['What they need', lead.details],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-neutral-500">{k}</dt>
                    <dd className="whitespace-pre-wrap">{v ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </Card>

        {activities && (
          <Card className="self-start">
            <CardHeader title="Activity" />
            {can('activity:create') && !lead.archivedAt && (
              <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
                <LogActivityForm target="leadId" targetId={lead.id} returnTo={returnTo} />
              </div>
            )}
            <Timeline entries={timeline(activities.data, settings.timezone)} canDelete={can('activity:delete')} returnTo={returnTo} />
          </Card>
        )}
      </div>
    </div>
  )
}
