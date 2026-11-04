import { expect, test } from '@playwright/test'

/**
 * S15 in one journey: an expense recorded from the receipt's total, with the
 * receipt attached and previewed; a draft that counts for nothing until it is
 * confirmed; and a category of the agency's own.
 */

const run = Date.now()
const owner = { name: 'Expense Owner', email: `expenses+${run}@e2e.test`, password: 'expenses-long-password' }
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF receipt ${run}`)])

test('a receipt becomes a numbered expense, and a draft waits to be confirmed', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Expenses ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  // A category of the agency's own.
  await page.goto('/settings/expense-categories')
  await page.getByLabel('New category').fill('Meta ads')
  await page.getByRole('button', { name: 'Add category' }).click()
  await expect(page.getByRole('cell', { name: /Meta ads/ })).toBeVisible()

  // Recorded from the receipt, with the photo attached.
  await page.goto('/expenses/new')
  await page.getByLabel('What was it').fill('Boosted post')
  await page.getByLabel(/^Amount/).fill('3000')
  await page.getByLabel('Category').selectOption('meta_ads')
  await page.getByLabel('Receipts').setInputFiles({ name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: JPEG })
  await page.getByRole('button', { name: 'Record expense' }).click()
  await expect(page).toHaveURL(/\/expenses$/)
  const row = page.getByRole('row').filter({ hasText: 'Boosted post' })
  await expect(row).toContainText(/EXP-\d{4}/)
  await expect(row).toContainText('1 receipt')

  await row.getByRole('link', { name: 'Boosted post' }).click()
  await expect(page.getByRole('img', { name: /Receipt receipt\.jpg/ })).toBeVisible()

  // A draft, as the Telegram bot would leave one.
  const draft = await page.request.post('/api/v1/expenses', { data: { description: 'Fuel', amountMinor: 5_000_00, status: 'draft' }, headers: { origin: baseURL! } })
  expect(draft.ok(), await draft.text()).toBe(true)
  const { id } = await draft.json()
  await page.goto('/expenses?view=drafts')
  await expect(page.getByRole('row').filter({ hasText: 'Fuel' })).toContainText('Draft')
  await page.goto(`/expenses/${id}`)
  await expect(page.getByText('It does not count as a cost until it is confirmed.')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm expense' }).click()
  await expect(page.getByText(/EXP-\d{4}/).first()).toBeVisible()
})
