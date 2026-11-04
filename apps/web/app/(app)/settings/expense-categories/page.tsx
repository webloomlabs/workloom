import { expenseCategoryList } from '@workloom/core/modules'
import { Badge, Card, CardHeader, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import { CategoryControls, CreateCategoryForm } from '@/components/finance/category-forms'
import { EXPENSE_TAX_TREATMENT_LABELS } from '@/lib/finance-labels'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Expense categories · Workloom' }

export default async function ExpenseCategoriesPage() {
  const viewer = await requireViewer()
  const canEdit = viewer.permissions.has('expense:update')
  const { data } = await call(expenseCategoryList, { includeArchived: true })
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Expense categories"
          description="How expenses are filed, and how each counts in the tax pack: deductible in the year, not deductible, or capital — claimed through allowances instead."
        />
        <Table>
          <thead>
            <tr><Th>Category</Th><Th>In the tax pack</Th><Th className="text-right">Expenses</Th>{canEdit && <Th />}</tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <Tr key={c.key}>
                <Td>
                  <span className="font-medium">{c.name}</span> <span className="text-xs text-muted">{c.key}</span>
                  {c.archived && <> <Badge>Archived</Badge></>}
                </Td>
                <Td className="text-muted">{EXPENSE_TAX_TREATMENT_LABELS[c.taxTreatment]}</Td>
                <Td className="text-right tabular-nums">{c.expenseCount}</Td>
                {canEdit && <Td><CategoryControls category={c} /></Td>}
              </Tr>
            ))}
          </tbody>
        </Table>
        {canEdit && (
          <div className="border-t border-line p-5">
            <CreateCategoryForm />
          </div>
        )}
      </Card>
    </div>
  )
}
