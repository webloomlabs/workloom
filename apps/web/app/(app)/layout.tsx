import { auth } from '@workloom/auth'
import { headers } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { OrganizationSwitcher } from '@/components/org-switcher'
import { signOutAction } from '@/lib/actions/auth'
import { getSession } from '@/lib/server/viewer'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/sign-in')

  const organizations = await auth.api.listOrganizations({ headers: await headers() })

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm font-semibold tracking-tight">Workloom</Link>
            {organizations.length > 0 && (
              <OrganizationSwitcher
                organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
                activeId={session.session.activeOrganizationId ?? null}
              />
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-neutral-500 sm:inline">{session.user.email}</span>
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
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  )
}
