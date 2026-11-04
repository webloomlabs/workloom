'use server'

import { booksLock, booksUnlock, taxPackRequest } from '@workloom/core/modules'
import { revalidatePath } from 'next/cache'
import { call } from '../server/procedures.ts'
import { toActionError } from './errors.ts'
import type { ActionState } from './state.ts'

/** Reports → Income tax pack: ask for a pack, and close or reopen the books. */

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim()

export async function requestTaxPackAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const pack = await call(taxPackRequest, { startYear: Number(text(form, 'startYear')) })
    revalidatePath('/reports/tax')
    return { status: 'success', message: `The ${pack.label} pack is being made. It appears below when it is ready — usually within a minute.` }
  } catch (error) {
    return toActionError(error)
  }
}

export async function lockBooksAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const books = await call(booksLock, { through: text(form, 'through'), reason: text(form, 'reason') })
    revalidatePath('/reports/tax')
    return { status: 'success', message: `The books are closed through ${books.booksLockedThrough}.` }
  } catch (error) {
    return toActionError(error)
  }
}

export async function unlockBooksAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await call(booksUnlock, { to: text(form, 'to') || null, reason: text(form, 'reason') })
    revalidatePath('/reports/tax')
    return { status: 'success', message: 'The books are open again. The reason is in the audit log.' }
  } catch (error) {
    return toActionError(error)
  }
}
