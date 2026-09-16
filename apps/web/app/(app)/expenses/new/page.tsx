import { companyList, organizationGet, projectList, taxRateList } from '@workloom/core/modules'
import { Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { param } from '@/components/crm/list-controls'
import { ExpenseForm } from '@/components/finance/expense-forms'
import { todayIn } from '@/lib/format'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Record an expense · Workloom' }

export default async function NewExpensePage({ searchParams }: PageProps<'/expenses/new'>) {
  const query = await searchParams
  const viewer = await requireViewer()
  const projectId = param(query.projectId) ?? null
  const companyId = param(query.companyId) ?? null

  const [companies, projects, taxRates, organization] = await Promise.all([
    call(companyList, { limit: 100 }),
    viewer.permissions.has('project:read') ? call(projectList, { limit: 100 }) : { data: [] },
    viewer.permissions.has('taxRate:read') ? call(taxRateList, {}) : { data: [] },
    call(organizationGet, {}),
  ])

  return (
    <div className="space-y-6">
      <div>
        <Link href="/expenses" className="text-sm text-neutral-500 hover:underline">← Expenses</Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Record an expense</h1>
      </div>
      <Card>
        <CardHeader title="Expense" description="A billable expense is rebilled onto a draft invoice at cost plus its markup." />
        <div className="p-5">
          <ExpenseForm
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            projects={projects.data.map((p) => ({ id: p.id, name: p.name }))}
            taxRates={taxRates.data.map((t) => ({ id: t.id, name: t.name, rate: t.rate }))}
            baseCurrency={organization.baseCurrency}
            expense={{
              description: '',
              supplier: null,
              category: 'other',
              incurredOn: todayIn(organization.timezone),
              projectId,
              companyId,
              currency: organization.baseCurrency,
              amount: '',
              taxRateId: null,
              billable: false,
              markupPercent: null,
              notes: null,
            }}
          />
        </div>
      </Card>
    </div>
  )
}
