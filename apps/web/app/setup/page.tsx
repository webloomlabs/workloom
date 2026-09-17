import { Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth-shell'
import { SetupForm } from '@/components/setup-form'
import { isMultiTenant, needsSetup } from '@/lib/server/tenancy'

export const metadata: Metadata = { title: 'Set up Workloom · Workloom' }

/**
 * First run.
 *
 * A single-tenant installation has no sign-up, so this is the one screen that
 * creates an account without one already existing. It is open to whoever
 * reaches it, and closes for good the moment it succeeds -- so the honest
 * instruction is to complete it as soon as the stack is up, which is what
 * docs/installation.md says.
 */
export default async function SetupPage() {
  if (isMultiTenant()) redirect('/sign-up')
  if (!(await needsSetup())) redirect('/sign-in')

  return (
    <AuthShell wide>
      <Card>
        <CardHeader
          title="Set up Workloom"
          description="Create the administrator account and the organization everything will belong to. This screen closes once it is done."
        />
        <div className="p-5">
          <SetupForm />
        </div>
      </Card>
    </AuthShell>
  )
}
