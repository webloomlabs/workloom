import { Card } from '@workloom/ui'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { SignUpForm } from '@/components/auth-forms'
import { getSession, safeRedirectPath } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Create account · Workloom' }

export default async function SignUpPage({ searchParams }: PageProps<'/sign-up'>) {
  const params = await searchParams
  const next = typeof params.next === 'string' ? safeRedirectPath(params.next) : undefined
  if (await getSession()) redirect(next ?? '/')

  return (
    <Card className="p-6">
      <h1 className="mb-5 text-lg font-semibold">Create your account</h1>
      <SignUpForm
        {...(next ? { next } : {})}
        {...(typeof params.email === 'string' ? { email: params.email } : {})}
      />
    </Card>
  )
}
