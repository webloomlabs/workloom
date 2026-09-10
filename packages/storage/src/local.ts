import { env } from '@workloom/config'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertSafeKey, type PutOptions, type Storage, type StoredObject } from './types.ts'

/**
 * Local filesystem storage.
 *
 * The default, so that a single-server install works without provisioning
 * object storage. Files land under STORAGE_LOCAL_PATH, which must be on a
 * persistent volume -- back it up alongside the database.
 */
export class LocalStorage implements Storage {
  private readonly root = resolve(env.STORAGE_LOCAL_PATH)

  private path(key: string): string {
    assertSafeKey(key)
    const full = resolve(join(this.root, key))
    // Defence in depth: assertSafeKey should already have made this impossible.
    if (!full.startsWith(this.root + '/')) throw new TypeError(`storage key escapes root: ${key}`)
    return full
  }

  async put(key: string, body: Buffer | Uint8Array, options?: PutOptions): Promise<StoredObject> {
    const full = this.path(key)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body)
    return {
      key,
      size: body.byteLength,
      contentType: options?.contentType ?? 'application/octet-stream',
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key))
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key))
      return true
    } catch {
      return false
    }
  }

  /**
   * There is no storage host to presign against, so this returns an
   * application route carrying an expiring signature. The route verifies it
   * before streaming the file.
   */
  async signedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    assertSafeKey(key)
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds
    const signature = createHmac('sha256', env.WORKLOOM_ENCRYPTION_KEY)
      .update(`${key}:${expires}`)
      .digest('hex')
    const params = new URLSearchParams({ key, expires: String(expires), signature })
    return `${env.APP_URL}/api/files?${params}`
  }

  static verifySignature(key: string, expires: string, signature: string): boolean {
    if (!Number.isFinite(Number(expires))) return false
    if (Number(expires) < Math.floor(Date.now() / 1000)) return false
    const expected = createHmac('sha256', env.WORKLOOM_ENCRYPTION_KEY)
      .update(`${key}:${expires}`)
      .digest()
    let provided: Buffer
    try {
      provided = Buffer.from(signature, 'hex')
    } catch {
      return false
    }
    return expected.length === provided.length && timingSafeEqual(expected, provided)
  }
}
