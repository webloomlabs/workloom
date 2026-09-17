import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth-shell'
import { needsSetup } from '@/lib/server/tenancy'

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Nothing here works before the first account exists: there is nobody to
  // sign in as, and no way to become somebody. Setup lives outside this group
  // so that this redirect cannot loop.
  if (await needsSetup()) redirect('/setup')

  return <AuthShell>{children}</AuthShell>
}
