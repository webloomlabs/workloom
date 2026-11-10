'use server'

import { oauth } from '@workloom/auth'
import { headers } from 'next/headers'
import { OAUTH_PARAMS } from '../oauth/params.ts'
import { getSession } from '../server/viewer.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

export type ConsentResult = { redirectTo: string }

/**
 * Allow or deny, from the consent screen.
 *
 * Re-validates the whole request: the hidden fields are as untrusted as the
 * URL they came from. The person is whoever is signed in now, never anything
 * the form says. The redirect itself happens in the browser, because a
 * server redirect from a form post to another origin can be blocked by this
 * app's own `form-action` policy.
 */
export async function decideOAuthAction(_: ActionState<ConsentResult>, form: FormData): Promise<ActionState<ConsentResult>> {
  const session = await getSession()
  if (!session) return { status: 'error', message: 'Your session has ended. Sign in and start the connection again.' }

  const params = Object.fromEntries(
    OAUTH_PARAMS.map((name) => [name, form.get(`oauth_${name}`)?.toString() || undefined]),
  )
  const validation = await oauth.validateAuthorizeRequest(params)
  if (!validation.ok) {
    return validation.kind === 'redirect'
      ? { status: 'success', data: { redirectTo: validation.redirectTo } }
      : { status: 'error', message: validation.message }
  }

  if (form.get('decision') !== 'allow') {
    return { status: 'success', data: { redirectTo: oauth.denyAuthorization(validation.request) } }
  }

  const restricted = form.get('access') === 'restricted'
  const scopes = form.getAll('scopes').map(String).filter(Boolean)
  if (restricted && scopes.length === 0) {
    return { status: 'error', message: 'Choose at least one permission, or give the app full access.', fieldErrors: { scopes: 'Choose at least one permission.' } }
  }

  try {
    const requestHeaders = await headers()
    const redirectTo = await oauth.approveAuthorization({
      request: validation.request,
      user: session.user,
      organizationId: String(form.get('organizationId') ?? ''),
      scopes: restricted ? scopes : null,
      context: {
        ipAddress: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
        userAgent: requestHeaders.get('user-agent') ?? undefined,
      },
    })
    return { status: 'success', data: { redirectTo } }
  } catch (error) {
    return toActionError(error)
  }
}
