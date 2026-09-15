import { Alert, Card } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ResetPasswordForm } from '@/components/auth-forms'

export const metadata: Metadata = { title: 'Choose a new password · Workloom' }

export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  const params = await searchParams
  const token = typeof params.token === 'string' ? params.token : null

  // Better Auth redirects here with ?error=INVALID_TOKEN for expired or used links.
  if (!token || params.error) {
    return (
      <Card className="space-y-4 p-6">
        <h1 className="text-lg font-semibold">This link has expired</h1>
        <Alert tone="warning">Reset links work once and expire after an hour.</Alert>
        <Link href="/forgot-password" className="text-sm font-medium hover:underline">Send a new link</Link>
      </Card>
    )
  }

  return (
    <Card className="p-6">
      <h1 className="mb-5 text-lg font-semibold">Choose a new password</h1>
      <ResetPasswordForm token={token} />
    </Card>
  )
}
