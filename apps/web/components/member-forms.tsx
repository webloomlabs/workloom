'use client'

import { ROLES } from '@workloom/core/permissions'
import { Button, Field, Input, Select } from '@workloom/ui'
import { useActionState, useRef, type ReactNode } from 'react'
import {
  addMemberAction,
  changeMemberRoleAction,
  changeOwnPasswordAction,
  inviteMemberAction,
  removeMemberAction,
  sendPasswordResetAction,
  setMemberPasswordAction,
} from '@/lib/actions/settings'
import { idle } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

export const ROLE_LABELS: Record<(typeof ROLES)[number], string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  developer: 'Developer',
  accountManager: 'Account manager',
  finance: 'Finance',
}

function RoleOptions({ allowOwner }: { allowOwner: boolean }) {
  return (
    <>
      {ROLES.filter((r) => allowOwner || r !== 'owner').map((role) => (
        <option key={role} value={role}>{ROLE_LABELS[role]}</option>
      ))}
    </>
  )
}

export function InviteMemberForm({ canInviteOwner }: { canInviteOwner: boolean }) {
  const [state, action] = useActionState(inviteMemberAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <Field id="invite-email" label="Email" error={fieldError(state, 'email')}>
          <Input id="invite-email" name="email" type="email" required placeholder="name@agency.com" />
        </Field>
        <Field id="invite-role" label="Role" error={fieldError(state, 'role')}>
          <Select id="invite-role" name="role" defaultValue="developer">
            <RoleOptions allowOwner={canInviteOwner} />
          </Select>
        </Field>
        <SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton>
      </div>
    </form>
  )
}

/**
 * Creating an account outright, for a single-tenant installation.
 *
 * There is no sign-up for an invitee to complete, so the administrator sets
 * the first password here and passes it on themselves. Nothing is emailed,
 * which is the point: adding a colleague should not depend on a mail server
 * being configured.
 */
export function AddMemberForm({ canAddOwner }: { canAddOwner: boolean }) {
  const [state, action] = useActionState(addMemberAction, idle)
  const values = state.status === 'error' ? state.values : undefined

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="member-name" label="Name" error={fieldError(state, 'name')}>
          <Input id="member-name" name="name" required placeholder="Dev Eloper" defaultValue={values?.name}
            aria-invalid={!!fieldError(state, 'name')} />
        </Field>
        <Field id="member-email" label="Email" error={fieldError(state, 'email')}>
          <Input id="member-email" name="email" type="email" required placeholder="name@agency.com"
            defaultValue={values?.email} aria-invalid={!!fieldError(state, 'email')} />
        </Field>
        <Field id="member-role" label="Role" error={fieldError(state, 'role')}>
          <Select id="member-role" name="role" defaultValue="developer">
            <RoleOptions allowOwner={canAddOwner} />
          </Select>
        </Field>
        <Field
          id="member-password"
          label="Initial password"
          hint="At least 12 characters. Give it to them directly; it is not emailed."
          error={fieldError(state, 'password')}
        >
          <Input id="member-password" name="password" type="password" autoComplete="new-password" required
            minLength={12} aria-invalid={!!fieldError(state, 'password')} />
        </Field>
      </div>
      <SubmitButton pendingLabel="Adding…">Add member</SubmitButton>
    </form>
  )
}

export function MemberRoleForm({ memberId, role, canInviteOwner }: {
  memberId: string
  role: string
  canInviteOwner: boolean
}) {
  const [state, action] = useActionState(changeMemberRoleAction, idle)
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <label htmlFor={`role-${memberId}`} className="sr-only">Role</label>
      <Select id={`role-${memberId}`} name="role" defaultValue={role} className="h-8 w-40"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        <RoleOptions allowOwner={canInviteOwner || role === 'owner'} />
      </Select>
      {state.status === 'error' && <span role="alert" className="text-xs text-critical">{state.message}</span>}
    </form>
  )
}

export function RemoveMemberForm({ userId, name }: { userId: string; name: string }) {
  const [state, action] = useActionState(removeMemberAction, idle)
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Remove ${name} from this organization? Their API keys stop working immediately.`)) {
          e.preventDefault()
        }
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="userId" value={userId} />
      <Button type="submit" variant="ghost" size="sm">Remove</Button>
      {state.status === 'error' && <span role="alert" className="text-xs text-critical">{state.message}</span>}
    </form>
  )
}

/** A button that opens a small modal. Native <dialog>: Escape and the focus trap come with it. */
function DialogButton({ label, title, description, children }: { label: string; title: string; description?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => ref.current?.showModal()}>{label}</Button>
      <dialog
        ref={ref}
        aria-label={title}
        // A click on the backdrop lands on the dialog itself; one inside lands on its content.
        onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close() }}
        className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border border-line bg-surface p-0 text-left text-ink shadow-xl backdrop:bg-black/60"
      >
        <div className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => ref.current?.close()}>Close</Button>
          </div>
          {children}
        </div>
      </dialog>
    </>
  )
}

/** Your own password, from your own row. */
export function ChangePasswordButton() {
  return (
    <DialogButton label="Change password" title="Change your password" description="Other devices signed in as you are signed out.">
      <ChangePasswordForm />
    </DialogButton>
  )
}

function ChangePasswordForm() {
  const [state, action] = useActionState(changeOwnPasswordAction, idle)
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field id="current-password" label="Current password" error={fieldError(state, 'currentPassword')}>
        <Input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required
          aria-invalid={!!fieldError(state, 'currentPassword')} />
      </Field>
      <Field id="new-password" label="New password" hint="At least 12 characters." error={fieldError(state, 'newPassword')}>
        <Input id="new-password" name="newPassword" type="password" autoComplete="new-password" required minLength={12}
          aria-invalid={!!fieldError(state, 'newPassword')} />
      </Field>
      <Field id="confirm-password" label="New password again" error={fieldError(state, 'confirmPassword')}>
        <Input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required
          aria-invalid={!!fieldError(state, 'confirmPassword')} />
      </Field>
      <SubmitButton pendingLabel="Saving…">Change password</SubmitButton>
    </form>
  )
}

/**
 * Someone else's password: a link emailed to them, and -- where the
 * administrator chose their first password, on a single-organization
 * installation -- setting a new one outright.
 */
export function ResetMemberPasswordButton({ userId, name, email, canSetPassword }: {
  userId: string
  name: string
  email: string
  canSetPassword: boolean
}) {
  return (
    <DialogButton label="Reset password" title={`Reset ${name}’s password`}>
      <SendResetLinkForm userId={userId} email={email} />
      {canSetPassword && (
        <>
          <div className="flex items-center gap-3 text-xs text-faint">
            <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
          </div>
          <SetPasswordForm userId={userId} />
        </>
      )}
    </DialogButton>
  )
}

function SendResetLinkForm({ userId, email }: { userId: string; email: string }) {
  const [state, action] = useActionState(sendPasswordResetAction, idle)
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />
      <p className="text-sm text-muted">Email a link to <span className="text-ink">{email}</span> so they can choose a new password themselves.</p>
      <FormMessage state={state} />
      <SubmitButton variant="secondary" pendingLabel="Sending…">Email a reset link</SubmitButton>
    </form>
  )
}

function SetPasswordForm({ userId }: { userId: string }) {
  const [state, action] = useActionState(setMemberPasswordAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="userId" value={userId} />
      <FormMessage state={state} />
      <Field id={`set-password-${userId}`} label="Set a new password" hint="At least 12 characters. They are signed out everywhere; give it to them directly." error={fieldError(state, 'password')}>
        <Input id={`set-password-${userId}`} name="password" type="password" autoComplete="new-password" required minLength={12}
          aria-invalid={!!fieldError(state, 'password')} />
      </Field>
      <SubmitButton pendingLabel="Saving…">Set password</SubmitButton>
    </form>
  )
}
