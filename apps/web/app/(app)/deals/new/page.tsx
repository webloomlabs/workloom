import { companyList, contactList } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { CreateDealForm } from '@/components/crm/record-forms'
import { memberChoices, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'New deal · Workloom' }

export default async function NewDealPage({ searchParams }: PageProps<'/deals/new'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const companyId = param(query.companyId) ?? null

  const [companies, contacts, members, settings] = await Promise.all([
    call(companyList, { limit: 100 }),
    call(contactList, { limit: 100, ...(companyId ? { companyId } : {}) }),
    memberChoices(),
    organizationSettings(),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          <Link href={companyId ? `/companies/${companyId}` : '/pipeline'} className="text-sm text-muted hover:text-ink">← Back</Link>
        }
        title="New deal"
      />
      <Card>
        <CardHeader title="Deal" description="Deals open in the pipeline. Winning one makes its company a client." />
        <div className="p-5">
          <CreateDealForm
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            contacts={contacts.data.map((c) => ({ id: c.id, name: c.companyName ? `${c.fullName} (${c.companyName})` : c.fullName }))}
            members={members.choices}
            currentUserId={viewer.actor.type === 'user' ? viewer.actor.id : null}
            companyId={companyId}
            baseCurrency={settings.baseCurrency}
          />
        </div>
      </Card>
    </div>
  )
}
