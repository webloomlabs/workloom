import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Webhook signatures.
 *
 *   Workloom-Signature: t=1789459760,v1=5257a8...,v1=9f11c2...
 *
 * The HMAC covers `<timestamp>.<body>`, so the timestamp cannot be swapped
 * without invalidating the signature. A receiver that rejects old timestamps
 * is therefore protected from replayed deliveries.
 *
 * During secret rotation a delivery carries one `v1` per active secret. A
 * receiver checks whether ANY of them verifies, which lets it move to the new
 * secret at its own pace without dropping events in between.
 */

export const SIGNATURE_HEADER = 'Workloom-Signature'
const SECRET_PREFIX = 'whsec_'

export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64url')
}

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

export function signPayload(options: { body: string; secrets: string[]; timestamp: number }): string {
  const signatures = options.secrets.map((s) => `v1=${hmac(s, options.timestamp, options.body)}`)
  return [`t=${options.timestamp}`, ...signatures].join(',')
}

/**
 * The reference verifier -- what the webhook documentation tells receivers to
 * implement, and what the tests use to prove deliveries verify.
 */
export function verifySignature(options: {
  header: string
  body: string
  secret: string
  /** Seconds either side of now to accept. */
  toleranceSeconds?: number
  now?: number
}): boolean {
  const parts = options.header.split(',').map((p) => p.split('=', 2) as [string, string])
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1])
  if (!Number.isInteger(timestamp)) return false

  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false

  const expected = Buffer.from(hmac(options.secret, timestamp, options.body), 'hex')
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const candidate = Buffer.from(v ?? '', 'hex')
      return candidate.length === expected.length && timingSafeEqual(candidate, expected)
    })
}
