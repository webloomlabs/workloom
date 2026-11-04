'use server'

import { messagingIdentityCreateLinkCode, messagingIdentityRevoke, organizationUpdate, telegramBotConnect, telegramBotDisconnect, telegramBotUpdate, telegramGroupCreateLinkCode, telegramGroupRevoke } from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/** Settings → Telegram: connect the bot, link people, and turn receipt reading on. */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()
const done = (message: string): ActionState => {
  revalidatePath('/settings/telegram')
  return { status: 'success', message }
}

export async function connectBotAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const bot = await call(telegramBotConnect, { token: text(form, 'token'), mode: text(form, 'mode') === 'webhook' ? 'webhook' : 'poll' })
    return done(`Connected @${bot.username}.`)
  } catch (error) {
    return toActionError(error)
  }
}

export async function updateBotAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const mode = text(form, 'mode')
    const paused = text(form, 'paused')
    await call(telegramBotUpdate, {
      ...(mode === 'webhook' || mode === 'poll' ? { mode } : {}),
      ...(paused ? { paused: paused === 'true' } : {}),
    })
    return done('Saved.')
  } catch (error) {
    return toActionError(error)
  }
}

export async function disconnectBotAction(_: ActionState): Promise<ActionState> {
  try {
    await call(telegramBotDisconnect, {})
    return done('Disconnected. Linked people stay linked for a bot you connect later.')
  } catch (error) {
    return toActionError(error)
  }
}

export async function setReceiptReadingAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const enabled = text(form, 'enabled') === 'true'
    await call(organizationUpdate, { receiptReadingEnabled: enabled })
    revalidatePath('/expenses/new')
    return done(enabled ? 'Receipts will be read with AI.' : 'Receipts will be stored unread.')
  } catch (error) {
    return toActionError(error)
  }
}

export type LinkCode = { code: string; deepLink: string; botUsername: string }

export async function createLinkCodeAction(_: ActionState<LinkCode>): Promise<ActionState<LinkCode>> {
  try {
    const made = await call(messagingIdentityCreateLinkCode, {})
    return { status: 'success', message: 'Send this to the bot within ten minutes.', data: { code: made.code, deepLink: made.deepLink, botUsername: made.botUsername } }
  } catch (error) {
    return toActionError(error)
  }
}

export type GroupCode = { code: string; addToGroupLink: string; botUsername: string }

export async function createGroupCodeAction(_: ActionState<GroupCode>): Promise<ActionState<GroupCode>> {
  try {
    const made = await call(telegramGroupCreateLinkCode, {})
    return { status: 'success', message: 'Use it within ten minutes.', data: { code: made.code, addToGroupLink: made.addToGroupLink, botUsername: made.botUsername } }
  } catch (error) {
    return toActionError(error)
  }
}

export async function revokeGroupAction(form: FormData): Promise<void> {
  await call(telegramGroupRevoke, { id: z.uuid().parse(form.get('id')) })
  revalidatePath('/settings/telegram')
}

export async function revokeIdentityAction(form: FormData): Promise<void> {
  await call(messagingIdentityRevoke, { id: z.uuid().parse(form.get('id')) })
  revalidatePath('/settings/telegram')
}
