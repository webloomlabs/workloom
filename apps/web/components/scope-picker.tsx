'use client'

import { Badge, Button, cn } from '@workloom/ui'
import { useState, type ReactNode } from 'react'
import { actionLabel, type ScopeGroup } from '@/lib/api-key-scopes'

type Access = 'full' | 'restricted'

const ACCESS: Record<'key' | 'app', Array<{ value: Access; title: string; body: string }>> = {
  key: [
    { value: 'full', title: 'Full access', body: 'Can do everything you can. Simplest, for tools you trust completely.' },
    { value: 'restricted', title: 'Restricted', body: 'Only the permissions you choose. Best for an automation that needs a few things.' },
  ],
  app: [
    { value: 'full', title: 'Full access', body: 'Can do everything you can, as you.' },
    { value: 'restricted', title: 'Restricted', body: 'Only the permissions you choose, for example read-only.' },
  ],
}

/**
 * Full access, or a chosen set of permissions -- for an API key or for an
 * app being connected through OAuth. Submits `access` (`full` or
 * `restricted`) and one `scopes` field per chosen permission. Only
 * permissions the person holds are offered: a credential can never exceed
 * its owner, so offering more would only mislead.
 */
export function ScopePicker({
  groups,
  subject,
  error,
}: {
  groups: ScopeGroup[]
  subject: 'key' | 'app'
  error?: string | undefined
}) {
  const [access, setAccess] = useState<Access>('full')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const all = groups.flatMap((g) => g.resources.flatMap((r) => r.actions.map((a) => `${r.resource}:${a}`)))
  const scopesOf = (group: ScopeGroup, only?: 'read') =>
    group.resources.flatMap((r) => r.actions.filter((a) => !only || a === 'read').map((a) => `${r.resource}:${a}`))
  const change = (scopes: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const s of scopes) if (on) next.add(s); else next.delete(s)
      return next
    })

  return (
    <>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Access</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {ACCESS[subject].map((option) => (
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
          Either way {subject === 'key' ? 'a key' : 'the app'} never exceeds your own role, and it loses access the moment your role changes.
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
          {error && <p role="alert" className="text-xs text-critical">{error}</p>}

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
    </>
  )
}

function GroupLink({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded px-1.5 py-0.5 text-muted hover:bg-inset hover:text-ink disabled:pointer-events-none disabled:opacity-40">
      {children}
    </button>
  )
}
