import { expect, test, type Page } from '@playwright/test'

/**
 * S11 in one journey: a client is put on a maintenance plan with a retainer
 * behind it, the retainer raises a draft invoice for its first period, a
 * ticket arrives and is answered against the plan's service level, and the
 * client's domain is recorded with the renewal date that matters.
 *
 * Over the API, the same plan decides a ticket's targets, and a period cannot
 * be billed twice.
 */

const run = Date.now()
const owner = { name: 'Service Owner', email: `service+${run}@e2e.test`, password: 'service-long-password' }
const clientName = `Harbour Studio ${run}`

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

test('a client is put on a plan, billed for it, and supported under it', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Service ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true)
    return response.json()
  }
  // The client exists already; this journey is about what happens afterwards.
  await post('/api/v1/companies', { name: clientName, lifecycleStage: 'client' })

  // A retainer: every month, starting today, so its first period is due now.
  await page.getByRole('link', { name: 'Recurring', exact: true }).click()
  await page.getByRole('link', { name: 'New schedule' }).click()
  await page.getByLabel('Client').selectOption({ label: clientName })
  await page.getByLabel('Name', { exact: true }).fill('Website care plan')
  await page.getByLabel('Description').fill('Care plan')
  await page.getByLabel('Amount', { exact: true }).fill('500.00')
  await page.getByRole('button', { name: 'Create schedule' }).click()
  await expect(page).toHaveURL(/\/recurring\/[0-9a-f-]+$/)
  await expect(page.getByText('is due', { exact: false })).toBeVisible()

  // Raising it produces a draft, not an issued invoice.
  await page.getByRole('button', { name: /Raise this period now/ }).click()
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]+$/)
  await expect(page.getByRole('heading', { name: 'Website care plan' })).toBeVisible()
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('$500.00').first()).toBeVisible()

  // The plan the client is on, with the schedule behind it.
  await page.getByRole('link', { name: 'Maintenance', exact: true }).click()
  await page.getByRole('link', { name: 'New plan' }).click()
  await page.getByLabel('Client').selectOption({ label: clientName })
  await page.getByLabel('Name', { exact: true }).fill('Care plan')
  await page.getByLabel('Response target (hours)').fill('4')
  await page.getByRole('textbox', { name: 'Inclusion 1' }).fill('Security updates')
  await page.getByLabel('Billed by').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Create plan' }).click()
  await expect(page).toHaveURL(/\/maintenance\/[0-9a-f-]+$/)
  await expect(page.getByText('4 hours')).toBeVisible()

  // What was done under it.
  await page.getByLabel('What was done').fill('Applied core and plugin updates')
  await page.getByRole('button', { name: 'Record' }).click()
  await expect(page.getByRole('cell', { name: 'Applied core and plugin updates' })).toBeVisible()

  // A ticket, which takes its targets from the plan rather than the priority.
  await page.getByRole('link', { name: 'Tickets', exact: true }).click()
  await page.getByRole('link', { name: 'Raise a ticket' }).click()
  await page.getByLabel('Summary').fill('Contact form stopped sending')
  await page.getByLabel('Client').selectOption({ label: clientName })
  await page.getByLabel('What happened').fill('Nothing has arrived since Tuesday.')
  await page.getByRole('button', { name: 'Raise ticket' }).click()
  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]+$/)
  await expect(page.getByText(/^T-\d+$/)).toBeVisible()
  await expect(page.getByText('Resolution running')).toBeVisible()

  // An internal note is not an answer; a reply is.
  await page.getByLabel('Reply').fill('SMTP password looks expired.')
  await page.getByLabel('Internal note').check()
  await page.getByRole('button', { name: 'Post' }).click()
  await expect(page.getByText('Internal', { exact: true })).toBeVisible()
  await expect(page.getByText('Not answered yet')).toBeVisible()

  await page.getByLabel('Reply').fill('Fixed — please try the form again.')
  await page.getByRole('button', { name: 'Post' }).click()
  await expect(page.getByText('Response met')).toBeVisible()

  await page.getByLabel('Status').selectOption('resolved')
  await expect(page.getByText('Resolution met')).toBeVisible()

  // The client's domain, and the renewal date the module exists for.
  await page.getByRole('link', { name: 'Infrastructure', exact: true }).click()
  await page.getByRole('link', { name: 'Add infrastructure' }).click()
  await page.getByLabel('Name', { exact: true }).fill(`harbour-${run}.example`)
  await page.getByLabel('Kind').selectOption('domain')
  await page.getByLabel('Client').selectOption({ label: clientName })
  await page.getByLabel('Renews or expires').fill('2030-01-31')
  await page.getByRole('button', { name: 'Add to infrastructure' }).click()
  await expect(page).toHaveURL(/\/infrastructure\/[0-9a-f-]+$/)

  // All four sections of the client record now hold something.
  await page.getByRole('link', { name: 'Clients', exact: true }).click()
  await page.getByRole('link', { name: clientName }).click()
  const sections = page.getByRole('navigation', { name: 'Client sections' })
  await sections.getByRole('link', { name: /^Support/ }).click()
  await expect(page).toHaveURL(/tab=support/)
  await expect(page.getByRole('link', { name: 'Contact form stopped sending' })).toBeVisible()
  await sections.getByRole('link', { name: /^Maintenance/ }).click()
  await expect(page).toHaveURL(/tab=maintenance/)
  await expect(page.getByRole('cell', { name: /^Care plan/ })).toBeVisible()
  await expect(page.getByText('Applied core and plugin updates')).toBeVisible()
  await sections.getByRole('link', { name: /^Infrastructure/ }).click()
  await expect(page).toHaveURL(/tab=infrastructure/)
  await expect(page.getByRole('link', { name: `harbour-${run}.example` })).toBeVisible()
})

test('the API bills a period once, and answers to the same plan', async ({ page, baseURL }) => {
  await signIn(page)
  expect(baseURL).toBeTruthy()

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    return { ok: response.ok(), body: await response.json() }
  }
  const get = async (path: string) => (await page.request.get(path)).json()

  const clients = await get(`/api/v1/clients?q=${encodeURIComponent(clientName)}`)
  const companyId = clients.data[0].id

  // The plan decides the targets, whatever the priority says.
  const ticket = await post('/api/v1/tickets', { companyId, title: 'Second request', body: 'Another one', priority: 'low' })
  expect(ticket.ok).toBe(true)
  const promised = new Date(ticket.body.firstResponseDueAt).getTime() - new Date(ticket.body.createdAt).getTime()
  expect(Math.round(promised / 3_600_000)).toBe(4)

  // The period already billed cannot be billed again.
  const schedules = await get(`/api/v1/billing-schedules?companyId=${companyId}`)
  const schedule = schedules.data[0]
  expect(schedule.generatedCount).toBe(1)

  const invoices = await get(`/api/v1/billing-schedules/${schedule.id}/invoices`)
  expect(invoices.data).toHaveLength(1)
  expect(invoices.data[0].periodStart).toBe(schedule.startOn)

  // Nothing is due until the next period arrives.
  const again = await post(`/api/v1/billing-schedules/${schedule.id}/generate`, {})
  expect(again.ok).toBe(true)
  expect(again.body.invoiceId).toBeNull()
  expect(again.body.schedule.generatedCount).toBe(1)
})
