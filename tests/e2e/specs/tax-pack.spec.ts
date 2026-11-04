import { expect, test } from '@playwright/test'

/**
 * S20 on the web: the year's figures and what to fix, asking for the income
 * tax pack, and the audit log's filters and export. (Building the zip is the
 * worker's job; packages/core/test/books.test.ts unzips one.)
 */

const run = Date.now()
const owner = { name: 'Tax Owner', email: `tax-pack+${run}@e2e.test`, password: 'tax-pack-long-password' }

test('the year is summed up, its pack asked for, and the audit log exported', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Tax ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)
  await page.getByLabel('Base currency').fill('LKR')
  await page.getByLabel('Financial year starts in').selectOption('4')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible()

  const send = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  const company = await send('/api/v1/companies', { name: `Kyla & Co. ${run}` })
  const invoice = await send('/api/v1/invoices', { companyId: company.id, title: 'Store build', lines: [{ description: 'Store build', unitAmountMinor: 80_000_00 }] })
  await send(`/api/v1/invoices/${invoice.id}/send`, {})

  const books = await (await page.request.get('/api/v1/books')).json()
  await page.goto(`/reports/tax?year=${books.currentYear.startYear}`)
  await expect(page.getByRole('heading', { name: `Year of assessment ${books.currentYear.label}` })).toBeVisible()
  await expect(page.getByLabel("The year's figures")).toContainText('80,000.00')
  await expect(page.getByText(/not locked through/)).toBeVisible()

  await page.getByRole('button', { name: `Make the ${books.currentYear.label} pack` }).click()
  await expect(page.getByText(/pack is being made/)).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: books.currentYear.label })).toBeVisible()

  await page.goto('/settings/audit-log?action=invoice.')
  await expect(page.getByRole('cell', { name: 'invoice.sent' })).toBeVisible()
  const csv = await page.request.get('/settings/audit-log/export?action=invoice.')
  expect(csv.headers()['content-type']).toContain('text/csv')
  expect(await csv.text()).toContain('invoice.sent')
})
