'use server'

import {
  webhookCreate,
  webhookDelete,
  webhookDeliveryRetry,
  webhookRotateSecret,
  webhookTest,
  webhookUpdate,
} from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/**
 * Checkbox selection: "all events" wins; otherwise ticked families replace the
 * individual types they cover, so a stored subscription stays readable.
 */
function selectedEventTypes(form: FormData): string[] {
  if (form.get('allEvents') === 'on') return ['*']
  const families = form.getAll('families').map(String)
  const types = form
    .getAll('types')
    .map(String)
    .filter((t) => !families.includes(t.split('.')[0]!))
  return [...families.map((f) => `${f}.*`), ...types]
}

export type RevealedSecret = { endpointId: string; secret: string }

export async function createWebhookAction(
  _: ActionState<RevealedSecret>,
  form: FormData,
): Promise<ActionState<RevealedSecret>> {
  try {
    const created = await call(webhookCreate, {
      url: String(form.get('url') ?? '').trim(),
      description: String(form.get('description') ?? '').trim() || null,
      eventTypes: selectedEventTypes(form),
    })
    revalidatePath('/settings/webhooks')
    return { status: 'success', data: { endpointId: created.endpoint.id, secret: created.secret } }
  } catch (error) {
    return toActionError(error)
  }
}

export async function updateWebhookAction(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id'))
  try {
    await call(webhookUpdate, {
      id,
      url: String(form.get('url') ?? '').trim(),
      description: String(form.get('description') ?? '').trim() || null,
      eventTypes: selectedEventTypes(form),
    })
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath(`/settings/webhooks/${id}`)
  return { status: 'success', message: 'Endpoint saved.' }
}

export async function setWebhookEnabledAction(form: FormData): Promise<void> {
  const id = z.uuid().parse(form.get('id'))
  await call(webhookUpdate, { id, enabled: form.get('enabled') === 'true' })
  revalidatePath(`/settings/webhooks/${id}`)
}

export async function sendTestWebhookAction(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id'))
  try {
    await call(webhookTest, { id: z.uuid().parse(id) })
  } catch (error) {
    return toActionError(error)
  }
  revalidatePath(`/settings/webhooks/${id}`)
  return {
    status: 'success',
    message: 'Test event queued. It appears under Deliveries within a few seconds.',
  }
}

export async function rotateWebhookSecretAction(
  _: ActionState<RevealedSecret>,
  form: FormData,
): Promise<ActionState<RevealedSecret>> {
  try {
    const id = z.uuid().parse(form.get('id'))
    const rotated = await call(webhookRotateSecret, { id })
    revalidatePath(`/settings/webhooks/${id}`)
    return { status: 'success', data: { endpointId: id, secret: rotated.secret } }
  } catch (error) {
    return toActionError(error)
  }
}

export async function deleteWebhookAction(form: FormData): Promise<void> {
  await call(webhookDelete, { id: z.uuid().parse(form.get('id')) })
  revalidatePath('/settings/webhooks')
  redirect('/settings/webhooks')
}

export async function retryDeliveryAction(form: FormData): Promise<void> {
  const endpointId = z.uuid().parse(form.get('endpointId'))
  await call(webhookDeliveryRetry, { id: z.uuid().parse(form.get('id')) })
  revalidatePath(`/settings/webhooks/${endpointId}`)
}
