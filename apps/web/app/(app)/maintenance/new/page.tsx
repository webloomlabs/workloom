import { billingScheduleList, companyList } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CreatePlanForm } from '@/components/service/plan-forms'
import { memberChoices } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'New maintenance plan · Workloom' }

export default async function NewPlanPage() {
  const viewer = await requireViewer()

  const [companies, members, schedules] = await Promise.all([
    call(companyList, { limit: 100 }),
    memberChoices(),
    viewer.permissions.has('billingSchedule:read')
      ? call(billingScheduleList, { status: 'active', limit: 100 })
      : Promise.resolve({ data: [] }),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/maintenance" className="text-sm text-muted hover:text-ink">← Maintenance</Link>}
        title="New maintenance plan"
      />
      <Card>
        <CardHeader
          title="Plan"
          description="What the agency looks after, what it answers in, and which recurring schedule bills for it."
        />
        <div className="p-5">
          <CreatePlanForm
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            members={members.choices}
            schedules={schedules.data.map((s) => ({ id: s.id, name: `${s.name} · ${s.companyName}` }))}
          />
        </div>
      </Card>
    </div>
  )
}
