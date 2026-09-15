import { companyList } from '@workloom/core/modules'
import { Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { CreateProjectForm } from '@/components/projects/project-forms'
import { memberChoices, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'New project · Workloom' }

export default async function NewProjectPage({ searchParams }: PageProps<'/projects/new'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const companyId = param(query.companyId) ?? null
  const dealId = param(query.dealId) ?? null

  const [companies, members, settings] = await Promise.all([
    viewer.permissions.has('company:read') ? call(companyList, { limit: 100 }) : { data: [] },
    memberChoices(),
    organizationSettings(),
  ])

  return (
    <div className="space-y-6">
      <div>
        <Link href={dealId ? `/deals/${dealId}` : '/projects'} className="text-sm text-neutral-500 hover:underline">← Back</Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">New project</h1>
      </div>
      <Card>
        <CardHeader
          title="Project"
          description={dealId ? 'Delivering a won deal. The client comes from the deal.' : 'You become its manager, and can add the team next.'}
        />
        <div className="p-5">
          <CreateProjectForm
            project={{ companyId, dealId, currency: settings.baseCurrency, ownerId: viewer.actor.type === 'user' ? viewer.actor.id : null }}
            members={members.choices}
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            financial={viewer.permissions.has('report:readFinancial')}
            baseCurrency={settings.baseCurrency}
          />
        </div>
      </Card>
    </div>
  )
}
