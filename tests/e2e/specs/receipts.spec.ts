import { expect, test } from '@playwright/test'

/**
 * S19 on the web: a receipt dropped on a new expense becomes a draft with the
 * photo attached, and Settings → Telegram is where the bot is connected and
 * receipt reading switched on. (The chat itself is covered against a fake
 * Telegram in packages/core/test/telegram.test.ts.)
 */

const run = Date.now()
const owner = { name: 'Receipt Owner', email: `receipts+${run}@e2e.test`, password: 'receipts-long-password' }
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF receipt ${run}`)])

test('a receipt becomes a draft expense, and the bot is set up in settings', async ({ page }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Receipts ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  await page.goto('/settings/telegram')
  await expect(page.getByLabel('Bot token')).toBeVisible()
  await page.getByLabel('Bot token').fill('not a token')
  await page.getByRole('button', { name: 'Connect the bot' }).click()
  await expect(page.getByText(/does not look like a bot token/).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Reading receipts' })).toBeVisible()

  await page.goto('/expenses/new')
  await page.getByLabel('Receipt', { exact: true }).setInputFiles({ name: 'taxi.jpg', mimeType: 'image/jpeg', buffer: JPEG })
  await page.getByLabel('Note (optional)').fill('Taxi to the client')
  await page.getByRole('button', { name: 'Start a draft from it' }).click()
  await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]+\?fromReceipt=1/)
  await expect(page.getByText('It does not count as a cost until it is confirmed.')).toBeVisible()
  await expect(page.getByRole('img', { name: /Receipt taxi\.jpg/ })).toBeVisible()
})
