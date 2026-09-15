import { companyList, contactList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ArchivedBadge } from '@/components/crm/badges'
import { Pager, param, SearchBox } from '@/components/crm/list-controls'
import { CreateContactForm } from '@/components/crm/record-forms'
import { memberChoices } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Contacts · Workloom' }

export default async function ContactsPage({ searchParams }: PageProps<'/contacts'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const q = param(query.q)
  const cursor = param(query.cursor)
  const canCreate = viewer.permissions.has('contact:create')

  const [{ data: contacts, nextCursor }, members, companies] = await Promise.all([
    call(contactList, { q, cursor, limit: 50 }),
    memberChoices(),
    canCreate ? call(companyList, { limit: 100 }) : null,
  ])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Contacts</h1>
        <SearchBox action="/contacts" q={q} placeholder="Name or email" />
      </div>

      {companies && (
        <Card>
          <details>
            <summary className="cursor-pointer px-5 py-4 text-sm font-semibold">Add a contact</summary>
            <div className="border-t border-neutral-200 p-5 dark:border-neutral-800">
              <CreateContactForm
                members={members.choices}
                currentUserId={viewer.actor.type === 'user' ? viewer.actor.id : null}
                companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
              />
            </div>
          </details>
        </Card>
      )}

      <Card>
        <CardHeader title="Contacts" />
        {contacts.length === 0 ? (
          <EmptyState>{q ? 'No contacts match.' : 'No contacts yet.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Company</Th><Th>Email</Th><Th>Phone</Th></tr></thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <span className="flex items-center gap-2">
                      <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link>
                      {c.archivedAt && <ArchivedBadge />}
                    </span>
                    {c.jobTitle && <div className="text-xs text-neutral-500">{c.jobTitle}</div>}
                  </Td>
                  <Td>{c.companyId ? <Link href={`/companies/${c.companyId}`} className="hover:underline">{c.companyName}</Link> : '—'}</Td>
                  <Td className="text-neutral-600">{c.email ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-neutral-600">{c.phone ?? '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager base="/contacts" params={q ? { q } : {}} cursor={cursor} nextCursor={nextCursor} />
      </Card>
    </div>
  )
}
