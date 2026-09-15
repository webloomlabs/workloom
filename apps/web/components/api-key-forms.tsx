'use client'

import { Alert, Button, Field, Input } from '@workloom/ui'
import { useActionState, useState } from 'react'
import { createApiKeyAction, revokeApiKeyAction, type CreatedKey } from '@/lib/actions/settings'
import { idle, type ActionState } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

/**
 * Scopes grouped by resource. Only permissions the viewer holds are offered --
 * a key can never exceed its owner, so offering more would only mislead.
 */
export function CreateApiKeyForm({ grantable }: { grantable: Record<string, string[]> }) {
  const [state, action] = useActionState<ActionState<CreatedKey>, FormData>(createApiKeyAction, idle)

  if (state.status === 'success' && state.data) {
    return <SecretReveal created={state.data} />
  }

  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="key-name" label="Name" hint="What will use it, e.g. “n8n automations”." error={fieldError(state, 'name')}>
          <Input id="key-name" name="name" required maxLength={100} />
        </Field>
        <Field id="key-expires" label="Expires (optional)" error={fieldError(state, 'expiresAt')}>
          <Input id="key-expires" name="expiresAt" type="date" />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Scopes</legend>
        <p className="text-xs text-neutral-500">
          Leave everything unticked for a key that can do whatever you can. Either way it never exceeds
          your own role, and it loses access the moment your role changes.
        </p>
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(grantable).map(([resource, actions]) => (
            <div key={resource}>
              <p className="mb-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">{resource}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {actions.map((a) => (
                  <label key={a} className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
                    <input type="checkbox" name="scopes" value={`${resource}:${a}`} className="size-3.5" />
                    {a}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        {fieldError(state, 'scopes') && <p role="alert" className="text-xs text-red-600">{fieldError(state, 'scopes')}</p>}
      </fieldset>

      <SubmitButton pendingLabel="Creating…">Create key</SubmitButton>
    </form>
  )
}

function SecretReveal({ created }: { created: CreatedKey }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-3">
      <Alert tone="warning">
        Copy the key for <strong>{created.name}</strong> now. It is not stored, so it can&apos;t be
        shown again — if it&apos;s lost, revoke it and create another.
      </Alert>
      <div className="flex gap-2">
        <label htmlFor="secret" className="sr-only">API key</label>
        <Input id="secret" readOnly value={created.secret} className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(created.secret)
            setCopied(true)
          }}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-xs text-neutral-500">
        Use it as <code className="font-mono">Authorization: Bearer …</code>. The API is described at{' '}
        <a href="/api/v1/openapi.json" className="underline">/api/v1/openapi.json</a>.
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={() => location.reload()}>Done</Button>
    </div>
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
      {state.status === 'error' && <span role="alert" className="text-xs text-red-600">{state.message}</span>}
    </form>
  )
}
