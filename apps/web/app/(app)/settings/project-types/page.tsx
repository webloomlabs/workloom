import { projectTypeList } from '@workloom/core/modules'
import { Badge, Card, CardHeader, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import { CreateProjectTypeForm, ProjectTypeControls } from '@/components/projects/project-type-forms'
import { BUDGET_PERIOD_LABELS, PROJECT_BILLING_MODEL_LABELS } from '@/lib/project-labels'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Project types · Workloom' }

export default async function ProjectTypesPage() {
  const viewer = await requireViewer()
  const canEdit = viewer.permissions.has('project:update')
  const { data } = await call(projectTypeList, { includeArchived: true })
  return (
    <Card>
      <CardHeader
        title="Kinds of work"
        description="Each new project of a kind starts with its billing model and budget period. Projects already running keep their own."
      />
      <Table>
        <thead>
          <tr><Th>Kind</Th><Th>Paid for as</Th><Th>Budgets are for</Th><Th className="text-right">Projects</Th>{canEdit && <Th />}</tr>
        </thead>
        <tbody>
          {data.map((t) => (
            <Tr key={t.id}>
              <Td>
                <span className="inline-flex items-center gap-2 font-medium">
                  {t.color && <span aria-hidden className="size-2.5 rounded-full" style={{ background: t.color }} />}
                  {t.name}
                </span>
                {t.archived && <> <Badge>Archived</Badge></>}
              </Td>
              <Td className="text-muted">{PROJECT_BILLING_MODEL_LABELS[t.defaultBillingModel]}</Td>
              <Td className="text-muted">{BUDGET_PERIOD_LABELS[t.defaultBudgetPeriod]}</Td>
              <Td className="text-right tabular-nums">{t.projectCount}</Td>
              {canEdit && <Td><ProjectTypeControls type={t} /></Td>}
            </Tr>
          ))}
        </tbody>
      </Table>
      {canEdit && (
        <div className="border-t border-line p-5">
          <CreateProjectTypeForm />
        </div>
      )}
    </Card>
  )
}
