import { describe, expect, it } from 'vitest'
import { decodeCallback, encodeCallback, TelegramClient, TelegramError } from './client.ts'

const ID = '01a0dd00-0000-7000-8000-0000000019aa'

describe('button data', () => {
  it('round-trips within Telegram’s 64 bytes', () => {
    for (const action of ['confirm', 'discard', 'noProject'] as const) {
      const data = encodeCallback({ action, expenseId: ID })
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
      expect(decodeCallback(data)).toEqual({ action, expenseId: ID })
    }
  })

  it('fits a project choice, two ids, in 64 bytes', () => {
    const value = { action: 'project' as const, expenseId: ID, projectId: 'ffffffff-ffff-7fff-bfff-ffffffffffff' }
    const data = encodeCallback(value)
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(decodeCallback(data)).toEqual(value)
  })

  it('refuses anything else', () => {
    for (const data of [undefined, '', 'x:c:', 'x:z:' + ID, 'x:c:not-a-uuid', `x:c:${ID}; drop table`, 'x:p:short:short', `x:p:${ID}:${ID}`]) expect(decodeCallback(data)).toBeNull()
  })
})

describe('the client', () => {
  it('never puts the token in an error', async () => {
    const token = '4242424242:AASecretTokenThatMustNotLeak_abcdefghij'
    // Nothing listens on this port: the failure message must still not carry the URL.
    const client = new TelegramClient(token, 'http://127.0.0.1:9')
    const error = await client.getMe().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TelegramError)
    expect(String((error as Error).message)).not.toContain(token)
    expect(JSON.stringify(error)).not.toContain(token)
  })
})
