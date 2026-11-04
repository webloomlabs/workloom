'use server'

import { auth, authErrorCode, provisionMember, recordAuthEvent, setMemberPassword } from '@workloom/auth'
import { env } from '@workloom/config'
import { DomainError, ForbiddenError, NotFoundError, ROLES } from '@workloom/core'
import { apiKeyCreate, apiKeyRevoke, documentSequenceUpdate, memberList, memberRemove, organizationRemoveLogo, organizationUpdate, organizationUploadLogo } from '@workloom/core/modules'
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
      dateFormat: optional(form.get('dateFormat')) as z.input<typeof organizationUpdate.input>['dateFormat'],
      legalName: form.has('legalName') ? String(form.get('legalName') ?? '').trim() : undefined,
      billingAddress: form.has('billingAddress') ? String(form.get('billingAddress') ?? '').trim() : undefined,
      taxNumber: form.has('taxNumber') ? String(form.get('taxNumber') ?? '').trim() : undefined,
      paymentInstructions: form.has('paymentInstructions') ? String(form.get('paymentInstructions') ?? '').trim() : undefined,
      paymentTermsDays: optional(form.get('paymentTermsDays')) ? Number(form.get('paymentTermsDays')) : undefined,
      fiscalYearStartMonth: optional(form.get('fiscalYearStartMonth')) ? Number(form.get('fiscalYearStartMonth')) : undefined,
      // A checkbox posts nothing when unticked; the hidden "false" before it is the fallback.
      reclaimsInputTax: form.has('reclaimsInputTax') ? form.getAll('reclaimsInputTax').includes('true') : undefined,
      brandColor: form.has('brandColor') ? (String(form.get('brandColor') ?? '').trim() || null) : undefined,
      paymentDetails: form.has('paymentDetail.0.label') || form.has('paymentInstructions') ? paymentDetailsFrom(form) : undefined,
      invoiceNotesDefault: text(form, 'invoiceNotesDefault'),
      invoiceTermsDefault: text(form, 'invoiceTermsDefault'),
      quoteTermsDefault: text(form, 'quoteTermsDefault'),
      documentFooter: text(form, 'documentFooter'),
    })
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath('/settings', 'layout')
  return { status: 'success', message: 'Settings saved.' }
}

/** A text field that was on the form: trimmed, empty meaning cleared. */
const text = (form: FormData, name: string) => (form.has(name) ? String(form.get(name) ?? '').trim() : undefined)

/** The payment details rows, in order, without the ones left empty. */
function paymentDetailsFrom(form: FormData): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  for (let i = 0; i < 16; i++) {
    if (!form.has(`paymentDetail.${i}.label`)) continue
    const label = String(form.get(`paymentDetail.${i}.label`) ?? '').trim()
    const value = String(form.get(`paymentDetail.${i}.value`) ?? '').trim()
    if (label || value) rows.push({ label, value })
  }
  return rows
}

export async function uploadLogoAction(_: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) return { status: 'error', message: 'Choose a PNG or JPEG file to upload.' }
  try {
    await call(organizationUploadLogo, { file })
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath('/settings/organization')
  return { status: 'success', message: 'Logo uploaded. It prints on every quote and invoice.' }
}

export async function removeLogoAction(_: ActionState, _form: FormData): Promise<ActionState> {
  try {
    await call(organizationRemoveLogo, {})
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath('/settings/organization')
  return { status: 'success', message: 'Logo removed.' }
}

export async function updateDocumentSequenceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const kind = String(form.get('kind') ?? '') as 'invoice' | 'quote' | 'ticket' | 'expense'
  const next = optional(form.get('nextValue'))
  try {
    const result = await call(documentSequenceUpdate, {
      kind,
      format: optional(form.get('format')) as string | undefined,
      reset: optional(form.get('reset')) as 'never' | 'yearly' | 'fiscal_yearly' | undefined,
      nextValue: next === undefined ? undefined : Number(next),
    })
    revalidatePath('/settings/numbering')
    return { status: 'success', message: `The next ${kind} will be ${result.nextNumber}.` }
  } catch (error) {
    return toActionError(error)
  }
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

/**
 * Creates an account and makes it a member, in one step.
 *
 * What replaces the invitation flow on a single-tenant installation, where
 * there is no sign-up for an invitee to complete. The administrator chooses
 * the first password and passes it on however they already talk to the person;
 * the person changes it from "Forgot password?", or has it reset for them.
 *
 * Restricted to single-tenant installations on purpose. Where several
 * organizations share an installation, one organization's administrator
 * minting accounts that exist instance-wide is a bigger grant than
 * `member:invite` is meant to be -- there, an invitation that the recipient
 * has to accept is the right shape.
 */
export async function addMemberAction(_: ActionState, form: FormData): Promise<ActionState> {
  const raw = Object.fromEntries(form)
  const parsed = z
    .object({
      name: z.string().trim().min(1, 'Enter their name.').max(100),
      email: z.email('Enter a valid email address.').transform((v) => v.trim().toLowerCase()),
      role: z.enum(ROLES, 'Choose a role.'),
      password: z.string().min(12, 'Use at least 12 characters.').max(256),
    })
    .safeParse(raw)
  if (!parsed.success) {
    const error = toActionError(parsed.error)
    return error.status === 'error'
      ? { ...error, values: { name: String(raw.name ?? ''), email: String(raw.email ?? '') } }
      : error
  }

  if (env.MULTI_TENANT) {
    return { status: 'error', message: 'Invite people by email on a multi-organization installation.' }
  }

  const viewer = await requireViewer()
  try {
    if (!viewer.permissions.has('member:invite')) throw new ForbiddenError('member:invite')
    // The same rule the invitation form follows: only an owner may make
    // another owner, or an admin could promote themselves past the one
    // permission that sets owners apart.
    if (parsed.data.role === 'owner' && viewer.role !== 'owner') {
      throw new ForbiddenError('member:invite')
    }

    await provisionMember({
      organizationId: viewer.organizationId,
      role: parsed.data.role,
      person: { name: parsed.data.name, email: parsed.data.email, password: parsed.data.password },
      createdBy: viewer.actor,
      context: { headers: await headers() },
    })
  } catch (error) {
    return toActionError(error)
  }

  revalidatePath('/settings/members')
  return {
    status: 'success',
    message: `${parsed.data.name} can now sign in as ${parsed.data.email}. Pass the password on yourself — it is not emailed.`,
  }
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

const newPassword = z.string().min(12, 'Use at least 12 characters.').max(256, 'Use at most 256 characters.')

/** Your own password: the current one, then the new one twice. Every other session ends. */
export async function changeOwnPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({ currentPassword: z.string().min(1, 'Enter your current password.'), newPassword, confirmPassword: z.string() })
    .refine((v) => v.newPassword === v.confirmPassword, { message: 'The passwords do not match.', path: ['confirmPassword'] })
    .safeParse(Object.fromEntries(form))
  if (!parsed.success) return toActionError(parsed.error)

  const viewer = await requireViewer()
  if (viewer.actor.type !== 'user') return { status: 'error', message: 'Only a signed-in person can change their password.' }
  const requestHeaders = await headers()
  try {
    await auth.api.changePassword({
      body: { currentPassword: parsed.data.currentPassword, newPassword: parsed.data.newPassword, revokeOtherSessions: true },
      headers: requestHeaders,
    })
  } catch (error) {
    if (authErrorCode(error) === 'INVALID_PASSWORD') {
      return { status: 'error', message: 'That is not your current password.', fieldErrors: { currentPassword: 'That is not your current password.' } }
    }
    return toActionError(error)
  }
  await recordAuthEvent({
    organizationId: viewer.organizationId,
    actor: viewer.actor,
    entry: { action: 'user.password_changed', entityType: 'user', entityId: viewer.actor.id, entityLabel: viewer.actor.label },
    context: { headers: requestHeaders },
  })
  return { status: 'success', message: 'Password changed. Any other devices signed in as you have been signed out.' }
}

/**
 * The member someone with `member:update` is acting on: never themselves --
 * their own password goes through the current one -- and only in this
 * organization.
 */
async function managedMember(form: FormData) {
  const viewer = await requireViewer()
  if (!viewer.permissions.has('member:update')) throw new ForbiddenError('member:update')
  const userId = z.uuid().parse(form.get('userId'))
  if (viewer.actor.type === 'user' && viewer.actor.id === userId) {
    throw new DomainError('Change your own password with your current one.', 'own_password')
  }
  const target = (await call(memberList, {})).data.find((m) => m.userId === userId)
  if (!target) throw new NotFoundError('Member', userId)
  return { viewer, target }
}

/** Emails a member a link to choose a new password. Works on any installation: only they ever see the new password. */
export async function sendPasswordResetAction(_: ActionState, form: FormData): Promise<ActionState> {
  let email: string
  try {
    const { viewer, target } = await managedMember(form)
    email = target.email
    const requestHeaders = await headers()
    try {
      await auth.api.requestPasswordReset({ body: { email, redirectTo: '/reset-password' }, headers: requestHeaders })
    } catch (error) {
      console.error('[password-reset] sending for a member failed', error)
      return { status: 'error', message: `The email to ${email} could not be sent. Check the mail settings (MAIL_DRIVER) and try again.` }
    }
    await recordAuthEvent({
      organizationId: viewer.organizationId,
      actor: viewer.actor,
      entry: { action: 'member.password_reset_sent', entityType: 'member', entityId: target.id, entityLabel: email },
      context: { headers: requestHeaders },
    })
  } catch (error) {
    return toActionError(error)
  }
  return { status: 'success', message: `Reset link sent to ${email}. It works once, for an hour.` }
}

/**
 * Sets a member's password outright, on a single-tenant installation, where
 * the administrator already chose their first one. Their sessions end.
 *
 * Not on a multi-tenant one: there an account spans every organization the
 * person belongs to, and this organization's administrator setting its
 * password would be taking it over everywhere. The emailed link is the way
 * there.
 */
export async function setMemberPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  if (env.MULTI_TENANT) {
    return { status: 'error', message: 'On a multi-organization installation, send a reset link instead.' }
  }
  const parsed = z.object({ password: newPassword }).safeParse({ password: form.get('password') })
  if (!parsed.success) return toActionError(parsed.error)
  let name: string
  try {
    const { viewer, target } = await managedMember(form)
    // The rule for making owners: an admin who could set an owner's password
    // could sign in as them.
    if (target.role === 'owner' && viewer.role !== 'owner') throw new ForbiddenError('member:update')
    name = target.name
    await setMemberPassword({
      organizationId: viewer.organizationId,
      userId: target.userId,
      password: parsed.data.password,
      setBy: viewer.actor,
      context: { headers: await headers() },
    })
  } catch (error) {
    return toActionError(error)
  }
  return { status: 'success', message: `Password set for ${name}, and they have been signed out everywhere. Pass it on yourself — it is not emailed.` }
}

export type CreatedKey = { name: string; secret: string }

export async function createApiKeyAction(
  _: ActionState<CreatedKey>,
  form: FormData,
): Promise<ActionState<CreatedKey>> {
  const restricted = form.get('access') === 'restricted'
  const scopes = form.getAll('scopes').map(String).filter(Boolean)
  const expiresAt = optional(form.get('expiresAt'))
  if (restricted && scopes.length === 0) {
    return { status: 'error', message: 'Choose at least one permission, or give the key full access.', fieldErrors: { scopes: 'Choose at least one permission.' } }
  }

  try {
    const created = await call(apiKeyCreate, {
      name: String(form.get('name') ?? ''),
      // Full access is no scopes at all: the key does whatever its owner may.
      scopes: restricted ? scopes : null,
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
