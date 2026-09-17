import { Card } from '@workloom/ui'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { SignUpForm } from '@/components/auth-forms'
import { getSession, safeRedirectPath } from '@/lib/server/viewer'
import { isMultiTenant } from '@/lib/server/tenancy'

export const metadata: Metadata = { title: 'Create account · Workloom' }

export default async function SignUpPage({ searchParams }: PageProps<'/sign-up'>) {
  // A single-tenant installation has no public sign-up: an administrator
  // creates each account from Settings -> Members. Better Auth refuses the
  // endpoint regardless; this only keeps a stale link from ending on a form
  // that cannot work.
  if (!isMultiTenant()) redirect('/sign-in')

  const params = await searchParams
  const next = typeof params.next === 'string' ? safeRedirectPath(params.next) : undefined
  if (await getSession()) redirect(next ?? '/')

  return (
    <Card className="p-6 sm:p-7">
      <h1 className="mb-5 text-lg font-semibold tracking-tight text-ink">Create your account</h1>
      <SignUpForm
        {...(next ? { next } : {})}
        {...(typeof params.email === 'string' ? { email: params.email } : {})}
      />
    </Card>
  )
}
