import { expect, test } from '@playwright/test'

/**
 * S4: the client view. A converted lead appears among clients; its page
 * gathers people, deals, and history into sections, shows the sections still
 * to come without letting anyone open them, and the API reports the same.
 */

const run = Date.now()
const owner = { name: 'Client Owner', email: `clients+${run}@e2e.test`, password: 'client-view-long-password' }
const clientName = `Harbour Studio ${run}`

test.describe.configure({ mode: 'serial' })

test('a converted lead becomes a client with a unified page', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Clients ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  // Set up through the API: this journey is about the client view, not data entry.
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true)
    return response.json()
  }
  const lead = await post('/api/v1/leads', { contactName: 'Mia Chen', companyName: clientName, email: `mia+${run}@harbour.example` })
  await post('/api/v1/activities', { leadId: lead.id, type: 'call', body: 'First call about a brand refresh' })
  const converted = await post(`/api/v1/leads/${lead.id}/convert`, {})
  await post('/api/v1/deals', { companyId: converted.company.id, name: 'Brand refresh', valueMinor: 1_800_000 })

  await page.getByRole('link', { name: 'Clients', exact: true }).click()
  await expect(page).toHaveURL(/\/clients/)
  const row = page.getByRole('row', { name: new RegExp(clientName) })
  await expect(row.getByText('$18,000.00')).toBeVisible()
  await row.getByRole('link', { name: clientName }).click()

  // Overview.
  await expect(page.getByRole('heading', { name: clientName })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Mia Chen' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Brand refresh' })).toBeVisible()
  await expect(page.getByText('First call about a brand refresh')).toBeVisible()

  const sections = page.getByRole('navigation', { name: 'Client sections' })
  await sections.getByRole('link', { name: /Contacts/ }).click()
  await expect(page).toHaveURL(/tab=contacts/)
  await expect(page.getByRole('cell', { name: 'Mia Chen' })).toBeVisible()

  await sections.getByRole('link', { name: /Activity/ }).click()
  await expect(page).toHaveURL(/tab=activity/)
  await page.getByLabel('What happened').fill('Sent the proposal')
  await page.getByRole('button', { name: 'Log' }).click()
  await expect(page.getByText('Sent the proposal')).toBeVisible()
  await expect(sections.getByRole('link', { name: /Activity/ })).toContainText('2')

  // Sections still to come are shown, but cannot be opened.
  const notYet = page.getByRole('list', { name: 'Not yet available' })
  for (const label of ['Support', 'Maintenance', 'Infrastructure', 'Documents']) {
    await expect(notYet.getByText(label)).toBeVisible()
    await expect(page.getByRole('link', { name: new RegExp(`^${label}`) })).toHaveCount(0)
  }
  // A section that has not shipped yet falls back to the overview.
  await page.goto(`${new URL(page.url()).pathname}?tab=support`)
  await expect(page.getByRole('link', { name: /Overview/ })).toHaveAttribute('aria-current', 'page')

  await sections.getByRole('link', { name: 'Details' }).click()
  await expect(page.getByLabel('Stage')).toHaveValue('client')
})

test('the API describes the same client view', async ({ page, baseURL }) => {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
  expect(baseURL).toBeTruthy()

  const clients = await (await page.request.get(`/api/v1/clients?q=${encodeURIComponent(clientName)}`)).json()
  expect(clients.data).toHaveLength(1)
  expect(clients.data[0]).toMatchObject({ contactCount: 1, openDeals: { count: 1 } })

  const summary = await (await page.request.get(`/api/v1/companies/${clients.data[0].id}/summary`)).json()
  const status = Object.fromEntries(summary.sections.map((s: { key: string; status: string }) => [s.key, s.status]))
  expect(status).toMatchObject({ overview: 'available', contacts: 'available', projects: 'available', quotes: 'available', invoices: 'available', payments: 'available', expenses: 'available', support: 'planned' })
  expect(summary.deals.openValue).toEqual([{ currency: 'AUD', valueMinor: 1_800_000 }])
})
