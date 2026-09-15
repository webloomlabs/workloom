import { auth, authErrorCode } from '@workloom/auth'
import { Alert, Card } from '@workloom/ui'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { AcceptInvitationForm, ResendVerificationForm } from '@/components/invitation-forms'
import { signOutAction } from '@/lib/actions/auth'
import { getSession } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Invitation · Workloom' }

export default async function AcceptInvitationPage({ params }: PageProps<'/accept-invitation/[id]'>) {
  const { id } = await params
  const here = `/accept-invitation/${id}`
  const session = await getSession()

  // Signed out. The invitation's details are only revealed to the account it
  // was sent to, so nothing about it is shown yet.
  if (!session) {
    const next = encodeURIComponent(here)
    return (
      <Card className="space-y-4 p-6">
        <h1 className="text-lg font-semibold">You&apos;ve been invited to Workloom</h1>
        <p className="text-sm text-neutral-600">
          Sign in, or create an account using the address the invitation was sent to.
        </p>
        <div className="flex gap-2">
          <Link href={`/sign-up?next=${next}`}
            className="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-neutral-900 text-sm font-medium text-white">
            Create account
          </Link>
          <Link href={`/sign-in?next=${next}`}
            className="inline-flex h-9 flex-1 items-center justify-center rounded-md border border-neutral-300 text-sm font-medium">
            Sign in
          </Link>
        </div>
      </Card>
    )
  }

  let invitation: Awaited<ReturnType<typeof auth.api.getInvitation>> | null = null
  let refusal: string | null = null
  try {
    invitation = await auth.api.getInvitation({ query: { id }, headers: await headers() })
  } catch (error) {
    refusal = authErrorCode(error)
  }

  /**
   * Better Auth checks, in order: the invitation is live, this account is its
   * recipient, and this account's email is verified. So this particular refusal
   * means "right person, valid invitation, unconfirmed address" -- the one case
   * worth a confirm-your-email prompt. Checking verification before fetching
   * would show that prompt even to someone signed in as the wrong account.
   */
  if (refusal === 'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION') {
    return (
      <Card className="space-y-4 p-6">
        <h1 className="text-lg font-semibold">Confirm your email to accept this invitation</h1>
        <p className="text-sm text-neutral-600">
          We sent a confirmation link to <strong>{session.user.email}</strong>. Open it, and you&apos;ll
          come straight back here.
        </p>
        <ResendVerificationForm next={here} />
      </Card>
    )
  }

  // Expired, already used, cancelled -- or sent to a different address than the
  // one signed in. Deliberately not distinguished to the visitor.
  if (!invitation) {
    return (
      <Card className="space-y-4 p-6">
        <h1 className="text-lg font-semibold">This invitation can&apos;t be used</h1>
        <Alert tone="warning">
          It may have expired or been cancelled, or it was sent to an address other than{' '}
          <strong>{session.user.email}</strong>.
        </Alert>
        <form action={signOutAction}>
          <button type="submit" className="text-sm font-medium hover:underline">
            Sign in with a different account
          </button>
        </form>
      </Card>
    )
  }

  return (
    <Card className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">Join {invitation.organizationName}</h1>
      <p className="text-sm text-neutral-600">
        {invitation.inviterEmail} invited you to join as <strong>{invitation.role}</strong>.
      </p>
      <AcceptInvitationForm invitationId={invitation.id} />
    </Card>
  )
}
