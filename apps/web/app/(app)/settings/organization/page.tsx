import { organizationGet } from '@workloom/core/modules'
import { Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import { LogoForm, OrganizationForm } from '@/components/organization-form'
import { OrganizationResetButton } from '@/components/organization-reset'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Organization settings · Workloom' }

export default async function OrganizationSettingsPage() {
  const viewer = await requireViewer()
  const organization = await call(organizationGet, {})
  const canEdit = viewer.permissions.has('organization:update')
  // Resetting is destroying the organization in all but name: the owner's alone.
  const canReset = viewer.permissions.has('organization:delete') && viewer.actor.type === 'user'

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
      {canReset && (
        <Card className="border-critical/40">
          <CardHeader title="Danger zone" description="Only the owner sees this." />
          <div className="space-y-4 p-5 text-sm">
            <div className="space-y-2">
              <p className="font-medium">Reset organization</p>
              <p className="text-muted">
                Permanently deletes all of the organization&rsquo;s data: clients, contacts, leads and deals; projects,
                tasks and time; quotes, invoices, payments and expenses; bank accounts and statements; tickets,
                maintenance plans, infrastructure and documents; every uploaded file. Settings go too: tax rates,
                services, project types, expense categories, hourly rates, numbering, API keys, webhooks and the
                Telegram bot.
              </p>
              <p className="text-muted">
                Kept: the organization&rsquo;s name and profile, its members and their sign-ins, and the audit log,
                which records the reset.
              </p>
            </div>
            <OrganizationResetButton organizationName={organization.name} />
          </div>
        </Card>
      )}
    </div>
  )
}
