import { Card } from '@workloom/ui'
import type { Metadata } from 'next'
import { ForgotPasswordForm } from '@/components/auth-forms'

export const metadata: Metadata = { title: 'Reset password · Workloom' }

export default function ForgotPasswordPage() {
  return (
    <Card className="p-6">
      <h1 className="mb-2 text-lg font-semibold">Reset your password</h1>
      <p className="mb-5 text-sm text-neutral-600">We&apos;ll email you a link to choose a new one.</p>
      <ForgotPasswordForm />
    </Card>
  )
}
