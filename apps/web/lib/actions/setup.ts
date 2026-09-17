'use server'

import { auth, completeSetup } from '@workloom/auth'
import { env } from '@workloom/config'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

const schema = z.object({
  organizationName: z.string().trim().min(1, 'Name your organization.').max(200),
  name: z.string().trim().min(1, 'Enter your name.').max(100),
  email: z.email('Enter a valid email address.').transform((v) => v.trim().toLowerCase()),
  password: z.string().min(12, 'Use at least 12 characters.').max(256),
})

/**
 * Creates the first administrator and their organization, then signs them in.
 *
 * `completeSetup` is the authorisation: it takes a lock, refuses if any
 * account already exists, and writes the account, the organization and the
 * owning membership together. Signing in afterwards through the ordinary
 * endpoint is what produces the session -- including its active organization,
 * which the session hook fills from the membership that now exists.
 */
export async function setupAction(_: ActionState, form: FormData): Promise<ActionState> {
  const raw = Object.fromEntries(form)
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const error = toActionError(parsed.error)
    // Re-fill everything except the password, which a browser should not be
    // asked to round-trip through a failed submission.
    return error.status === 'error'
      ? {
          ...error,
          values: {
            organizationName: String(raw.organizationName ?? ''),
            name: String(raw.name ?? ''),
            email: String(raw.email ?? ''),
          },
        }
      : error
  }

  if (env.MULTI_TENANT) redirect('/sign-up')

  const { organizationName, ...admin } = parsed.data
  try {
    await completeSetup({ admin, organizationName })
    await auth.api.signInEmail({
      body: { email: admin.email, password: admin.password },
      headers: await headers(),
    })
  } catch (error) {
    return toActionError(error)
  }

  // The app shell has never been rendered for a signed-in viewer on this
  // browser; a redirect alone would reuse the signed-out render.
  revalidatePath('/', 'layout')
  redirect('/')
}
