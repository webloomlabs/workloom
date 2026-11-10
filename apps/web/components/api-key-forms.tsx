'use client'

import { Button, Field, Input } from '@workloom/ui'
import { useActionState } from 'react'
import { createApiKeyAction, revokeApiKeyAction, type CreatedKey } from '@/lib/actions/settings'
import type { ScopeGroup } from '@/lib/api-key-scopes'
import { idle, type ActionState } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'
import { OneTimeSecret } from './one-time-secret'
import { ScopePicker } from './scope-picker'

/**
 * A key with full access, or one restricted to chosen permissions. Only
 * permissions the viewer holds are offered -- a key can never exceed its
 * owner, so offering more would only mislead.
 */
export function CreateApiKeyForm({ groups }: { groups: ScopeGroup[] }) {
  const [state, action] = useActionState<ActionState<CreatedKey>, FormData>(createApiKeyAction, idle)

  if (state.status === 'success' && state.data) {
    return <SecretReveal created={state.data} />
  }

  return (
    <form action={action} className="space-y-6" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="key-name" label="Name" hint="What will use it, e.g. “n8n automations”." error={fieldError(state, 'name')}>
          <Input id="key-name" name="name" required maxLength={100} />
        </Field>
        <Field id="key-expires" label="Expires (optional)" error={fieldError(state, 'expiresAt')}>
          <Input id="key-expires" name="expiresAt" type="date" />
        </Field>
      </div>

      <ScopePicker groups={groups} subject="key" error={fieldError(state, 'scopes')} />

      <SubmitButton pendingLabel="Creating…">Create key</SubmitButton>
    </form>
  )
}

function SecretReveal({ created }: { created: CreatedKey }) {
  return (
    <OneTimeSecret
      label="API key"
      secret={created.secret}
      warning={
        <>
          Copy the key for <strong>{created.name}</strong> now. It is not stored, so it can&apos;t be
          shown again — if it&apos;s lost, revoke it and create another.
        </>
      }
    >
      <p className="text-xs text-muted">
        Use it as <code className="font-mono">Authorization: Bearer …</code>. The API is described at{' '}
        <a href="/api/v1/openapi.json" className="underline">/api/v1/openapi.json</a>.
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={() => location.reload()}>Done</Button>
    </OneTimeSecret>
  )
}

export function RevokeApiKeyForm({ id, name }: { id: string; name: string }) {
  const [state, action] = useActionState(revokeApiKeyAction, idle)
  return (
    <form action={action}
      onSubmit={(e) => {
        if (!confirm(`Revoke “${name}”? Anything using it stops working immediately.`)) e.preventDefault()
      }}
      className="flex items-center justify-end gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm">Revoke</Button>
      {state.status === 'error' && <span role="alert" className="text-xs text-critical">{state.message}</span>}
    </form>
  )
}
