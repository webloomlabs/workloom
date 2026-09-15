import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isPublicAddress, parseWebhookUrl, assertResolvesPublicly } from './address.ts'
import { deliverWebhook } from './deliver.ts'
import { MAX_ATTEMPTS, nextRetryDelay } from './schedule.ts'
import { generateWebhookSecret, signPayload, verifySignature } from './signing.ts'

describe('signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' })
  const now = 1_789_000_000

  it('verify with the secret that signed them', () => {
    const secret = generateWebhookSecret()
    const header = signPayload({ body, secrets: [secret], timestamp: now })
    expect(verifySignature({ header, body, secret, now })).toBe(true)
  })

  it('fail when the body is altered by a single byte', () => {
    const secret = generateWebhookSecret()
    const header = signPayload({ body, secrets: [secret], timestamp: now })
    expect(verifySignature({ header, body: body.replace('paid', 'pail'), secret, now })).toBe(false)
  })

  it('fail when replayed outside the tolerance window', () => {
    const secret = generateWebhookSecret()
    const header = signPayload({ body, secrets: [secret], timestamp: now })
    expect(verifySignature({ header, body, secret, now: now + 301 })).toBe(false)
  })

  it('fail when the timestamp is swapped, since it is inside the signed content', () => {
    const secret = generateWebhookSecret()
    const header = signPayload({ body, secrets: [secret], timestamp: now }).replace(`t=${now}`, `t=${now + 60}`)
    expect(verifySignature({ header, body, secret, now: now + 60 })).toBe(false)
  })

  it('verify under either secret during rotation', () => {
    const [oldSecret, newSecret] = [generateWebhookSecret(), generateWebhookSecret()]
    const header = signPayload({ body, secrets: [newSecret, oldSecret], timestamp: now })
    expect(verifySignature({ header, body, secret: oldSecret, now })).toBe(true)
    expect(verifySignature({ header, body, secret: newSecret, now })).toBe(true)
    expect(verifySignature({ header, body, secret: generateWebhookSecret(), now })).toBe(false)
  })
})

describe('address classification', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::7f00:1',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true)
    },
  )

  it('treats a non-address as unsafe', () => {
    expect(isPublicAddress('localhost')).toBe(false)
  })
})

describe('webhook URLs', () => {
  it('require https unless private delivery is explicitly allowed', () => {
    expect(() => parseWebhookUrl('http://example.com/hook', { allowPrivate: false })).toThrow(/https/)
    expect(parseWebhookUrl('http://example.com/hook', { allowPrivate: true }).protocol).toBe('http:')
  })

  it('reject embedded credentials', () => {
    expect(() => parseWebhookUrl('https://user:pass@example.com/', { allowPrivate: false })).toThrow(/password/)
  })

  it('reject hosts that resolve privately', async () => {
    await expect(assertResolvesPublicly(new URL('https://127.0.0.1/'))).rejects.toThrow(/private/)
    await expect(assertResolvesPublicly(new URL('https://[::1]/'))).rejects.toThrow(/private/)
    await expect(assertResolvesPublicly(new URL('https://localhost/'))).rejects.toThrow(/private/)
  })
})

describe('retry schedule', () => {
  it('makes eight attempts in total', () => {
    expect(MAX_ATTEMPTS).toBe(8)
    expect(nextRetryDelay(7, () => 0.5)).toBe(12 * 3600)
    expect(nextRetryDelay(8)).toBeNull()
  })

  it('backs off, and jitters within 20%', () => {
    expect(nextRetryDelay(1, () => 0)).toBe(12)
    expect(nextRetryDelay(1, () => 1)).toBe(18)
    expect(nextRetryDelay(2, () => 0.5)).toBe(60)
  })
})

describe('delivery', () => {
  let server: Server
  let base: string
  const received: Array<{ headers: Record<string, unknown>; body: string }> = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push({ headers: req.headers, body })
        if (req.url === '/ok') return res.writeHead(200).end('thanks')
        if (req.url === '/redirect') return res.writeHead(302, { location: 'http://169.254.169.254/' }).end()
        if (req.url === '/big') return res.writeHead(500).end('x'.repeat(100_000))
        res.writeHead(500).end('boom')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
  beforeEach(() => {
    received.length = 0
  })

  it('refuses to connect to a private IP literal', async () => {
    // IP literals skip DNS entirely, so they need their own check: this is
    // the case a lookup-only guard misses.
    const result = await deliverWebhook({ url: `${base}/ok`, body: '{}', headers: {}, allowPrivate: false })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/refused/) })
    expect(received).toHaveLength(0)
  })

  it('refuses an IPv6 loopback literal', async () => {
    const port = (server.address() as AddressInfo).port
    const result = await deliverWebhook({ url: `http://[::1]:${port}/ok`, body: '{}', headers: {}, allowPrivate: false })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/refused/) })
  })

  it('refuses a hostname that resolves privately, at connection time', async () => {
    const port = (server.address() as AddressInfo).port
    const result = await deliverWebhook({
      url: `http://localhost:${port}/ok`,
      body: '{}',
      headers: {},
      allowPrivate: false,
    })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/refused/) })
    expect(received).toHaveLength(0)
  })

  it('delivers when private delivery is allowed, and reports success', async () => {
    const result = await deliverWebhook({
      url: `${base}/ok`,
      body: '{"a":1}',
      headers: { 'workloom-event-id': 'evt_1' },
      allowPrivate: true,
    })
    expect(result).toMatchObject({ ok: true, status: 200, body: 'thanks' })
    expect(received.at(-1)).toMatchObject({ body: '{"a":1}', headers: { 'workloom-event-id': 'evt_1' } })
  })

  it('does not follow redirects', async () => {
    const result = await deliverWebhook({ url: `${base}/redirect`, body: '{}', headers: {}, allowPrivate: true })
    expect(result).toMatchObject({ ok: false, status: 302, error: expect.stringMatching(/not followed/) })
  })

  it('caps the stored response body', async () => {
    const result = await deliverWebhook({ url: `${base}/big`, body: '{}', headers: {}, allowPrivate: true })
    expect(result.ok).toBe(false)
    expect(result.body!.length).toBe(2048)
  })
})
