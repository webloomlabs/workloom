'use server'

import { auth } from '@workloom/auth'
import { ROLES } from '@workloom/core'
import { apiKeyCreate, apiKeyRevoke, memberRemove, organizationUpdate } from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { requireViewer } from '../server/viewer.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/** Empty form fields arrive as "", which should mean "not provided". */
const optional = (value: FormDataEntryValue | null) =>
  value === null || value === '' ? undefined : value

export async function updateOrganizationAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(organizationUpdate, {
      name: optional(form.get('name')) as string | undefined,
      baseCurrency: (optional(form.get('baseCurrency')) as string | undefined)?.toUpperCase(),
      timezone: optional(form.get('timezone')) as string | undefined,
      dateFormat: optional(form.get('dateFormat')) as string | undefined,
    })
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath('/settings', 'layout')
  return { status: 'success', message: 'Settings saved.' }
}

export async function inviteMemberAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({
      email: z.email('Enter a valid email address.').transform((v) => v.trim().toLowerCase()),
      role: z.enum(ROLES, 'Choose a role.'),
    })
    .safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  const viewer = await requireViewer()
  try {
    await auth.api.createInvitation({
      body: { ...parsed.data, organizationId: viewer.organizationId },
      headers: await headers(),
    })
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath('/settings/members')
  return { status: 'success', message: `Invitation sent to ${parsed.data.email}.` }
}

export async function cancelInvitationAction(form: FormData): Promise<void> {
  const invitationId = z.uuid().parse(form.get('invitationId'))
  await auth.api.cancelInvitation({ body: { invitationId }, headers: await headers() })
  revalidatePath('/settings/members')
}

export async function changeMemberRoleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({ memberId: z.uuid(), role: z.enum(ROLES) })
    .safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  const viewer = await requireViewer()
  try {
    await auth.api.updateMemberRole({
      body: { ...parsed.data, organizationId: viewer.organizationId },
      headers: await headers(),
    })
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath('/settings/members')
  return { status: 'success', message: 'Role updated.' }
}

export async function removeMemberAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const userId = z.uuid().parse(form.get('userId'))
    await call(memberRemove, { userId })
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath('/settings/members')
  return { status: 'success', message: 'Member removed.' }
}

export type CreatedKey = { name: string; secret: string }

export async function createApiKeyAction(
  _: ActionState<CreatedKey>,
  form: FormData,
): Promise<ActionState<CreatedKey>> {
  const scopes = form.getAll('scopes').map(String).filter(Boolean)
  const expiresAt = optional(form.get('expiresAt'))

  try {
    const created = await call(apiKeyCreate, {
      name: String(form.get('name') ?? ''),
      // No boxes ticked means "everything I may do", not "nothing".
      scopes: scopes.length > 0 ? scopes : null,
      expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59Z`) : null,
    })
    revalidatePath('/settings/api-keys')
    // The secret travels to the browser exactly once, in this response. It is
    // not stored anywhere that could return it again.
    return { status: 'success', data: { name: created.key.name, secret: created.secret } }
  } catch (error) {
    return toActionError(error)
  }
}

export async function revokeApiKeyAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(apiKeyRevoke, { id: z.uuid().parse(form.get('id')) })
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath('/settings/api-keys')
  return { status: 'success', message: 'Key revoked.' }
}
