import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * The Resend driver, against a stand-in for Resend's API on a local port.
 * The environment is set before anything reads it: `env` is parsed once, on
 * first use, and this file is its own module graph.
 */

const KEY = 're_test_key_never_real_1234567890'
let server: Server
let received: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = []
let answer: { status: number; body: unknown } = { status: 200, body: { id: 'email-1' } }

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    response.writeHead(answer.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  Object.assign(process.env, {
    RESEND_API_BASE: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    MAIL_DRIVER: 'resend',
    RESEND_API_KEY: KEY,
    MAIL_FROM: 'workloom@example.com',
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    WORKLOOM_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    NODE_ENV: 'test',
  })
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  received = []
  answer = { status: 200, body: { id: 'email-1' } }
})

const { sendEmail, verifyMailConnection } = await import('./transport.ts')

describe('the Resend driver', () => {
  it('sends the message, with its attachment, using the key', async () => {
    await sendEmail({
      to: 'kyla@example.com',
      subject: 'Invoice INV-0001',
      html: '<p>Hello</p>',
      text: 'Hello',
      attachments: [{ filename: 'INV-0001.pdf', content: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' }],
    })
    expect(received).toHaveLength(1)
    expect(received[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(received[0]!.body).toEqual({
      from: 'workloom@example.com',
      to: ['kyla@example.com'],
      subject: 'Invoice INV-0001',
      html: '<p>Hello</p>',
      text: 'Hello',
      attachments: [{ filename: 'INV-0001.pdf', content: Buffer.from('%PDF-1.7').toString('base64'), content_type: 'application/pdf' }],
    })
  })

  it('fails with Resend’s reason, and never the key', async () => {
    answer = { status: 403, body: { message: 'The example.com domain is not verified.' } }
    const error = await sendEmail({ to: 'a@example.com', subject: 's', html: 'h', text: 't' }).catch((e: unknown) => e)
    expect(String(error)).toMatch(/Resend refused the message \(403\): The example.com domain is not verified/)
    expect(String(error)).not.toContain(KEY)
  })

  it('counts as configured when it has a key', async () => {
    expect(await verifyMailConnection()).toBe(true)
  })
})
