'use server'

import { confirmOrganizationReset, requestOrganizationReset } from '@workloom/auth'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'
import { requireViewer } from '../server/viewer.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * The two steps of resetting an organization. Who may, and the checks
 * themselves, live in packages/auth/src/organization-reset.ts -- these only
 * carry the form there and back. Both read the person from the session, never
 * from the form.
 */

export type ResetCodeSent = { email: string; expiresAt: string }

export async function requestOrganizationResetAction(_: ActionState<ResetCodeSent>, form: FormData): Promise<ActionState<ResetCodeSent>> {
  const parsed = z.object({ password: z.string().min(1, 'Enter your password.') }).safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  const viewer = await requireViewer()
  if (viewer.actor.type !== 'user') return { status: 'error', message: 'Only a signed-in person can reset an organization.' }
  try {
    const sent = await requestOrganizationReset({
      organizationId: viewer.organizationId,
      userId: viewer.actor.id,
      password: parsed.data.password,
      actor: viewer.actor,
      context: { headers: await headers() },
    })
    return { status: 'success', data: { email: sent.email, expiresAt: sent.expiresAt.toISOString() } }
  } catch (error) {
    return toActionError(error)
  }
}

export async function confirmOrganizationResetAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit code from the email.') })
    .safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  const viewer = await requireViewer()
  if (viewer.actor.type !== 'user') return { status: 'error', message: 'Only a signed-in person can reset an organization.' }
  let records: number
  let files: number
  try {
    const result = await confirmOrganizationReset({
      organizationId: viewer.organizationId,
      userId: viewer.actor.id,
      code: parsed.data.code,
      actor: viewer.actor,
      context: { headers: await headers() },
    })
    records = Object.values(result.deleted).reduce((a, b) => a + b, 0)
    files = result.files
  } catch (error) {
    return toActionError(error)
  }
  // Every page showed something that is now gone.
  revalidatePath('/', 'layout')
  return {
    status: 'success',
    message: `The organization has been reset: ${records.toLocaleString()} ${records === 1 ? 'record' : 'records'} and ${files.toLocaleString()} ${files === 1 ? 'file' : 'files'} deleted.`,
  }
}
