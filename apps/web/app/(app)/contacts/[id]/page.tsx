import { activityList, companyList, contactGet, dealList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { LogActivityForm, Timeline } from '@/components/crm/activity'
import { ArchivedBadge, DealStageBadge } from '@/components/crm/badges'
import { ArchiveControl, EditContactForm } from '@/components/crm/record-forms'
import { memberChoices, money, organizationSettings, timeline } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Contact · Workloom' }

export default async function ContactPage({ params }: PageProps<'/contacts/[id]'>) {
  const { id } = await params
  const viewer = await requireViewer()
  const can = (p: Parameters<typeof viewer.permissions.has>[0]) => viewer.permissions.has(p)

  const [contact, members, settings] = await Promise.all([call(contactGet, { id }), memberChoices(), organizationSettings()])
  const [deals, activities, companies] = await Promise.all([
    can('deal:read') ? call(dealList, { contactId: id, limit: 100 }) : null,
    can('activity:read') ? call(activityList, { contactId: id, limit: 100 }) : null,
    can('contact:update') ? call(companyList, { limit: 100 }) : null,
  ])
  const returnTo = `/contacts/${id}`
  const live = !contact.archivedAt

  // The contact's own company must be selectable even if it is not in the first page.
  const companyChoices = (companies?.data ?? []).map((c) => ({ id: c.id, name: c.name }))
  if (contact.companyId && contact.companyName && !companyChoices.some((c) => c.id === contact.companyId)) {
    companyChoices.unshift({ id: contact.companyId, name: contact.companyName })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/contacts" className="text-sm text-neutral-500 hover:underline">← Contacts</Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{contact.fullName}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
            {contact.archivedAt && <ArchivedBadge />}
            {contact.jobTitle && <span>{contact.jobTitle}</span>}
            {contact.companyId && (
              <Link href={`/companies/${contact.companyId}`} className="hover:underline">at {contact.companyName}</Link>
            )}
            {contact.email && <a href={`mailto:${contact.email}`} className="hover:underline">{contact.email}</a>}
          </p>
        </div>
        {can('contact:archive') && <ArchiveControl entity="contact" id={contact.id} archived={!live} label="contact" />}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {deals && (
            <Card>
              <CardHeader title="Deals" />
              {deals.data.length === 0 ? (
                <EmptyState>Not the main contact on any deal.</EmptyState>
              ) : (
                <Table>
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
              {can('contact:update') ? (
                <EditContactForm contact={contact} members={members.choices} companies={companyChoices} />
              ) : (
                <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
                  <dt className="text-neutral-500">Phone</dt><dd>{contact.phone ?? '—'}</dd>
                  <dt className="text-neutral-500">Owner</dt><dd>{members.nameOf(contact.ownerId)}</dd>
                </dl>
              )}
            </div>
          </Card>
        </div>

        {activities && (
          <Card className="self-start">
            <CardHeader title="Activity" />
            {live && can('activity:create') && (
              <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
                <LogActivityForm target="contactId" targetId={contact.id} returnTo={returnTo} />
              </div>
            )}
            <Timeline
              entries={timeline(activities.data, settings.timezone, { deals: new Map((deals?.data ?? []).map((d) => [d.id, d.name])) })}
              canDelete={can('activity:delete')}
              returnTo={returnTo}
            />
          </Card>
        )}
      </div>
    </div>
  )
}
