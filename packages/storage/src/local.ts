import { env } from '@workloom/config'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertSafeKey, assertSafePrefix, servesInline, type PutOptions, type SignedUrlOptions, type Storage, type StoredObject } from './types.ts'

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

  async putFile(key: string, path: string, options?: PutOptions): Promise<StoredObject> {
    const full = this.path(key)
    await mkdir(dirname(full), { recursive: true })
    await copyFile(path, full)
    return { key, size: (await stat(full)).size, contentType: options?.contentType ?? 'application/octet-stream' }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key))
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertSafePrefix(prefix)
    const dir = this.path(prefix.slice(0, -1))
    let files: number
    try {
      files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    await rm(dir, { recursive: true, force: true })
    return files
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
   * application route carrying an expiring signature over the key, expiry,
   * filename, and content type. Changing any of them invalidates the URL.
   */
  async signedUrl(key: string, options: SignedUrlOptions = {}): Promise<string> {
    assertSafeKey(key)
    const params: SignedParams = {
      key,
      expires: String(Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 300)),
      name: options.filename ?? key.split('/').pop()!,
      type: options.contentType ?? 'application/octet-stream',
      ...(servesInline(options) ? { disposition: 'inline' } : {}),
    }
    const signature = sign(params)
    return `${env.APP_URL}/api/files?${new URLSearchParams({ ...params, signature })}`
  }

  /** The parameters of a valid, unexpired signed URL, or null. */
  static verify(query: URLSearchParams): { key: string; name: string; type: string; inline: boolean } | null {
    const params: SignedParams = {
      key: query.get('key') ?? '',
      expires: query.get('expires') ?? '',
      name: query.get('name') ?? '',
      type: query.get('type') ?? '',
      ...(query.has('disposition') ? { disposition: query.get('disposition') ?? '' } : {}),
    }
    const expires = Number(params.expires)
    if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000)) return null
    const provided = Buffer.from(query.get('signature') ?? '', 'hex')
    const expected = Buffer.from(sign(params), 'hex')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null
    try {
      assertSafeKey(params.key)
    } catch {
      return null
    }
    return { key: params.key, name: params.name, type: params.type, inline: params.disposition === 'inline' && servesInline({ inline: true, contentType: params.type }) }
  }
}

/**
 * Signs with a key derived for this one purpose, so a URL signature can never
 * be confused with anything else computed from the encryption key.
 */
type SignedParams = { key: string; expires: string; name: string; type: string; disposition?: string }

function sign(params: SignedParams): string {
  const signingKey = createHmac('sha256', Buffer.from(env.WORKLOOM_ENCRYPTION_KEY, 'base64'))
    .update('workloom:storage-url:v1')
    .digest()
  // Length-prefixed, so no choice of fields can collide with another.
  const fields = [params.key, params.expires, params.name, params.type, ...(params.disposition !== undefined ? [params.disposition] : [])]
  const message = fields.map((f) => `${f.length}:${f}`).join('|')
  return createHmac('sha256', signingKey).update(message).digest('hex')
}
