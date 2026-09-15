import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, request } from 'undici'
import { isPublicAddress } from './address.ts'

export type DeliveryResult =
  | { ok: true; status: number; body: string; durationMs: number }
  | { ok: false; status: number | null; body: string | null; error: string; durationMs: number }

const TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 2048

/**
 * A DNS lookup that refuses private and reserved addresses.
 *
 * Installed as the connection-time resolver, so the address actually
 * connected to is the address that was checked -- there is no gap between
 * "check" and "connect" for a rebinding DNS server to exploit.
 */
function guardedLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    options: object,
    callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, [])
      const list = addresses as LookupAddress[]
      if (!allowPrivate) {
        const bad = list.find((a) => !isPublicAddress(a.address))
        if (bad) {
          return callback(
            new Error(`refused: ${hostname} resolved to private or reserved address ${bad.address}`),
            [],
          )
        }
      }
      const wantsAll = (options as { all?: boolean }).all
      if (wantsAll) return callback(null, list)
      const first = list[0]!
      callback(null, first.address, first.family)
    })
  }
}

const agents = new Map<boolean, Agent>()
function agentFor(allowPrivate: boolean): Agent {
  let agent = agents.get(allowPrivate)
  if (!agent) {
    agent = new Agent({
      connect: { lookup: guardedLookup(allowPrivate) as never, timeout: TIMEOUT_MS },
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    })
    agents.set(allowPrivate, agent)
  }
  return agent
}

/** Reads at most MAX_BODY_BYTES of a response and discards the rest. */
async function readCapped(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    if (size < MAX_BODY_BYTES) chunks.push(Buffer.from(chunk))
    size += chunk.byteLength
  }
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8')
}

/**
 * POSTs one webhook.
 *
 * Success is any 2xx. Redirects are not followed and count as failures: a
 * redirect is an unverified second destination, and following one would let a
 * public URL bounce the request somewhere the address check never saw.
 */
export async function deliverWebhook(options: {
  url: string
  body: string
  headers: Record<string, string>
  allowPrivate: boolean
}): Promise<DeliveryResult> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)

  // A URL whose host is an IP literal never goes through DNS, so the guarded
  // lookup below never sees it. It has to be checked here, or
  // `http://169.254.169.254/` walks straight past the connection-time guard.
  let host: string
  try {
    host = new URL(options.url).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return { ok: false, status: null, body: null, error: 'invalid URL', durationMs: elapsed() }
  }
  if (!options.allowPrivate && isIP(host) && !isPublicAddress(host)) {
    return {
      ok: false,
      status: null,
      body: null,
      error: `refused: ${host} is a private or reserved address`,
      durationMs: elapsed(),
    }
  }

  try {
    const response = await request(options.url, {
      method: 'POST',
      body: options.body,
      headers: { 'content-type': 'application/json', ...options.headers },
      dispatcher: agentFor(options.allowPrivate),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await readCapped(response.body)

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { ok: true, status: response.statusCode, body, durationMs: elapsed() }
    }
    return {
      ok: false,
      status: response.statusCode,
      body,
      error:
        response.statusCode >= 300 && response.statusCode < 400
          ? `redirect to ${String(response.headers.location ?? 'unknown')} was not followed`
          : `receiver responded ${response.statusCode}`,
      durationMs: elapsed(),
    }
  } catch (error) {
    const cause = (error as { cause?: Error }).cause
    const message = cause?.message ?? (error as Error).message
    return {
      ok: false,
      status: null,
      body: null,
      error: (error as Error).name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : message,
      durationMs: elapsed(),
    }
  }
}
