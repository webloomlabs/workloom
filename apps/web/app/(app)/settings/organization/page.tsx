import { organizationGet } from '@workloom/core/modules'
import { Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import { OrganizationForm } from '@/components/organization-form'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Organization settings · Workloom' }

export default async function OrganizationSettingsPage() {
  const viewer = await requireViewer()
  const organization = await call(organizationGet, {})

  return (
    <Card>
      <CardHeader title="Organization" description="How your organization appears, and the defaults for money and dates." />
      <div className="p-5">
        <OrganizationForm organization={organization} canEdit={viewer.permissions.has('organization:update')} />
      </div>
    </Card>
  )
}
