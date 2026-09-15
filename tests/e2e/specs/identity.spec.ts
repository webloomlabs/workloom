import { expect, test, type Page } from '@playwright/test'
import { linkFromEmail } from './mailpit.ts'

/**
 * S1 in one journey: an agency owner signs up, creates their organization,
 * invites a developer who joins through the emailed link, and issues an API
 * key that works against the public API.
 *
 * Addresses are unique per run so the suite can run repeatedly against a
 * long-lived development database.
 */

const run = Date.now()
const owner = { name: 'Olive Owner', email: `owner+${run}@e2e.test`, password: 'correct-horse-battery-staple' }
const developer = { name: 'Dev Eloper', email: `dev+${run}@e2e.test`, password: 'another-long-password-here' }
const orgName = `E2E Agency ${run}`

async function signUp(page: Page, person: typeof owner, next?: string) {
  await page.goto(next ? `/sign-up?next=${encodeURIComponent(next)}` : '/sign-up')
  await page.getByLabel('Your name').fill(person.name)
  await page.getByLabel('Email').fill(person.email)
  await page.getByLabel('Password').fill(person.password)
  await page.getByRole('button', { name: 'Create account' }).click()
}

/** Signs in and waits until the session is actually established. */
async function signIn(page: Page, person: typeof owner) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(person.email)
  await page.getByLabel('Password').fill(person.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Navigating on before this resolves races the session cookie and lands
  // back on the sign-in form.
  await expect(page).not.toHaveURL(/\/sign-in/)
}

test.describe.configure({ mode: 'serial' })

test('an owner signs up and creates their organization', async ({ page }) => {
  await signUp(page, owner)
  await expect(page).toHaveURL(/\/onboarding/)

  await page.getByLabel('Organization name').fill(orgName)
  await page.getByRole('button', { name: 'Create organization' }).click()

  await expect(page).toHaveURL(/\/settings\/organization/)
  await expect(page.getByLabel('Name')).toHaveValue(orgName)
})

test('the owner changes a setting, and it is audited', async ({ page }) => {
  await signIn(page, owner)
  // A single organization is selected automatically on sign-in, and home is
  // the sales pipeline for anyone who can see deals.
  await expect(page).toHaveURL(/\/pipeline/)
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  await page.getByLabel('Time zone').fill('Australia/Sydney')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Settings saved.')).toBeVisible()

  await page.getByLabel('Time zone').fill('Mars/Olympus_Mons')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Unknown time zone' }).first()).toBeVisible()

  await page.getByRole('link', { name: 'Audit log' }).click()
  await expect(page.getByText('organization.updated')).toBeVisible()
  await expect(page.getByText('timezone: UTC → Australia/Sydney')).toBeVisible()
})

test('a developer is invited, confirms their email, and joins with limited access', async ({ browser }) => {
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

  // Back on the invitation, which now refuses until the address is confirmed.
  await expect(devPage.getByRole('heading', { name: /Confirm your email/ })).toBeVisible()

  const verifyLink = await linkFromEmail(developer.email, /Confirm your email/, /https?:\/\/\S+verify-email\S*/)
  await devPage.goto(verifyLink)
  await expect(devPage).toHaveURL(new RegExp(invitePath))
  await devPage.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(devPage).toHaveURL(/\/settings\/organization/)

  // A developer sees the organization but not keys or the audit trail, and
  // cannot edit settings.
  await expect(devPage.getByRole('link', { name: 'API keys' })).toHaveCount(0)
  await expect(devPage.getByRole('link', { name: 'Audit log' })).toHaveCount(0)
  await expect(devPage.getByText('Only owners and admins can change these settings.')).toBeVisible()

  await ownerPage.reload()
  await expect(ownerPage.getByText(developer.email)).toBeVisible()
})

test('the owner issues a scoped API key that works exactly once as shown', async ({ page, request }) => {
  await signIn(page, owner)
  await page.goto('/settings/api-keys')

  await page.getByLabel('Name', { exact: true }).fill('n8n')
  await page.getByRole('checkbox').and(page.locator('[value="invoice:read"]')).check()
  await page.getByRole('button', { name: 'Create key' }).click()

  const secret = await page.getByLabel('API key').inputValue()
  expect(secret).toMatch(/^wl_live_/)

  const me = await request.get('/api/v1/me', { headers: { authorization: `Bearer ${secret}` } })
  expect(me.status()).toBe(200)
  const body = (await me.json()) as { permissions: string[]; organization: { name: string } }
  expect(body.organization.name).toBe(orgName)
  expect(body.permissions).toEqual(['invoice:read'])

  // Outside its scope.
  const keys = await request.get('/api/v1/api-keys', { headers: { authorization: `Bearer ${secret}` } })
  expect(keys.status()).toBe(403)

  // Gone after leaving the page: the list shows only a prefix.
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByText(secret)).toHaveCount(0)
  await expect(page.getByRole('cell', { name: 'n8n' })).toBeVisible()
})
