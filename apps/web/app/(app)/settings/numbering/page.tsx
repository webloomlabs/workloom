import { documentSequenceList } from '@workloom/core/modules'
import { Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import { SequenceForm } from '@/components/sequence-form'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Numbering · Workloom' }

const TITLES = { invoice: 'Invoices', quote: 'Quotes', expense: 'Expenses', ticket: 'Support tickets' } as const

export default async function NumberingPage() {
  const viewer = await requireViewer()
  const { data } = await call(documentSequenceList, {})
  const canEdit = viewer.permissions.has('organization:update')
  return (
    <div className="space-y-6">
      {data.map((sequence) => (
        <Card key={sequence.kind}>
          <CardHeader title={TITLES[sequence.kind]} description={`The next one issued today will be ${sequence.nextNumber}.`} />
          <div className="p-5">
            <SequenceForm sequence={sequence} canEdit={canEdit} />
          </div>
        </Card>
      ))}
    </div>
  )
}
