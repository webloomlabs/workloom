import { expect, test, type Page } from '@playwright/test'
import { linkFromEmail } from './mailpit.ts'

/**
 * S9 in one journey: an owner opens the dashboard and every card reads
 * correctly from real work, the period selector changes what it covers, and a
 * developer invited into the same organization opens the same page and finds no
 * money on it at all.
 */

const run = Date.now()
const owner = { name: 'Dash Owner', email: `dash+${run}@e2e.test`, password: 'dashboard-long-password' }
const developer = { name: 'Dash Dev', email: `dash-dev+${run}@e2e.test`, password: 'dashboard-dev-password' }

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

test('an owner sees every figure, and the period changes what it covers', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Dashboard ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }

  const today = new Date().toISOString().slice(0, 10)
  const company = await post('/api/v1/companies', { name: `Harbour ${run}` })
  const project = await post('/api/v1/projects', { name: `Harbour site ${run}`, companyId: company.id })
  await post('/api/v1/rates', { billableRateMinor: 150_00, costRateMinor: 60_00 })
  await post('/api/v1/time-entries', { projectId: project.id, durationSeconds: 10 * 3600, billable: true })
  await post('/api/v1/expenses', { description: 'Hosting', projectId: project.id, amountMinor: 200_00 })
  await post('/api/v1/tasks', { projectId: project.id, title: 'Wireframes', dueDate: today })
  await post('/api/v1/deals', { companyId: company.id, name: 'Retainer', valueMinor: 12_000_00, stage: 'proposal_sent' })
  await post('/api/v1/leads', { contactName: 'Grace Hopper', companyName: 'Navy', email: `grace+${run}@e2e.test` })

  const invoice = await post('/api/v1/invoices', {
    companyId: company.id,
    projectId: project.id,
    title: 'September',
    lines: [{ description: 'Design', unitAmountMinor: 1000_00 }],
  })
  await post(`/api/v1/invoices/${invoice.id}/send`, {})

  await page.goto('/')
  const money = page.getByLabel('Money in AUD')
  await expect(money).toContainText('Revenue$1,000.00')
  await expect(money).toContainText('Outstanding$1,000.00')
  await expect(money).toContainText('Expenses$200.00')
  // 1,000.00 billed, less 200.00 spent and ten hours at 60.00.
  await expect(money).toContainText('Estimated profit$200.00')

  // The delivery and sales cards, read inside their own region: their labels
  // are also the names of navigation links.
  const cards = page.getByLabel('Delivery and sales')
  await expect(cards).toContainText('Active projects1')
  await expect(cards).toContainText('Open tasks1')
  await expect(cards).toContainText('Pipeline$12,000.00')
  await expect(cards).toContainText('Leads1')

  // What falls due, and what has happened.
  await expect(page.getByRole('cell', { name: 'Wireframes' })).toBeVisible()
  await expect(page.getByText('Recent activity')).toBeVisible()
  await expect(page.getByText('invoice.sent').first()).toBeVisible()

  // The period changes the span, and the figures with it.
  await page.getByRole('link', { name: 'This year' }).click()
  await expect(page).toHaveURL(/period=year/)
  await expect(page.getByText(new RegExp(`^1 Jan`))).toBeVisible()
  await expect(page.getByLabel('Money in AUD')).toContainText('Revenue$1,000.00')
})

test('a developer opens the same page and finds no money on it', async ({ browser }) => {
  const ownerPage = await (await browser.newContext()).newPage()
  await signIn(ownerPage, owner)
  await ownerPage.goto('/settings/members')
  await ownerPage.getByLabel('Email').fill(developer.email)
  await ownerPage.getByLabel('Role').selectOption('developer')
  await ownerPage.getByRole('button', { name: 'Send invitation' }).click()
  await expect(ownerPage.getByText(`Invitation sent to ${developer.email}.`)).toBeVisible()

  const inviteLink = await linkFromEmail(developer.email, /invited you/, /https?:\/\/\S+accept-invitation\/\S+/)
  const invitePath = new URL(inviteLink).pathname
  const devPage = await (await browser.newContext()).newPage()
  await devPage.goto(invitePath)
  await devPage.getByRole('link', { name: 'Create account' }).click()
  await devPage.getByLabel('Your name').fill(developer.name)
  await devPage.getByLabel('Email').fill(developer.email)
  await devPage.getByLabel('Password').fill(developer.password)
  await devPage.getByRole('button', { name: 'Create account' }).click()

  const verifyLink = await linkFromEmail(developer.email, /Confirm your email/, /https?:\/\/\S+verify-email\S*/)
  await devPage.goto(verifyLink)
  await devPage.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(devPage).toHaveURL(/\/settings\/organization/)

  await devPage.goto('/')
  // Their work is there.
  await expect(devPage.getByRole('link', { name: /Open tasks/ })).toBeVisible()
  await expect(devPage.getByRole('cell', { name: 'Wireframes' })).toBeVisible()

  // The money is not, and neither is anything that would hint at it.
  await expect(devPage.getByLabel('Money in AUD')).toHaveCount(0)
  await expect(devPage.getByText('Recent activity')).toHaveCount(0)
  const devCards = devPage.getByLabel('Delivery and sales')
  await expect(devCards).not.toContainText('Pipeline')
  await expect(devCards).not.toContainText('Leads')
  await expect(devPage.locator('main')).not.toContainText('$')
})
