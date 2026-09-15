import { auth } from '@workloom/auth'
import type { Permission } from '@workloom/core/permissions'
import { headers } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { MainNav } from '@/components/main-nav'
import { OrganizationSwitcher } from '@/components/org-switcher'
import { signOutAction } from '@/lib/actions/auth'
import { getSession, getViewer } from '@/lib/server/viewer'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/sign-in')

  const organizations = await auth.api.listOrganizations({ headers: await headers() })
  const viewer = await getViewer()

  // A courtesy, like the settings tabs: each page's procedures authorise again.
  const items: Array<{ href: string; label: string; permission: Permission; match?: string[] }> = [
    { href: '/pipeline', label: 'Pipeline', permission: 'deal:read', match: ['/deals'] },
    { href: '/leads', label: 'Leads', permission: 'lead:read' },
    { href: '/clients', label: 'Clients', permission: 'company:read' },
    { href: '/companies', label: 'Companies', permission: 'company:read' },
    { href: '/contacts', label: 'Contacts', permission: 'contact:read' },
    { href: '/projects', label: 'Projects', permission: 'project:read' },
    { href: '/tasks', label: 'My tasks', permission: 'task:read' },
    { href: '/settings/organization', label: 'Settings', permission: 'organization:read', match: ['/settings'] },
  ]
  const nav = viewer
    ? items.filter((item) => viewer.permissions.has(item.permission)).map(({ permission: _, ...item }) => item)
    : []

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex min-h-14 max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link href="/" className="text-sm font-semibold tracking-tight">Workloom</Link>
            {organizations.length > 0 && (
              <OrganizationSwitcher
                organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
                activeId={session.session.activeOrganizationId ?? null}
              />
            )}
            {nav.length > 0 && <MainNav items={nav} />}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-neutral-500 2xl:inline">{session.user.email}</span>
            <form action={signOutAction}>
              <button type="submit" className="text-neutral-700 hover:underline dark:text-neutral-300">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      {!session.user.emailVerified && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Confirm your email address — check your inbox for the link. You&apos;ll need it to join
          other organizations.
        </div>
      )}
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  )
}
