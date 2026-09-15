'use client'

import { ROLES } from '@workloom/core/permissions'
import { Button, Field, Input, Select } from '@workloom/ui'
import { useActionState } from 'react'
import { changeMemberRoleAction, inviteMemberAction, removeMemberAction } from '@/lib/actions/settings'
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
      {state.status === 'error' && <span role="alert" className="text-xs text-red-600">{state.message}</span>}
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
      {state.status === 'error' && <span role="alert" className="text-xs text-red-600">{state.message}</span>}
    </form>
  )
}
