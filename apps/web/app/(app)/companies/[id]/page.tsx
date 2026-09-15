import { activityList, companyGet, contactList, dealList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { LogActivityForm, Timeline } from '@/components/crm/activity'
import { ArchivedBadge, DealStageBadge, LifecycleBadge } from '@/components/crm/badges'
import { ArchiveControl, CreateContactForm, EditCompanyForm } from '@/components/crm/record-forms'
import { formatDate } from '@/lib/format'
import { memberChoices, money, organizationSettings, timeline } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Company · Workloom' }

export default async function CompanyPage({ params }: PageProps<'/companies/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (p: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(p)

  const [company, members, settings] = await Promise.all([call(companyGet, { id }), memberChoices(), organizationSettings()])
  const [contacts, deals, activities] = await Promise.all([
    can('contact:read') ? call(contactList, { companyId: id, limit: 100 }) : null,
    can('deal:read') ? call(dealList, { companyId: id, limit: 100 }) : null,
    can('activity:read') ? call(activityList, { companyId: id, limit: 100 }) : null,
  ])

  const returnTo = `/companies/${id}`
  const dealNames = new Map((deals?.data ?? []).map((d) => [d.id, d.name]))
  const contactNames = new Map((contacts?.data ?? []).map((c) => [c.id, c.fullName]))
  const live = !company.archivedAt

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/companies" className="text-sm text-neutral-500 hover:underline">← Companies</Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{company.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
            <LifecycleBadge stage={company.lifecycleStage} />
            {company.archivedAt && <ArchivedBadge />}
            {company.becameClientAt && <span>Client since {formatDate(company.becameClientAt, settings.timezone)}</span>}
            <span>· {members.nameOf(company.ownerId)}</span>
            {company.website && (
              <a href={company.website} target="_blank" rel="noreferrer noopener" className="hover:underline">
                · {company.website.replace(/^https?:\/\//, '')}
              </a>
            )}
          </p>
        </div>
        {can('company:archive') && <ArchiveControl entity="company" id={company.id} archived={!live} label="company" />}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {contacts && (
            <Card>
              <CardHeader title="Contacts" />
              {contacts.data.length === 0 ? (
                <EmptyState>No contacts yet.</EmptyState>
              ) : (
                <Table>
                  <tbody>
                    {contacts.data.map((c) => (
                      <tr key={c.id}>
                        <Td>
                          <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link>
                          {c.jobTitle && <div className="text-xs text-neutral-500">{c.jobTitle}</div>}
                        </Td>
                        <Td className="text-neutral-600">{c.email ?? c.phone ?? ''}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {live && can('contact:create') && (
                <details className="border-t border-neutral-200 dark:border-neutral-800">
                  <summary className="cursor-pointer px-5 py-3 text-sm font-medium">Add a contact</summary>
                  <div className="px-5 pb-5">
                    <CreateContactForm
                      members={members.choices}
                      currentUserId={viewer.actor.type === 'user' ? viewer.actor.id : null}
                      companyId={company.id}
                      returnTo={returnTo}
                    />
                  </div>
                </details>
              )}
            </Card>
          )}

          {deals && (
            <Card>
              <CardHeader
                title="Deals"
                action={live && can('deal:create') ? <Link href={`/deals/new?companyId=${company.id}`} className="text-sm font-medium hover:underline">New deal</Link> : null}
              />
              {deals.data.length === 0 ? (
                <EmptyState>No deals yet.</EmptyState>
              ) : (
                <Table>
                  <thead><tr><Th>Deal</Th><Th>Stage</Th><Th className="text-right">Value</Th></tr></thead>
                  <tbody>
                    {deals.data.map((d) => (
                      <tr key={d.id}>
                        <Td><Link href={`/deals/${d.id}`} className="font-medium hover:underline">{d.name}</Link></Td>
                        <Td><DealStageBadge stage={d.stage} /></Td>
                        <Td className="whitespace-nowrap text-right tabular-nums">{money(d.valueMinor, d.currency)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}

          <Card>
            <CardHeader title="Details" />
            <div className="p-5">
              {can('company:update') ? (
                <EditCompanyForm company={company} members={members.choices} />
              ) : (
                <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
                  {(
                    [
                      ['Industry', company.industry],
                      ['Email', company.email],
                      ['Phone', company.phone],
                      ['Address', company.address],
                      ['About', company.description],
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
        </div>

        {activities && (
          <Card className="self-start">
            <CardHeader title="Activity" description="Everything logged against this company, its contacts, and its deals." />
            {live && can('activity:create') && (
              <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
                <LogActivityForm target="companyId" targetId={company.id} returnTo={returnTo} />
              </div>
            )}
            <Timeline
              entries={timeline(activities.data, settings.timezone, { deals: dealNames, contacts: contactNames, showLead: true })}
              canDelete={can('activity:delete')}
              returnTo={returnTo}
            />
          </Card>
        )}
      </div>
    </div>
  )
}
