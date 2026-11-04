import { expect, test } from '@playwright/test'

/** S16: a retainer client pays a quarter ahead, on one invoice. */

const run = Date.now()
const owner = { name: 'Retainer Owner', email: `prepay+${run}@e2e.test`, password: 'prepay-long-password' }

test('three months on one invoice, each month billed once', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Prepay ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  const company = await post('/api/v1/companies', { name: `Boutique ${run}` })
  const schedule = await post('/api/v1/billing-schedules', {
    companyId: company.id,
    name: 'Social media retainer',
    startOn: '2030-01-01',
    lines: [{ description: 'Social media management', unitAmountMinor: 40_000_00 }],
  })

  await page.goto(`/recurring/${schedule.id}`)
  await page.getByLabel('Periods').fill('3')
  await page.getByRole('button', { name: 'Raise the invoice' }).click()
  await expect(page).toHaveURL(/\/invoices\//)
  await expect(page.getByText('(3 periods)')).toBeVisible()
  await expect(page.getByLabel('Invoice totals')).toContainText('120,000.00')

  await page.goto(`/recurring/${schedule.id}`)
  await expect(page.getByText(/Next period starts 1 Apr|2030-04-01|01\/04\/2030/)).toBeVisible()
})
