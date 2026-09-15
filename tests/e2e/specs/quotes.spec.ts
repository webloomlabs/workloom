import { expect, test, type Page } from '@playwright/test'

/**
 * S7a in one journey: a tax rate and a service are set up, a quote starts from
 * a deal, is priced line by line with a discount, sent, accepted, and
 * duplicated. Over the API, a golden-fixture quote adds up to the cent, a sent
 * quote refuses change, and a foreign-currency quote needs its exchange rate.
 */

const run = Date.now()
const owner = { name: 'Quote Owner', email: `quotes+${run}@e2e.test`, password: 'quotes-long-password' }

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

test('a quote is priced from the catalogue, sent, accepted, and duplicated', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Quotes ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  const company = await post('/api/v1/companies', { name: `Harbour ${run}` })
  const deal = await post('/api/v1/deals', { companyId: company.id, name: 'Website rebuild', valueMinor: 2_000_000 })

  // Tax and the catalogue.
  await page.goto('/settings/tax-rates')
  await page.getByLabel('Name').fill('GST')
  await page.getByLabel('Rate (%)').fill('10')
  await page.getByRole('button', { name: 'Add tax rate' }).click()
  await expect(page.getByRole('cell', { name: 'GST' })).toBeVisible()

  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Services' }).click()
  await expect(page).toHaveURL(/\/settings\/services/)
  await page.getByLabel('Name').fill('Website design')
  await page.getByLabel('Pricing').selectOption('hourly')
  await page.getByLabel('Unit').fill('hour')
  await page.getByLabel('Standard price').fill('150')
  await page.getByLabel('Default tax').selectOption({ label: 'GST (10%)' })
  await page.getByRole('button', { name: 'Add service' }).click()
  await expect(page.getByRole('cell', { name: /\$150\.00 \/ hour/ })).toBeVisible()

  // A draft from the deal.
  await page.goto(`/deals/${deal.id}`)
  await page.getByRole('link', { name: 'Create quote' }).click()
  await expect(page.getByLabel('Title')).toHaveValue('Website rebuild')
  await page.getByRole('button', { name: 'Create draft' }).click()
  await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}$/)
  const totals = page.getByLabel('Quote totals')

  const addLine = page.locator('form', { has: page.getByRole('button', { name: 'Add line' }) })
  await addLine.getByLabel('Service').selectOption({ label: 'Website design · $150.00' })
  await addLine.getByLabel('Qty').fill('12.5')
  await addLine.getByRole('button', { name: 'Add line' }).click()
  await expect(totals).toContainText('$1,875.00')
  await expect(totals).toContainText('GST 10%$187.50')
  await expect(totals).toContainText('$2,062.50')

  await addLine.getByLabel('Description').fill('Hosting setup')
  await addLine.getByLabel(/Unit price/).fill('300')
  await addLine.getByLabel('Tax').selectOption({ label: 'No tax' })
  await addLine.getByRole('button', { name: 'Add line' }).click()
  await expect(totals).toContainText('$2,362.50')

  // Fewer hours.
  await page.getByRole('button', { name: 'Edit Website design' }).click()
  const editLine = page.locator('form', { has: page.getByRole('button', { name: 'Save line' }) })
  await editLine.getByLabel('Qty').fill('10')
  await editLine.getByRole('button', { name: 'Save line' }).click()
  await expect(totals).toContainText('$1,950.00')

  // 10% off: 180.00, shared 150/30, so GST is charged on 1,350.00.
  await page.getByLabel('Discount', { exact: true }).selectOption('percent')
  await page.getByLabel('Percent off').fill('10')
  await page.getByRole('button', { name: 'Save details' }).click()
  await expect(totals).toContainText('Discount (10%)')
  await expect(totals).toContainText('GST 10%$135.00')
  await expect(totals).toContainText('Total$1,755.00')

  // Sent: numbered and frozen.
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Mark as sent' }).click()
  await expect(page.getByText('Q-0001')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add line' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit Website design' })).toHaveCount(0)
  const sentUrl = page.url()

  await page.getByRole('button', { name: 'Accepted' }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Accepted/ })).toBeVisible()

  // Duplicated into a new draft to offer again.
  await page.getByRole('button', { name: 'Duplicate' }).click()
  await expect(page).not.toHaveURL(sentUrl)
  await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}$/)
  await expect(page.getByLabel('Quote totals')).toContainText('$1,755.00')
  await expect(page.getByRole('button', { name: 'Add line' })).toBeVisible()

  // Both on the client's page.
  await page.goto(`/companies/${company.id}?tab=quotes`)
  await expect(page.getByRole('link', { name: 'Website rebuild' })).toHaveCount(2)
  await expect(page.getByText('Q-0001')).toBeVisible()
})

test('the API prices to the cent, keeps sent quotes fixed, and captures exchange rates', async ({ page, baseURL }) => {
  await signIn(page)
  const headers = { origin: baseURL! }
  const send = async (method: 'post' | 'patch' | 'delete', path: string, data?: unknown) => {
    const response = await page.request[method](path, { headers, ...(data === undefined ? {} : { data }) })
    return { status: response.status(), body: await response.json() }
  }

  const company = (await send('post', '/api/v1/companies', { name: `API client ${run}` })).body
  const tax = (await send('post', '/api/v1/tax-rates', { name: `Sales tax ${run}`, rate: 8.875 })).body
  expect(tax.rate).toBe('8.875')

  // The golden fixture "a fractional rate on an awkward amount".
  const created = await send('post', '/api/v1/quotes', {
    companyId: company.id,
    title: 'API quote',
    lines: [{ description: 'Pages', quantity: '3', unitAmountMinor: 333, taxRateId: tax.id }],
  })
  expect(created.status).toBe(201)
  expect(created.body).toMatchObject({ subtotalMinor: 999, taxMinor: 89, totalMinor: 1088, number: null, status: 'draft' })

  const sent = await send('post', `/api/v1/quotes/${created.body.id}/send`, {})
  expect(sent.status).toBe(200)
  expect(sent.body).toMatchObject({ status: 'sent', number: 'Q-0002', exchangeRateToBase: '1', totalBaseMinor: 1088 })

  const edit = await send('patch', `/api/v1/quotes/${created.body.id}`, { title: 'Changed' })
  expect(edit.status).toBe(422)
  expect(edit.body.error.code).toBe('quote_not_draft')
  const removal = await send('delete', `/api/v1/quotes/${created.body.id}`)
  expect(removal.status).toBe(409)

  const yen = await send('post', '/api/v1/quotes', { companyId: company.id, title: 'In yen', currency: 'JPY', lines: [{ description: 'Workshop', unitAmountMinor: 100_000 }] })
  const noRate = await send('post', `/api/v1/quotes/${yen.body.id}/send`, {})
  expect(noRate.status).toBe(422)
  expect(noRate.body.error.code).toBe('exchange_rate_required')
  const withRate = await send('post', `/api/v1/quotes/${yen.body.id}/send`, { exchangeRate: '0.0105' })
  // 100,000 yen at 0.0105 is 1,050.00 AUD.
  expect(withRate.body).toMatchObject({ currency: 'JPY', baseCurrency: 'AUD', exchangeRateToBase: '0.0105', totalBaseMinor: 105_000 })
})
