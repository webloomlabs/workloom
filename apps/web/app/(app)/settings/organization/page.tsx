import { organizationGet } from '@workloom/core/modules'
import { Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import { LogoForm, OrganizationForm } from '@/components/organization-form'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Organization settings · Workloom' }

export default async function OrganizationSettingsPage() {
  const viewer = await requireViewer()
  const organization = await call(organizationGet, {})
  const canEdit = viewer.permissions.has('organization:update')

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Logo" description="Printed at the top of every quote and invoice." />
        <div className="p-5">
          <LogoForm hasLogo={organization.hasLogo} canEdit={canEdit} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Organization" description="How your organization appears, and the defaults for money and dates." />
        <div className="p-5">
          <OrganizationForm timezones={Intl.supportedValuesOf('timeZone')} organization={organization} canEdit={canEdit} />
        </div>
      </Card>
    </div>
  )
}
