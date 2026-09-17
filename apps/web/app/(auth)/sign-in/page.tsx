import { Card } from '@workloom/ui'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { SignInForm } from '@/components/auth-forms'
import { isMultiTenant } from '@/lib/server/tenancy'
import { getSession, safeRedirectPath } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Sign in · Workloom' }

export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const params = await searchParams
  const next = typeof params.next === 'string' ? safeRedirectPath(params.next) : undefined
  if (await getSession()) redirect(next ?? '/')

  return (
    <Card className="p-6 sm:p-7">
      <h1 className="mb-5 text-lg font-semibold tracking-tight text-ink">Sign in</h1>
      <SignInForm
        canSignUp={isMultiTenant()}
        {...(next ? { next } : {})}
        {...(params.reset ? { notice: 'Password updated. Sign in with your new password.' } : {})}
      />
    </Card>
  )
}
