import { companyList, projectList } from '@workloom/core/modules'
import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CreateTicketForm } from '@/components/service/ticket-forms'
import { param } from '@/components/crm/list-controls'
import { memberChoices } from '@/lib/server/crm'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Raise a ticket · Workloom' }

export default async function NewTicketPage({ searchParams }: PageProps<'/tickets/new'>) {
  const query = await searchParams
  await requireViewer()

  const [companies, projects, members] = await Promise.all([
    call(companyList, { limit: 100 }),
    call(projectList, { limit: 100 }),
    memberChoices(),
  ])
  const back = param(query.companyId) ? `/companies/${param(query.companyId)}?tab=support` : '/tickets'

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href={back} className="text-sm text-muted hover:text-ink">← Back</Link>}
        title="Raise a ticket"
      />
      <Card>
        <CardHeader
          title="Ticket"
          description="The response and resolution targets are set the moment it is raised, from the client's plan or from the priority."
        />
        <div className="p-5">
          <CreateTicketForm
            companies={companies.data.map((c) => ({ id: c.id, name: c.name }))}
            projects={projects.data.map((p) => ({ id: p.id, name: p.name }))}
            members={members.choices}
          />
        </div>
      </Card>
    </div>
  )
}
