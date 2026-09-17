import { companyList, projectList } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CreateAssetForm } from '@/components/service/asset-forms'
import { memberChoices, organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Add infrastructure · Workloom' }

export default async function NewAssetPage() {
  await requireViewer()
  const [companies, projects, members, settings] = await Promise.all([
    call(companyList, { limit: 100 }),
    call(projectList, { limit: 100 }),
    memberChoices(),
    organizationSettings(),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/infrastructure" className="text-sm text-muted hover:text-ink">← Infrastructure</Link>}
        title="Add infrastructure"
      />
      <Card>
        <CardHeader
          title="What it is"
          description="Record the renewal date even when it renews itself: the worker announces what is approaching, and a card on file expires too."
        />
        <div className="p-5">
          <CreateAssetForm
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            projects={projects.data.map((p) => ({ id: p.id, name: p.name }))}
            members={members.choices}
            baseCurrency={settings.baseCurrency}
          />
        </div>
      </Card>
    </div>
  )
}
