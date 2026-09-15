import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'

/**
 * S2 in one journey: an owner registers a webhook endpoint in the UI, sends a
 * test event, receives a correctly signed request, and sees the delivery
 * logged; a real change then arrives as an event; the API honours
 * idempotency keys and refuses cross-origin cookie writes.
 *
 * Requires the worker to be running, and both it and the app started with
 * WORKLOOM_ALLOW_PRIVATE_WEBHOOKS=true -- the receiver below is on localhost,
 * which is exactly what the SSRF guard otherwise refuses.
 */

type Received = { headers: IncomingHttpHeaders; body: string }

const run = Date.now()
const owner = { name: 'Hook Owner', email: `hooks+${run}@e2e.test`, password: 'webhooks-long-password' }

let server: Server
let receiverUrl: string
const received: Received[] = []

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.writeHead(200).end('received')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
})

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/**
 * Verification written from the documentation, independently of Workloom's
 * own code -- the point is to prove a receiver following the docs succeeds.
 */
function verify(header: string, body: string, secret: string): boolean {
  const parts = header.split(',').map((p) => p.split('=') as [string, string])
  const timestamp = parts.find(([k]) => k === 't')?.[1]
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest()
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const candidate = Buffer.from(v, 'hex')
      return candidate.length === expected.length && timingSafeEqual(candidate, expected)
    })
}

async function waitFor(type: string): Promise<Received> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const match = received.find((r) => JSON.parse(r.body).type === type)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no ${type} delivery within 30s -- is the worker running with WORKLOOM_ALLOW_PRIVATE_WEBHOOKS=true?`)
}

async function signUpWithOrganization(page: Page) {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByLabel('Organization name').fill(`Hooks ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)
}

test.describe.configure({ mode: 'serial' })

test('a webhook receives a signed test event and a real change', async ({ page }) => {
  await signUpWithOrganization(page)

  await page.getByRole('link', { name: 'Webhooks' }).click()
  await page.getByLabel('Endpoint URL').fill(receiverUrl)
  await page.getByLabel('Description (optional)').fill('e2e receiver')
  await page.getByRole('button', { name: 'Create endpoint' }).click()

  const secret = await page.getByLabel('Signing secret').inputValue()
  expect(secret).toMatch(/^whsec_/)
  await page.getByRole('link', { name: /Continue to the endpoint/ }).click()

  await page.getByRole('button', { name: 'Send test event' }).click()
  await expect(page.getByText('Test event queued.')).toBeVisible()

  const test = await waitFor('webhook.test')
  const payload = JSON.parse(test.body)
  expect(test.headers['workloom-event-id']).toBe(payload.id)
  expect(verify(test.headers['workloom-signature'] as string, test.body, secret)).toBe(true)
  expect(verify(test.headers['workloom-signature'] as string, test.body, 'whsec_wrong')).toBe(false)

  await page.reload()
  await expect(page.getByRole('cell', { name: 'webhook.test' })).toBeVisible()
  await expect(page.getByText('succeeded')).toBeVisible()

  // A real change, not a test: renaming the organization emits organization.updated.
  await page.goto('/settings/organization')
  await page.getByLabel('Name').fill(`Hooks ${run} renamed`)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved.')).toBeVisible()

  const change = await waitFor('organization.updated')
  expect(JSON.parse(change.body).data).toMatchObject({ name: `Hooks ${run} renamed` })
  expect(verify(change.headers['workloom-signature'] as string, change.body, secret)).toBe(true)
})

test('the API replays an idempotent request and refuses cross-origin cookie writes', async ({ page, baseURL }) => {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)

  const body = { url: receiverUrl, eventTypes: ['invoice.*'], description: `idempotent ${run}` }
  const key = `e2e-${run}`

  const first = await page.request.post('/api/v1/webhooks', {
    data: body,
    headers: { origin: baseURL!, 'idempotency-key': key },
  })
  expect(first.status()).toBe(201)
  const second = await page.request.post('/api/v1/webhooks', {
    data: body,
    headers: { origin: baseURL!, 'idempotency-key': key },
  })
  expect(second.headers()['idempotent-replayed']).toBe('true')
  expect((await second.json()).endpoint.id).toBe((await first.json()).endpoint.id)

  const reused = await page.request.post('/api/v1/webhooks', {
    data: { ...body, eventTypes: ['deal.*'] },
    headers: { origin: baseURL!, 'idempotency-key': key },
  })
  expect(reused.status()).toBe(422)

  const forged = await page.request.post('/api/v1/webhooks', {
    data: body,
    headers: { origin: 'https://evil.example' },
  })
  expect(forged.status()).toBe(403)
  expect((await forged.json()).error.code).toBe('cross_origin_forbidden')
})
