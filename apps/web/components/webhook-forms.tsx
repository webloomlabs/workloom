'use client'

import { Button, Field, Input } from '@workloom/ui'
import Link from 'next/link'
import { useActionState, useState } from 'react'
import { idle, type ActionState } from '@/lib/actions/state'
import {
  createWebhookAction,
  rotateWebhookSecretAction,
  sendTestWebhookAction,
  updateWebhookAction,
  type RevealedSecret,
} from '@/lib/actions/webhooks'
import { fieldError, FormMessage, SubmitButton } from './form-bits'
import { OneTimeSecret } from './one-time-secret'

export type EventFamily = {
  family: string
  types: Array<{ type: string; description: string; emitted: boolean }>
}

/**
 * Event subscription picker. A family checkbox subscribes to every current and
 * future event in it (`invoice.*`), which is usually what an automation wants.
 */
function EventPicker({ families, initial }: { families: EventFamily[]; initial: string[] }) {
  const [all, setAll] = useState(initial.includes('*'))
  const [checkedFamilies, setCheckedFamilies] = useState(
    new Set(initial.filter((p) => p.endsWith('.*')).map((p) => p.slice(0, -2))),
  )

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Events</legend>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="allEvents" checked={all} onChange={(e) => setAll(e.target.checked)} />
        All events, including ones added in future releases
      </label>
      {!all && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {families.map(({ family, types }) => {
            const familyOn = checkedFamilies.has(family)
            return (
              <div key={family} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    name="families"
                    value={family}
                    checked={familyOn}
                    onChange={(e) => {
                      const next = new Set(checkedFamilies)
                      if (e.target.checked) next.add(family)
                      else next.delete(family)
                      setCheckedFamilies(next)
                    }}
                  />
                  {family}.*
                </label>
                <div className="mt-2 space-y-1 pl-5">
                  {types.map((t) => (
                    <label key={t.type} className="flex items-start gap-2 text-xs text-neutral-600 dark:text-neutral-400"
                      title={t.description}>
                      <input
                        type="checkbox"
                        name="types"
                        value={t.type}
                        disabled={familyOn}
                        defaultChecked={familyOn || initial.includes(t.type)}
                        className="mt-0.5"
                      />
                      <span>
                        {t.type.split('.')[1]}
                        {!t.emitted && <span className="ml-1 text-neutral-400">(coming)</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

function SigningSecretReveal({ secret, children }: { secret: string; children?: React.ReactNode }) {
  return (
    <OneTimeSecret
      label="Signing secret"
      secret={secret}
      warning="Copy this signing secret into your receiver now. It won't be shown again; rotate it to get a new one."
    >
      <p className="text-xs text-neutral-500">
        Verify each request&apos;s <code className="font-mono">Workloom-Signature</code> header with it.
        See the webhooks guide in the documentation.
      </p>
      {children}
    </OneTimeSecret>
  )
}

export function CreateWebhookForm({ families }: { families: EventFamily[] }) {
  const [state, action] = useActionState<ActionState<RevealedSecret>, FormData>(createWebhookAction, idle)

  if (state.status === 'success' && state.data) {
    return (
      <SigningSecretReveal secret={state.data.secret}>
        <Link href={`/settings/webhooks/${state.data.endpointId}`} className="text-sm font-medium hover:underline">
          Continue to the endpoint →
        </Link>
      </SigningSecretReveal>
    )
  }

  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="url" label="Endpoint URL" hint="Must be https:// and reachable from the internet." error={fieldError(state, 'url')}>
          <Input id="url" name="url" type="url" required placeholder="https://automation.example.com/hooks/workloom" />
        </Field>
        <Field id="description" label="Description (optional)" error={fieldError(state, 'description')}>
          <Input id="description" name="description" maxLength={200} placeholder="n8n: new invoices" />
        </Field>
      </div>
      <EventPicker families={families} initial={['*']} />
      {fieldError(state, 'eventTypes') && <p role="alert" className="text-xs text-red-600">{fieldError(state, 'eventTypes')}</p>}
      <SubmitButton pendingLabel="Creating…">Create endpoint</SubmitButton>
    </form>
  )
}

export function EditWebhookForm({
  endpoint,
  families,
}: {
  endpoint: { id: string; url: string; description: string | null; eventTypes: string[] }
  families: EventFamily[]
}) {
  const [state, action] = useActionState(updateWebhookAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="id" value={endpoint.id} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="url" label="Endpoint URL" error={fieldError(state, 'url')}>
          <Input id="url" name="url" type="url" required defaultValue={endpoint.url} />
        </Field>
        <Field id="description" label="Description" error={fieldError(state, 'description')}>
          <Input id="description" name="description" maxLength={200} defaultValue={endpoint.description ?? ''} />
        </Field>
      </div>
      <EventPicker families={families} initial={endpoint.eventTypes} />
      {fieldError(state, 'eventTypes') && <p role="alert" className="text-xs text-red-600">{fieldError(state, 'eventTypes')}</p>}
      <SubmitButton pendingLabel="Saving…">Save endpoint</SubmitButton>
    </form>
  )
}

export function SendTestForm({ id }: { id: string }) {
  const [state, action] = useActionState(sendTestWebhookAction, idle)
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Queuing…">Send test event</SubmitButton>
      <FormMessage state={state} />
    </form>
  )
}

export function RotateSecretForm({ id }: { id: string }) {
  const [state, action] = useActionState<ActionState<RevealedSecret>, FormData>(rotateWebhookSecretAction, idle)
  if (state.status === 'success' && state.data) {
    return (
      <SigningSecretReveal secret={state.data.secret}>
        <p className="text-xs text-neutral-500">
          The previous secret keeps signing deliveries for 24 hours, so you can update your receiver without missing events.
        </p>
      </SigningSecretReveal>
    )
  }
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm('Issue a new signing secret? The current one keeps working for 24 hours.')) e.preventDefault()
      }}
      className="space-y-2"
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="secondary" size="sm">Rotate signing secret</Button>
      <FormMessage state={state} />
    </form>
  )
}
