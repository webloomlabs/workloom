'use client'

import { Badge, Button, cn, Field, Input } from '@workloom/ui'
import { useActionState, useState, type ReactNode } from 'react'
import { createApiKeyAction, revokeApiKeyAction, type CreatedKey } from '@/lib/actions/settings'
import { actionLabel, type ScopeGroup } from '@/lib/api-key-scopes'
import { idle, type ActionState } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'
import { OneTimeSecret } from './one-time-secret'

type Access = 'full' | 'restricted'

const ACCESS: Array<{ value: Access; title: string; body: string }> = [
  { value: 'full', title: 'Full access', body: 'Can do everything you can. Simplest, for tools you trust completely.' },
  { value: 'restricted', title: 'Restricted', body: 'Only the permissions you choose. Best for an automation that needs a few things.' },
]

/**
 * A key with full access, or one restricted to chosen permissions. Only
 * permissions the viewer holds are offered -- a key can never exceed its
 * owner, so offering more would only mislead.
 */
export function CreateApiKeyForm({ groups }: { groups: ScopeGroup[] }) {
  const [state, action] = useActionState<ActionState<CreatedKey>, FormData>(createApiKeyAction, idle)
  const [access, setAccess] = useState<Access>('full')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  if (state.status === 'success' && state.data) {
    return <SecretReveal created={state.data} />
  }

  const all = groups.flatMap((g) => g.resources.flatMap((r) => r.actions.map((a) => `${r.resource}:${a}`)))
  const scopesOf = (group: ScopeGroup, only?: 'read') =>
    group.resources.flatMap((r) => r.actions.filter((a) => !only || a === 'read').map((a) => `${r.resource}:${a}`))
  const change = (scopes: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const s of scopes) if (on) next.add(s); else next.delete(s)
      return next
    })
  const scopesError = fieldError(state, 'scopes')

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

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Access</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {ACCESS.map((option) => (
            <label
              key={option.value}
              className={cn(
                'flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors',
                access === option.value ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong',
              )}
            >
              <input
                type="radio"
                name="access"
                value={option.value}
                checked={access === option.value}
                onChange={() => setAccess(option.value)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--wl-accent)]"
              />
              <span>
                <span className="block text-sm font-medium text-ink">{option.title}</span>
                <span className="mt-0.5 block text-xs text-muted">{option.body}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">
          Either way a key never exceeds your own role, and it loses access the moment your role changes.
        </p>
      </fieldset>

      {access === 'restricted' && (
        <fieldset className="space-y-4" aria-labelledby="key-permissions">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p id="key-permissions" className="text-sm font-medium text-ink">
              Permissions{' '}
              <span className="font-normal text-muted">
                · {selected.size} of {all.length} selected
              </span>
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set(all.filter((s) => s.endsWith(':read'))))}>
                Read-only everywhere
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                Clear
              </Button>
            </div>
          </div>
          {scopesError && <p role="alert" className="text-xs text-critical">{scopesError}</p>}

          {groups.map((group) => {
            const scopes = scopesOf(group)
            const count = scopes.filter((s) => selected.has(s)).length
            return (
              <section key={group.key} className="overflow-hidden rounded-lg border border-line">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-raised px-4 py-2.5">
                  <h3 className="text-sm font-medium text-ink">
                    {group.title}
                    {count > 0 && <Badge tone="accent" className="ml-2">{count}</Badge>}
                  </h3>
                  <div className="flex gap-1 text-xs">
                    <GroupLink onClick={() => change(scopesOf(group, 'read'), true)}>Read</GroupLink>
                    <GroupLink onClick={() => change(scopes, true)}>All</GroupLink>
                    <GroupLink onClick={() => change(scopes, false)} disabled={count === 0}>None</GroupLink>
                  </div>
                </header>
                <ul className="divide-y divide-line">
                  {group.resources.map((r) => (
                    <li key={r.resource} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center">
                      <span className="text-sm text-ink sm:w-48 sm:shrink-0">{r.label}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {r.actions.map((a) => {
                          const scope = `${r.resource}:${a}`
                          const on = selected.has(scope)
                          return (
                            <label
                              key={a}
                              className={cn(
                                'relative cursor-pointer select-none rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                                on ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-muted hover:border-line-strong hover:text-ink',
                              )}
                            >
                              <input type="checkbox" name="scopes" value={scope} checked={on} onChange={(e) => change([scope], e.target.checked)} className="sr-only" />
                              {actionLabel(a)}
                            </label>
                          )
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </fieldset>
      )}

      <SubmitButton pendingLabel="Creating…">Create key</SubmitButton>
    </form>
  )
}

function GroupLink({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded px-1.5 py-0.5 text-muted hover:bg-inset hover:text-ink disabled:pointer-events-none disabled:opacity-40">
      {children}
    </button>
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
