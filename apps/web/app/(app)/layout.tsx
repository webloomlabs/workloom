import { auth } from '@workloom/auth'
import { timerGet } from '@workloom/core/modules'
import type { Permission } from '@workloom/core/permissions'
import { Alert, Button, LogOutIcon } from '@workloom/ui'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { AppShell, type NavGroup } from '@/components/app-shell'
import type { NavIconName } from '@/components/nav-icons'
import { OrganizationSwitcher } from '@/components/org-switcher'
import { ThemeToggle } from '@/components/theme-toggle'
import { RunningTimer } from '@/components/time/time-forms'
import { signOutAction } from '@/lib/actions/auth'
import { call } from '@/lib/server/procedures'
import { isMultiTenant, needsSetup } from '@/lib/server/tenancy'
import { getSession, getViewer } from '@/lib/server/viewer'

type Entry = {
  href: string
  label: string
  icon: NavIconName
  permission: Permission
  match?: string[]
}

/**
 * The sections, grouped the way the work is: who you are selling to, what the
 * money is doing, what is being delivered.
 *
 * Hiding a section is a courtesy, not a control -- every page's data comes
 * from a procedure that checks the same permission again.
 */
const SECTIONS: Array<{ key: string; label: string; items: Entry[] }> = [
  {
    key: 'overview',
    label: '',
    items: [{ href: '/', label: 'Dashboard', icon: 'home', permission: 'report:read' }],
  },
  {
    key: 'sales',
    label: 'Sales',
    items: [
      { href: '/pipeline', label: 'Pipeline', icon: 'pipeline', permission: 'deal:read', match: ['/deals'] },
      { href: '/leads', label: 'Leads', icon: 'leads', permission: 'lead:read' },
      { href: '/clients', label: 'Clients', icon: 'clients', permission: 'company:read' },
      { href: '/companies', label: 'Companies', icon: 'companies', permission: 'company:read' },
      { href: '/contacts', label: 'Contacts', icon: 'contacts', permission: 'contact:read' },
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    items: [
      { href: '/quotes', label: 'Quotes', icon: 'quotes', permission: 'quote:read' },
      { href: '/invoices', label: 'Invoices', icon: 'invoices', permission: 'invoice:read' },
      { href: '/payments', label: 'Payments', icon: 'payments', permission: 'payment:read' },
      { href: '/expenses', label: 'Expenses', icon: 'expenses', permission: 'expense:read' },
      { href: '/recurring', label: 'Recurring', icon: 'recurring', permission: 'billingSchedule:read' },
      { href: '/reports', label: 'Reports', icon: 'reports', permission: 'report:readFinancial' },
    ],
  },
  {
    key: 'delivery',
    label: 'Delivery',
    items: [
      { href: '/projects', label: 'Projects', icon: 'projects', permission: 'project:read' },
      { href: '/tasks', label: 'My tasks', icon: 'tasks', permission: 'task:read' },
      { href: '/time', label: 'Time', icon: 'time', permission: 'timeEntry:read' },
    ],
  },
  {
    key: 'service',
    label: 'Service',
    items: [
      { href: '/tickets', label: 'Tickets', icon: 'tickets', permission: 'ticket:read' },
      { href: '/maintenance', label: 'Maintenance', icon: 'maintenance', permission: 'maintenancePlan:read' },
      { href: '/infrastructure', label: 'Infrastructure', icon: 'infrastructure', permission: 'infrastructure:read' },
    ],
  },
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (await needsSetup()) redirect('/setup')

  const session = await getSession()
  if (!session) redirect('/sign-in')

  // Only worth fetching where a person can have more than one. A single-tenant
  // installation has exactly one organization and no switcher.
  const organizations = isMultiTenant()
    ? await auth.api.listOrganizations({ headers: await headers() })
    : []
  const viewer = await getViewer()

  const groups: NavGroup[] = SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    items: section.items
      .filter((item) => viewer?.permissions.has(item.permission))
      .map(({ permission: _permission, ...item }) => item),
  })).filter((group) => group.items.length > 0)

  const timer = viewer?.permissions.has('timeEntry:read') ? (await call(timerGet, {})).entry : null

  return (
    <AppShell
      brand="Workloom"
      groups={groups}
      settingsHref={viewer?.permissions.has('organization:read') ? '/settings/organization' : undefined}
      user={{ name: session.user.name || session.user.email, email: session.user.email }}
      orgSwitcher={
        organizations.length > 0 ? (
          <OrganizationSwitcher
            organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
            activeId={session.session.activeOrganizationId ?? null}
          />
        ) : undefined
      }
      timer={
        timer ? (
          <RunningTimer
            // A new timer restarts the clock.
            key={timer.id}
            entry={{
              id: timer.id,
              projectId: timer.projectId,
              projectName: timer.projectName,
              taskId: timer.taskId,
              taskTitle: timer.taskTitle,
              startedAt: timer.startedAt!.toISOString(),
            }}
          />
        ) : undefined
      }
      utilities={
        <>
          <ThemeToggle />
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="icon-sm" title="Sign out" aria-label="Sign out">
              <LogOutIcon />
            </Button>
          </form>
        </>
      }
    >
      <div className="space-y-6">
        {!session.user.emailVerified && (
          <Alert tone="warning">
            Confirm your email address — check your inbox for the link. You&apos;ll need it to join other
            organizations.
          </Alert>
        )}
        {children}
      </div>
    </AppShell>
  )
}
