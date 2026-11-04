import { companyList, projectList, taxRateList } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { CreateScheduleForm } from '@/components/service/schedule-forms'
import { todayIn } from '@/lib/format'
import { organizationSettings } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'New recurring schedule · Workloom' }

export default async function NewSchedulePage({ searchParams }: PageProps<'/recurring/new'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const [companies, taxRates, settings, projects] = await Promise.all([
    call(companyList, { limit: 100 }),
    call(taxRateList, {}),
    organizationSettings(),
    viewer.permissions.has('project:read') ? call(projectList, { limit: 100 }) : { data: [] },
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/recurring" className="text-sm text-muted hover:text-ink">← Recurring billing</Link>}
        title="New recurring schedule"
      />
      <Card>
        <CardHeader
          title="Schedule"
          description="It raises a draft invoice each period and stops there. Issuing and sending stay a decision someone makes."
        />
        <div className="p-5">
          <CreateScheduleForm
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            taxRates={taxRates.data.map((t) => ({ id: t.id, name: `${t.name} (${t.rate}%)` }))}
            baseCurrency={settings.baseCurrency}
            today={todayIn(settings.timezone)}
            companyId={param(query.companyId)}
            projects={projects.data.map((p) => ({ id: p.id, name: p.companyName ? `${p.name} · ${p.companyName}` : p.name }))}
            projectId={param(query.projectId)}
          />
        </div>
      </Card>
    </div>
  )
}
