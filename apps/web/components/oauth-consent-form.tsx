'use client'

import { Button, Field, Select } from '@workloom/ui'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useTransition } from 'react'
import { decideOAuthAction, type ConsentResult } from '@/lib/actions/oauth'
import type { ScopeGroup } from '@/lib/api-key-scopes'
import { idle, type ActionState } from '@/lib/actions/state'
import { fieldError, FormMessage } from './form-bits'
import { ScopePicker } from './scope-picker'

/**
 * The choice on the consent screen: which organization, how much access,
 * and Allow or Deny. Everything it submits is checked again on the server.
 */
export function OAuthConsentForm({
  params,
  organizations,
  organizationId,
  groups,
}: {
  /** The OAuth request, carried through as hidden fields. */
  params: Record<string, string>
  organizations: Array<{ id: string; name: string }>
  organizationId: string
  groups: ScopeGroup[]
}) {
  const [state, action, pending] = useActionState<ActionState<ConsentResult>, FormData>(decideOAuthAction, idle)
  const [switching, startSwitch] = useTransition()
  const router = useRouter()

  const redirectTo = state.status === 'success' ? state.data?.redirectTo : undefined
  useEffect(() => {
    // Leaving for another origin: a full navigation, not a client-side route.
    if (redirectTo) window.location.assign(redirectTo)
  }, [redirectTo])

  if (redirectTo) return <p className="text-sm text-muted">Returning you to the app…</p>

  return (
    <form action={action} className="space-y-6" noValidate>
      <FormMessage state={state} />
      {Object.entries(params).map(([name, value]) => (
        <input key={name} type="hidden" name={`oauth_${name}`} value={value} />
      ))}

      {organizations.length > 1 ? (
        <Field id="oauth-organization" label="Organization">
          <Select
            id="oauth-organization"
            name="organizationId"
            defaultValue={organizationId}
            disabled={switching}
            onChange={(event) => {
              // The permissions on offer depend on your role there, so reload with it.
              const next = new URLSearchParams({ ...params, organization_id: event.target.value })
              startSwitch(() => router.replace(`/oauth/authorize?${next}`))
            }}
          >
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
          </Select>
        </Field>
      ) : (
        <input type="hidden" name="organizationId" value={organizationId} />
      )}

      <ScopePicker key={organizationId} groups={groups} subject="app" error={fieldError(state, 'scopes')} />

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="submit" name="decision" value="deny" variant="secondary" disabled={pending}>
          Deny
        </Button>
        <Button type="submit" name="decision" value="allow" disabled={pending || switching}>
          {pending ? 'Connecting…' : 'Allow'}
        </Button>
      </div>
    </form>
  )
}
