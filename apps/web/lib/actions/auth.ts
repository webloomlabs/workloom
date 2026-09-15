'use server'

import { auth } from '@workloom/auth'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { getSession, safeRedirectPath } from '../server/viewer.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

const email = z.email('Enter a valid email address.').transform((v) => v.trim().toLowerCase())
const password = z.string().min(12, 'Use at least 12 characters.').max(256)

export async function signUpAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({
      name: z.string().trim().min(1, 'Enter your name.').max(100),
      email,
      password,
      next: z.string().optional(),
    })
    .safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  const destination = safeRedirectPath(parsed.data.next, '/onboarding')
  try {
    await auth.api.signUpEmail({
      body: {
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
        // Where the verification link returns to. Passed through the same
        // guard as every other redirect target.
        callbackURL: destination,
      },
      headers: await headers(),
    })
  } catch (error) {
    return toActionError(error)
  }
  redirect(destination)
}

export async function signInAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({ email, password: z.string().min(1, 'Enter your password.'), next: z.string().optional() })
    .safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  try {
    await auth.api.signInEmail({
      body: { email: parsed.data.email, password: parsed.data.password },
      headers: await headers(),
    })
  } catch (error) {
    // Better Auth deliberately answers "invalid email or password" for both
    // an unknown account and a wrong password, so this cannot be used to
    // discover who has an account.
    return toActionError(error)
  }
  redirect(safeRedirectPath(parsed.data.next))
}

export async function signOutAction(): Promise<void> {
  await auth.api.signOut({ headers: await headers() })
  redirect('/sign-in')
}

export async function requestPasswordResetAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = z.object({ email }).safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  try {
    await auth.api.requestPasswordReset({
      body: { email: parsed.data.email, redirectTo: '/reset-password' },
      headers: await headers(),
    })
  } catch (error) {
    console.error('[password-reset] request failed', error)
  }
  // The same answer whether or not the address has an account, and whether or
  // not sending succeeded -- otherwise this form enumerates registered emails.
  return {
    status: 'success',
    message: 'If an account exists for that address, a reset link is on its way.',
  }
}

export async function resetPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({ token: z.string().min(1, 'This reset link is incomplete.'), password })
    .safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  try {
    await auth.api.resetPassword({
      body: { token: parsed.data.token, newPassword: parsed.data.password },
      headers: await headers(),
    })
  } catch (error) {
    return toActionError(error)
  }
  redirect('/sign-in?reset=1')
}

export async function resendVerificationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession()
  if (!session) redirect('/sign-in')

  try {
    await auth.api.sendVerificationEmail({
      body: {
        email: session.user.email,
        callbackURL: safeRedirectPath(form.get('next'), '/'),
      },
      headers: await headers(),
    })
  } catch (error) {
    return toActionError(error)
  }
  return { status: 'success', message: `We sent a new link to ${session.user.email}.` }
}

/** A URL-safe slug from an organization name, with a short suffix for uniqueness. */
function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const suffix = crypto.randomUUID().slice(0, 6)
  return `${base || 'organization'}-${suffix}`
}

export async function createOrganizationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({ name: z.string().trim().min(1, 'Name your organization.').max(200) })
    .safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  try {
    await auth.api.createOrganization({
      body: { name: parsed.data.name, slug: slugify(parsed.data.name) },
      headers: await headers(),
    })
  } catch (error) {
    return toActionError(error)
  }
  // The app layout (organization switcher, navigation) was rendered for the
  // previous organization, or for none; a redirect alone would keep it.
  revalidatePath('/', 'layout')
  redirect('/settings/organization')
}

export async function switchOrganizationAction(form: FormData): Promise<void> {
  const organizationId = z.uuid().parse(form.get('organizationId'))
  // Better Auth checks membership before switching; a forged id is refused.
  await auth.api.setActiveOrganization({ body: { organizationId }, headers: await headers() })
  // The app layout (organization switcher, navigation) was rendered for the
  // previous organization, or for none; a redirect alone would keep it.
  revalidatePath('/', 'layout')
  redirect('/settings/organization')
}

export async function acceptInvitationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const invitationId = z.uuid().safeParse(form.get('invitationId'))
  if (!invitationId.success) return { status: 'error', message: 'This invitation link is invalid.' }

  const requestHeaders = await headers()
  try {
    const result = await auth.api.acceptInvitation({
      body: { invitationId: invitationId.data },
      headers: requestHeaders,
    })
    const organizationId = result?.member.organizationId
    if (organizationId) {
      await auth.api.setActiveOrganization({ body: { organizationId }, headers: requestHeaders })
    }
  } catch (error) {
    return toActionError(error)
  }
  // The app layout (organization switcher, navigation) was rendered for the
  // previous organization, or for none; a redirect alone would keep it.
  revalidatePath('/', 'layout')
  redirect('/settings/organization')
}
