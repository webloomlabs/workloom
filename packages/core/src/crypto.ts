import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '@workloom/config'

/**
 * Encryption for secrets that must be recoverable -- webhook signing secrets
 * now, integration credentials later. (Secrets that only need to be checked,
 * like API keys and passwords, are hashed instead and never stored.)
 *
 * AES-256-GCM, so tampering is detected rather than decrypting to garbage.
 * Each value records which key encrypted it, as a short fingerprint of the
 * key rather than a version number: rotation is then just "set the new key,
 * move the old one to WORKLOOM_PREVIOUS_ENCRYPTION_KEYS", with no counter to
 * keep in step across environments.
 *
 *   wlenc:1:<key fingerprint>:<iv>:<auth tag>:<ciphertext>   (base64url parts)
 */

const PREFIX = 'wlenc'
const FORMAT_VERSION = '1'

export type Keyring = { current: Buffer; previous: Buffer[] }

export function fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

export function keyringFromEnv(): Keyring {
  return {
    current: Buffer.from(env.WORKLOOM_ENCRYPTION_KEY, 'base64'),
    previous: env.WORKLOOM_PREVIOUS_ENCRYPTION_KEYS.map((k) => Buffer.from(k, 'base64')),
  }
}

export function encryptSecret(plaintext: string, keyring: Keyring = keyringFromEnv()): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyring.current, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    PREFIX,
    FORMAT_VERSION,
    fingerprint(keyring.current),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':')
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptionError'
  }
}

export function decryptSecret(value: string, keyring: Keyring = keyringFromEnv()): string {
  const parts = value.split(':')
  if (parts.length !== 6 || parts[0] !== PREFIX || parts[1] !== FORMAT_VERSION) {
    throw new DecryptionError('not an encrypted Workloom secret')
  }
  const [, , keyId, iv, tag, ciphertext] = parts as [string, string, string, string, string, string]

  const key = [keyring.current, ...keyring.previous].find((k) => fingerprint(k) === keyId)
  if (!key) {
    // The most likely operational failure: WORKLOOM_ENCRYPTION_KEY was changed
    // without keeping the old one. Say so, rather than "bad decrypt".
    throw new DecryptionError(
      `encrypted with a key that is not configured (fingerprint ${keyId}). If ` +
        'WORKLOOM_ENCRYPTION_KEY was changed, add the previous key to ' +
        'WORKLOOM_PREVIOUS_ENCRYPTION_KEYS.',
    )
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new DecryptionError('secret failed authentication -- it has been altered or corrupted')
  }
}

/** True when a value should be re-encrypted under the current key. */
export function needsReencryption(value: string, keyring: Keyring = keyringFromEnv()): boolean {
  return value.split(':')[2] !== fingerprint(keyring.current)
}

/**
 * Signed values that travel outside the application -- the link a client opens
 * to see an invoice, with no account and no session.
 *
 * The value carries what it names (organization and document) and a signature
 * over it, so nothing has to be stored or looked up before the tenant is known.
 * Each purpose signs with its own derived key, so a token minted for one use
 * can never be replayed as another.
 */
function signingKey(purpose: string, keyring: Keyring = keyringFromEnv()): Buffer {
  return createHmac('sha256', keyring.current).update(`workloom:${purpose}:v1`).digest()
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url')

export function signLinkToken(purpose: string, payload: string): string {
  const signature = createHmac('sha256', signingKey(purpose)).update(payload).digest('base64url')
  return `${b64url(payload)}.${signature}`
}

/** The payload if the signature is this purpose's and intact, else null. */
export function readLinkToken(purpose: string, token: string): string | null {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  const payload = Buffer.from(encoded, 'base64url').toString()
  const expected = createHmac('sha256', signingKey(purpose)).update(payload).digest('base64url')
  const [a, b] = [Buffer.from(signature), Buffer.from(expected)]
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return payload
}
