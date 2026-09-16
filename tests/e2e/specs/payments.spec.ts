import { expect, test, type Page } from '@playwright/test'

/**
 * S7c in one journey: an invoice is issued, part paid, seen as part paid on the
 * client's own link, paid off, and reads as paid. An expense is recorded,
 * rebilled with a markup, and frozen while it is billed. Over the API, an
 * over-allocation is refused and a refund frees a paid invoice to be cancelled.
 */

const run = Date.now()
const owner = { name: 'Payments Owner', email: `payments+${run}@e2e.test`, password: 'payments-long-password' }

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

test('an invoice is part paid, then paid, and the client sees what is owing', async ({ page, browser, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Payments ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }

  const company = await post('/api/v1/companies', { name: `Harbour ${run}` })
  const invoice = await post('/api/v1/invoices', {
    companyId: company.id,
    title: 'September work',
    lines: [{ description: 'Design', unitAmountMinor: 1000_00 }],
  })
  await post(`/api/v1/invoices/${invoice.id}/send`, {})

  // Half of it, recorded on the invoice itself.
  await page.goto(`/invoices/${invoice.id}`)
  await expect(page.getByText('Sent', { exact: true })).toBeVisible()
  const record = page.locator('form', { has: page.getByRole('button', { name: 'Record it' }) })
  await expect(record.getByLabel(/^Amount/), 'the amount owing is offered').toHaveValue('1000.00')
  await record.getByLabel(/^Amount/).fill('400')
  await record.getByLabel('Reference').fill('TRF-001')
  await record.getByRole('button', { name: 'Record it' }).click()

  await expect(page.getByText('Part paid', { exact: true })).toBeVisible()
  const totals = page.getByLabel('Invoice totals')
  await expect(totals).toContainText('Paid-$400.00')
  await expect(totals).toContainText('Amount due$600.00')

  // What the client sees on their own link: still owing.
  const link = await page.getByLabel("The client's link").inputValue()
  const clientContext = await browser.newContext()
  const clientPage = await clientContext.newPage()
  await clientPage.goto(link)
  await expect(clientPage.getByText('$400.00')).toBeVisible()
  await expect(clientPage.getByText('$600.00')).toBeVisible()
  await clientContext.close()

  // The rest.
  await page.goto(`/invoices/${invoice.id}`)
  await page.locator('form', { has: page.getByRole('button', { name: 'Record it' }) }).getByRole('button', { name: 'Record it' }).click()
  await expect(totals).toContainText('Amount due$0.00')
  // Nothing left owing, so there is nothing left to record.
  await expect(page.getByRole('button', { name: 'Record it' })).toHaveCount(0)
  await expect(page.getByRole('cell', { name: 'TRF-001' })).toBeVisible()
  await page.goto('/invoices?view=paid')
  await expect(page.getByRole('link', { name: 'September work' })).toBeVisible()

  // And on the payments list, with nothing sitting on account.
  await page.goto('/payments')
  await expect(page.getByRole('cell', { name: 'TRF-001' })).toBeVisible()
  await page.goto('/payments?view=unallocated')
  await expect(page.getByText('No payments match')).toBeVisible()
})

test('a billable expense is rebilled with a markup, and frozen while it is', async ({ page, baseURL }) => {
  await signIn(page)
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  const company = await post('/api/v1/companies', { name: `Rebilling ${run}` })

  await page.goto(`/expenses/new?companyId=${company.id}`)
  await page.getByLabel('What was it').fill('Annual hosting')
  await page.getByLabel('Supplier').fill('Vultr')
  await page.getByLabel(/^Amount, before tax/).fill('120')
  await page.getByLabel('Rebill this to the client').check()
  await page.getByLabel('Markup (%)').fill('25')
  await page.getByRole('button', { name: 'Record expense' }).click()
  await expect(page).toHaveURL(/\/expenses$/)
  await expect(page.getByText('To rebill +25%')).toBeVisible()

  // Onto a draft invoice, at cost plus the markup.
  const invoice = await post('/api/v1/invoices', { companyId: company.id, title: `Rebill ${run}` })
  await page.goto(`/invoices/${invoice.id}`)
  const rebill = page.locator('form', { has: page.getByRole('button', { name: 'Add unbilled expenses' }) })
  await rebill.getByRole('button', { name: 'Add unbilled expenses' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Rebilled 1 expenses.' })).toBeVisible()
  await expect(page.getByLabel('Invoice totals')).toContainText('Total$150.00')

  // The expense is now a statement to the client, and cannot be edited.
  await page.goto('/expenses')
  await page.getByRole('link', { name: 'Annual hosting' }).click()
  await expect(page.getByText(/Rebilled to the client/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0)

  // Removing the line frees it again.
  await page.goto(`/invoices/${invoice.id}`)
  await page.getByRole('button', { name: 'Remove Annual hosting' }).click()
  await expect(page.getByText('No lines yet.')).toBeVisible()
  await page.goto('/expenses?view=billable')
  await expect(page.getByRole('link', { name: 'Annual hosting' })).toBeVisible()
})

test('the API refuses an over-allocation, and a refund frees an invoice to be cancelled', async ({ page, baseURL }) => {
  await signIn(page)
  const headers = { origin: baseURL! }
  const send = async (method: 'post' | 'patch' | 'delete' | 'get', path: string, data?: unknown) => {
    const response = await page.request[method](path, { headers, ...(data === undefined ? {} : { data }) })
    return { status: response.status(), body: await response.json() }
  }

  const company = (await send('post', '/api/v1/companies', { name: `API payer ${run}` })).body
  const invoice = (await send('post', '/api/v1/invoices', { companyId: company.id, title: 'Retainer', lines: [{ description: 'Retainer', unitAmountMinor: 500_00 }] })).body
  await send('post', `/api/v1/invoices/${invoice.id}/send`, {})

  // More than the invoice asks for is refused, and nothing is recorded.
  const tooMuch = await send('post', '/api/v1/payments', {
    companyId: company.id,
    amountMinor: 900_00,
    allocations: [{ invoiceId: invoice.id, amountMinor: 900_00 }],
  })
  expect(tooMuch.status).toBe(422)
  expect(tooMuch.body.error.code).toBe('invoice_over_allocated')
  expect((await send('get', `/api/v1/invoices/${invoice.id}`)).body.amountPaidMinor).toBe(0)

  // Paid in full, so it cannot be cancelled.
  const paid = await send('post', '/api/v1/payments', { companyId: company.id, amountMinor: 500_00, allocations: [{ invoiceId: invoice.id }] })
  expect(paid.status).toBe(201)
  expect(paid.body).toMatchObject({ allocatedMinor: 500_00, unallocatedMinor: 0 })
  expect((await send('get', `/api/v1/invoices/${invoice.id}`)).body).toMatchObject({ status: 'paid', amountDueMinor: 0 })
  const refused = await send('post', `/api/v1/invoices/${invoice.id}/cancel`, {})
  expect(refused.status).toBe(422)
  expect(refused.body.error.code).toBe('invoice_has_payments')

  // Refunding it gives the money back and frees the invoice.
  await send('post', '/api/v1/payments', { companyId: company.id, kind: 'refund', amountMinor: 500_00, allocations: [{ invoiceId: invoice.id }] })
  expect((await send('get', `/api/v1/invoices/${invoice.id}`)).body).toMatchObject({ status: 'refunded', amountPaidMinor: 0 })
  const cancelled = await send('post', `/api/v1/invoices/${invoice.id}/cancel`, { reason: 'Raised against the wrong project' })
  expect(cancelled.body.status).toBe('cancelled')

  // What an invoice has been paid is never written directly.
  expect((await send('patch', `/api/v1/invoices/${invoice.id}`, { title: 'Changed' })).status).toBe(422)
})
