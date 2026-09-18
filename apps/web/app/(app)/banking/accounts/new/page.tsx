import { Card, CardHeader, PageHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CreateAccountForm } from '@/components/banking/account-forms'
import { organizationSettings } from '@/lib/server/crm'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Add account · Workloom' }

export default async function NewBankAccountPage() {
  await requireViewer()
  const settings = await organizationSettings()

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<Link href="/banking" className="text-sm text-muted hover:text-ink">← Banking</Link>}
        title="Add account"
      />
      <Card>
        <CardHeader
          title="The account"
          description="Take the opening balance from a statement rather than from today's app balance: it is the anchor every reconciliation on this account is measured from, and it cannot be moved once transactions exist."
        />
        <div className="p-5">
          <CreateAccountForm baseCurrency={settings.baseCurrency} />
        </div>
      </Card>
    </div>
  )
}
