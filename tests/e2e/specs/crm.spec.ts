import { expect, test, type Page } from '@playwright/test'

/**
 * S3 in one journey: a lead is captured, worked, and converted into a client
 * with its history intact; a deal moves through the pipeline, and winning it
 * makes its company a client; the same lifecycle runs over the REST API.
 */

const run = Date.now()
const owner = { name: 'Crm Owner', email: `crm+${run}@e2e.test`, password: 'pipeline-long-password' }

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

const idFrom = (page: Page) => page.url().split('/').pop()!.split('?')[0]!

test.describe.configure({ mode: 'serial' })

test('a lead is worked, converted, and becomes a client with its history', async ({ page }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`CRM ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  await page.getByRole('link', { name: 'Leads', exact: true }).click()
  await page.getByText('Add a lead').click()
  await page.getByLabel('Name', { exact: true }).fill('Jane Doe')
  await page.getByLabel('Company', { exact: true }).fill(`Acme ${run}`)
  await page.getByLabel('Email').fill(`jane+${run}@acme.example`)
  await page.getByLabel('Website').fill('javascript:alert(1)')
  await page.getByRole('button', { name: 'Add lead' }).click()

  // Refused, with what was typed still there.
  await expect(page.getByText('Enter a web address such as example.com.')).toBeVisible()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Jane Doe')
  await page.getByLabel('Website').fill('acme.example')
  await page.getByRole('button', { name: 'Add lead' }).click()
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/)

  await page.getByRole('button', { name: 'Contacted' }).click()
  await expect(page.getByRole('button', { name: 'Contacted' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByLabel('What happened').fill('Discovery call: wants a new marketing site')
  await page.getByLabel('Type').selectOption('call')
  await page.getByRole('button', { name: 'Log' }).click()
  await expect(page.getByText('Discovery call: wants a new marketing site')).toBeVisible()

  await expect(page.getByLabel('New company name')).toHaveValue(`Acme ${run}`)
  await page.getByRole('button', { name: 'Convert lead' }).click()

  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: `Acme ${run}` })).toBeVisible()
  await expect(page.getByLabel('Stage')).toHaveValue('client')
  await expect(page.getByText(/Client since/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Jane Doe' })).toBeVisible()
  // The call logged against the lead is on the client's timeline.
  await expect(page.getByText('Discovery call: wants a new marketing site')).toBeVisible()
})

test('a deal moves through the pipeline, and winning it makes a client', async ({ page }) => {
  await signIn(page)
  await expect(page).toHaveURL(/\/pipeline/)

  await page.getByRole('link', { name: 'Companies', exact: true }).click()
  await page.getByText('Add a company').click()
  await page.getByLabel('Name', { exact: true }).fill(`Prospect ${run}`)
  await page.getByRole('button', { name: 'Add company' }).click()
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/)
  await expect(page.getByLabel('Stage')).toHaveValue('prospect')
  const companyUrl = page.url()

  await page.getByRole('link', { name: 'New deal' }).click()
  await page.getByLabel('Deal name').fill(`Rebuild ${run}`)
  await page.getByLabel('Value').fill('12,500.505')
  await page.getByRole('button', { name: 'Open deal' }).click()
  await expect(page.getByText('AUD allows at most 2 decimal places.')).toBeVisible()
  await page.getByLabel('Value').fill('12,500.50')
  await page.getByRole('button', { name: 'Open deal' }).click()
  await expect(page).toHaveURL(/\/deals\/[0-9a-f-]{36}$/)
  await expect(page.getByText('$12,500.50').first()).toBeVisible()
  const dealId = idFrom(page)

  await page.getByRole('link', { name: 'Pipeline', exact: true }).click()
  const qualified = page.getByRole('region', { name: /Qualified/ })
  await expect(qualified.getByRole('link', { name: `Rebuild ${run}` })).toBeVisible()

  await page.locator(`#stage-${dealId}`).selectOption('won')
  const won = page.getByRole('region', { name: /Won/ })
  await expect(won.getByRole('link', { name: `Rebuild ${run}` })).toBeVisible()

  await page.goto(companyUrl)
  await expect(page.getByLabel('Stage')).toHaveValue('client')
  await expect(page.getByText(/Client since/)).toBeVisible()
})

test('the same lifecycle works over the REST API', async ({ page, baseURL }) => {
  await signIn(page)
  const headers = { origin: baseURL! }

  const lead = await page.request.post('/api/v1/leads', {
    headers,
    data: { contactName: 'Api Person', companyName: `Api Co ${run}`, source: 'partner' },
  })
  expect(lead.status()).toBe(201)
  const { id } = (await lead.json()) as { id: string }

  const found = await page.request.get(`/api/v1/leads?q=${encodeURIComponent(`Api Co ${run}`)}`)
  expect(((await found.json()) as { data: Array<{ id: string }> }).data.map((l) => l.id)).toEqual([id])

  const converted = await page.request.post(`/api/v1/leads/${id}/convert`, {
    headers,
    data: { deal: { name: 'Retainer', valueMinor: 300_000 } },
  })
  expect(converted.status()).toBe(200)
  const result = (await converted.json()) as { company: { lifecycleStage: string }; deal: { id: string; stage: string } }
  expect(result.company.lifecycleStage).toBe('prospect')
  expect(result.deal.stage).toBe('qualified')

  const again = await page.request.post(`/api/v1/leads/${id}/convert`, { headers, data: {} })
  expect(again.status()).toBe(422)
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe('lead_converted')

  const stage = await page.request.post(`/api/v1/deals/${result.deal.id}/stage`, { headers, data: { stage: 'won' } })
  expect(((await stage.json()) as { stage: string; previousStage: string })).toMatchObject({
    stage: 'won',
    previousStage: 'qualified',
  })

  const pipeline = await page.request.get('/api/v1/pipeline')
  const { stages } = (await pipeline.json()) as { stages: Array<{ stage: string; count: number }> }
  expect(stages.find((s) => s.stage === 'won')!.count).toBeGreaterThanOrEqual(2)

  const missing = await page.request.get(`/api/v1/companies/${crypto.randomUUID()}`)
  expect(missing.status()).toBe(404)
})
