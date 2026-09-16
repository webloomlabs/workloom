import { expect, test, type Page } from '@playwright/test'
import { waitForEmail } from './mailpit.ts'

/**
 * S7b in one journey: billing details are set, tracked time becomes an invoice,
 * the invoice is issued and emailed with its PDF, the client opens their link
 * with no account, and the invoice is cancelled. Over the API, a quote becomes
 * an invoice that never re-prices, an issued invoice refuses change, and billed
 * time is frozen.
 */

const run = Date.now()
const owner = { name: 'Invoice Owner', email: `invoices+${run}@e2e.test`, password: 'invoices-long-password' }
const clientEmail = `accounts+${run}@e2e.test`

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

test('tracked time becomes an invoice, issued, emailed, opened by the client, then cancelled', async ({ page, browser, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Invoices ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }

  // What goes at the top of an invoice, and how it is paid.
  await page.getByLabel('Legal name').fill('Webloom Labs Pty Ltd')
  await page.getByLabel('Tax number').fill('ABN 12 345 678 901')
  await page.getByLabel('Address').fill('1 Harbour St\nSydney NSW 2000')
  await page.getByLabel('How to pay').fill('Transfer to BSB 000-000, account 1234567.')
  await page.getByLabel('Payment terms (days)').fill('21')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible()

  const company = await post('/api/v1/companies', { name: `Harbour ${run}`, email: clientEmail })
  await post('/api/v1/contacts', { firstName: 'Ada', lastName: 'Lovelace', companyId: company.id, email: clientEmail })
  const project = await post('/api/v1/projects', { name: `Harbour site ${run}`, companyId: company.id })
  const task = await post('/api/v1/tasks', { projectId: project.id, title: 'Design' })
  await post('/api/v1/tax-rates', { name: 'GST', rate: '10' })
  await post('/api/v1/rates', { billableRateMinor: 150_00, costRateMinor: 60_00 })
  await post('/api/v1/time-entries', { taskId: task.id, durationSeconds: 5400 })
  await post('/api/v1/time-entries', { taskId: task.id, durationSeconds: 1800 })

  // A draft, billed from the time already tracked.
  await page.goto(`/companies/${company.id}?tab=invoices`)
  await page.getByRole('link', { name: 'New invoice' }).click()
  await page.getByLabel('Title').fill('September work')
  await expect(page.getByLabel('Payment terms (days)')).toHaveValue('21')
  await page.getByRole('button', { name: 'Create draft' }).click()
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/)
  const invoiceUrl = page.url()

  const billTime = page.locator('form', { has: page.getByRole('button', { name: 'Add unbilled time' }) })
  await billTime.getByLabel('Tax').selectOption({ label: 'GST (10%)' })
  await billTime.getByRole('button', { name: 'Add unbilled time' }).click()
  await expect(page.getByRole('status').filter({ hasText: /Billed 2 entries as 1 lines/ })).toBeVisible()
  const totals = page.getByLabel('Invoice totals')
  // Two hours at 150.00, plus GST.
  await expect(totals).toContainText('$300.00')
  await expect(totals).toContainText('GST 10%$30.00')
  await expect(totals).toContainText('Total$330.00')

  const addLine = page.locator('form', { has: page.getByRole('button', { name: 'Add line' }) })
  await addLine.getByLabel('Description').fill('Domain renewal')
  await addLine.getByLabel(/Unit price/).fill('50')
  await addLine.getByLabel('Tax').selectOption({ label: 'No tax' })
  await addLine.getByRole('button', { name: 'Add line' }).click()
  await expect(totals).toContainText('Total$380.00')

  // Issued and emailed.
  await page.getByLabel('Contact').selectOption({ label: 'Ada Lovelace' })
  await page.getByRole('button', { name: 'Save details' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  const issue = page.locator('form', { has: page.getByRole('button', { name: 'Issue invoice' }) })
  await issue.getByLabel('Email it to the client').check()
  await issue.getByLabel('To', { exact: true }).fill(clientEmail)
  page.once('dialog', (dialog) => dialog.accept())
  await issue.getByRole('button', { name: 'Issue invoice' }).click()
  await expect(page.getByText('INV-0001')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add line' })).toHaveCount(0)

  const email = await waitForEmail(clientEmail, /INV-0001/)
  expect(email.Subject).toContain('Webloom Labs Pty Ltd')
  expect(email.Attachments[0]).toMatchObject({ FileName: expect.stringContaining('INV-0001'), ContentType: 'application/pdf' })
  expect(email.Attachments[0]!.Size).toBeGreaterThan(1000)

  // The client opens their link, with no account at all.
  const link = await page.getByLabel("The client's link").inputValue()
  const clientContext = await browser.newContext()
  const clientPage = await clientContext.newPage()
  await clientPage.goto(link)
  await expect(clientPage.getByRole('heading', { name: 'Webloom Labs Pty Ltd' })).toBeVisible()
  await expect(clientPage.getByText('INV-0001')).toBeVisible()
  await expect(clientPage.getByText('Transfer to BSB 000-000')).toBeVisible()
  await expect(clientPage.getByText('$380.00')).toBeVisible()
  // Nothing of the organization's is reachable from here.
  await expect(clientPage.getByRole('link', { name: 'Invoices' })).toHaveCount(0)
  const [download] = await Promise.all([clientPage.waitForEvent('download'), clientPage.getByRole('link', { name: 'Download PDF' }).click()])
  expect(download.suggestedFilename()).toContain('INV-0001')
  await clientContext.close()

  // Which the organization can see.
  await page.goto(invoiceUrl)
  await expect(page.getByText('Viewed', { exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /The client opened it/ })).toBeVisible()

  await page.getByRole('button', { name: 'Cancel invoice…' }).click()
  await page.getByLabel('Why? (optional)').fill('Raised against the wrong project')
  await page.getByRole('button', { name: 'Cancel this invoice' }).click()
  await expect(page.getByRole('status').filter({ hasText: /Cancelled/ })).toBeVisible()
})

test('the API raises invoices from quotes, freezes issued ones, and holds billed time', async ({ page, baseURL }) => {
  await signIn(page)
  const headers = { origin: baseURL! }
  const send = async (method: 'post' | 'patch' | 'delete' | 'get', path: string, data?: unknown) => {
    const response = await page.request[method](path, { headers, ...(data === undefined ? {} : { data }) })
    return { status: response.status(), body: await response.json() }
  }

  const company = (await send('post', '/api/v1/companies', { name: `API client ${run}` })).body
  const tax = (await send('post', '/api/v1/tax-rates', { name: `VAT ${run}`, rate: '20' })).body
  const service = (await send('post', '/api/v1/services', { name: `Retainer ${run}`, defaultPriceMinor: 100_00, defaultTaxRateId: tax.id })).body
  const quote = (await send('post', '/api/v1/quotes', { companyId: company.id, title: 'Retainer', lines: [{ serviceId: service.id, quantity: '3' }] })).body
  await send('post', `/api/v1/quotes/${quote.id}/send`, {})

  const raised = await send('post', `/api/v1/quotes/${quote.id}/invoice`, {})
  expect(raised.status).toBe(201)
  expect(raised.body).toMatchObject({ status: 'draft', quoteId: quote.id, totalMinor: quote.totalMinor, subtotalMinor: 300_00 })

  // The catalogue moves on; the invoice keeps what was agreed.
  await send('patch', `/api/v1/services/${service.id}`, { defaultPriceMinor: 999_00 })
  const reread = await send('get', `/api/v1/invoices/${raised.body.id}`)
  expect(reread.body.lines[0]).toMatchObject({ unitAmountMinor: 100_00, taxRate: '20' })

  const issued = await send('post', `/api/v1/invoices/${raised.body.id}/send`, {})
  expect(issued.body).toMatchObject({ status: 'sent', number: 'INV-0002', exchangeRateToBase: '1' })
  expect(issued.body.dueDate).toBe(
    new Date(new Date(`${issued.body.issueDate}T00:00:00Z`).getTime() + 21 * 86_400_000).toISOString().slice(0, 10),
  )

  expect((await send('patch', `/api/v1/invoices/${raised.body.id}`, { title: 'Changed' })).status).toBe(422)
  expect((await send('delete', `/api/v1/invoices/${raised.body.id}`)).status).toBe(409)

  // The PDF comes through a short-lived link.
  const link = await send('get', `/api/v1/invoices/${raised.body.id}/pdf`)
  expect(link.body.filename).toContain('INV-0002')
  const pdf = await page.request.get(link.body.url)
  expect(pdf.headers()['content-type']).toBe('application/pdf')
  expect(pdf.headers()['content-disposition']).toMatch(/^attachment;/)
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-')
  expect((await page.request.get(`${link.body.url}x`)).status()).toBe(403)

  // Time billed on the first invoice can no longer be edited.
  const entries = await send('get', '/api/v1/time-entries?invoiced=true')
  expect(entries.body.data.length).toBeGreaterThan(0)
  const frozen = await send('patch', `/api/v1/time-entries/${entries.body.data[0].id}`, { durationSeconds: 60 })
  expect(frozen.status).toBe(422)
  expect(frozen.body.error.code).toBe('time_entry_invoiced')
})
