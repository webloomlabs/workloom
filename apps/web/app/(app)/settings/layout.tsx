import { PageHeader } from '@workloom/ui'
import { SettingsNav } from '@/components/settings-nav'
import { requireViewer } from '@/lib/server/viewer'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer()

  // Hiding a tab is a courtesy, not a control: every page's data comes from a
  // procedure that checks the permission again.
  const items = [
    { href: '/settings/organization', label: 'Organization', permission: 'organization:read' },
    { href: '/settings/members', label: 'Members', permission: 'member:read' },
    { href: '/settings/rates', label: 'Rates', permission: 'report:readFinancial' },
    { href: '/settings/services', label: 'Services', permission: 'service:read' },
    { href: '/settings/tax-rates', label: 'Tax rates', permission: 'taxRate:read' },
    { href: '/settings/api-keys', label: 'API keys', permission: 'apiKey:read' },
    { href: '/settings/webhooks', label: 'Webhooks', permission: 'webhook:read' },
    { href: '/settings/audit-log', label: 'Audit log', permission: 'auditLog:read' },
  ] as const

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="How this organization works, and who can work in it." />
      <SettingsNav
        items={items
          .filter((i) => viewer.permissions.has(i.permission))
          .map(({ href, label }) => ({ href, label }))}
      />
      {children}
    </div>
  )
}
