import { createHash, randomBytes } from 'node:crypto'

/**
 * API key generation and hashing.
 *
 * Lives in core rather than auth because the procedures that issue keys are
 * domain operations, and core must never import auth -- that dependency is
 * what would stop the same logic running from a job or a test.
 *
 * Keys are stored as SHA-256 digests, never as secrets: a leaked database
 * backup must not yield working credentials. Plain SHA-256 is correct here,
 * unlike for passwords -- the input is 32 bytes of true randomness, so there
 * is no dictionary to attack, and this runs on every authenticated API
 * request, where a deliberately slow hash would be self-inflicted DoS.
 */

export const API_KEY_PREFIX = 'wl_live_'
const SECRET_BYTES = 32

export type GeneratedApiKey = {
  /** Returned once, at creation. Never stored, never recoverable. */
  secret: string
  hash: string
  /** Stored for display: identifies a key in the UI without revealing it. */
  displayPrefix: string
}

export function generateApiKey(): GeneratedApiKey {
  const secret = API_KEY_PREFIX + randomBytes(SECRET_BYTES).toString('base64url')
  return {
    secret,
    hash: hashApiKey(secret),
    displayPrefix: secret.slice(0, API_KEY_PREFIX.length + 8),
  }
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
