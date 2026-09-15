'use client'

import { useActionState } from 'react'
import { acceptInvitationAction, resendVerificationAction } from '@/lib/actions/auth'
import { idle } from '@/lib/actions/state'
import { FormMessage, SubmitButton } from './form-bits'

export function AcceptInvitationForm({ invitationId }: { invitationId: string }) {
  const [state, action] = useActionState(acceptInvitationAction, idle)
  return (
    <form action={action} className="space-y-3">
      <FormMessage state={state} />
      <input type="hidden" name="invitationId" value={invitationId} />
      <SubmitButton className="w-full" pendingLabel="Joining…">Accept invitation</SubmitButton>
    </form>
  )
}

export function ResendVerificationForm({ next }: { next: string }) {
  const [state, action] = useActionState(resendVerificationAction, idle)
  return (
    <form action={action} className="space-y-3">
      <FormMessage state={state} />
      <input type="hidden" name="next" value={next} />
      <SubmitButton variant="secondary" className="w-full" pendingLabel="Sending…">
        Resend confirmation email
      </SubmitButton>
    </form>
  )
}
