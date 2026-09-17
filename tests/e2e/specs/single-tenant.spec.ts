import { expect, test, type Page } from '@playwright/test'

/**
 * The single-tenant journey, which is the default shape of an installation.
 *
 * A stranger opens a fresh instance and is met by setup rather than sign-up.
 * They become the administrator, the setup screen closes behind them, and the
 * only way anyone else gets an account is by being added from Settings.
 *
 * This runs against an instance with MULTI_TENANT unset and an empty database,
 * so it is tagged and selected by E2E_SINGLE_TENANT -- see playwright.config.
 * Setup happens once per database, which is also why these tests are serial:
 * the first one is a precondition of the rest.
 */

const admin = { name: 'Ada Admin', email: 'admin@single.test', password: 'correct-horse-battery-staple' }
const developer = { name: 'Dev Eloper', email: 'dev@single.test', password: 'another-long-password-here' }
const orgName = 'Single Tenant Agency'

async function signIn(page: Page, person: typeof admin) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(person.email)
  await page.getByLabel('Password').fill(person.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

test.describe('@single-tenant', () => {
  test.describe.configure({ mode: 'serial' })

  test('a fresh instance sends every visitor to setup', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/setup/)

    // Including the routes that would otherwise let someone in or around it.
    await page.goto('/sign-in')
    await expect(page).toHaveURL(/\/setup/)
    await page.goto('/sign-up')
    await expect(page).toHaveURL(/\/setup/)
  })

  test('setup creates the administrator and the organization, then signs them in', async ({ page }) => {
    await page.goto('/setup')
    await page.getByLabel('Organization name').fill(orgName)
    await page.getByLabel('Your name').fill(admin.name)
    await page.getByLabel('Email').fill(admin.email)
    await page.getByLabel('Password').fill(admin.password)
    await page.getByRole('button', { name: 'Create administrator' }).click()

    // Straight into the product -- no organization picker, and no email to
    // confirm, because an administrator vouched for the address.
    await expect(page).toHaveURL(new RegExp(`^${process.env.E2E_BASE_URL ?? 'http://localhost:3000'}/?$`))
    await expect(page.getByText(/Confirm your email address/)).toHaveCount(0)

    await page.goto('/settings/organization')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(orgName)
  })

  test('setup closes behind them, and sign-up stays shut', async ({ browser, request }) => {
    const stranger = await (await browser.newContext()).newPage()

    await stranger.goto('/setup')
    await expect(stranger).toHaveURL(/\/sign-in/)

    await stranger.goto('/sign-up')
    await expect(stranger).toHaveURL(/\/sign-in/)
    // Nothing on the sign-in page offers a way to make an account.
    await expect(stranger.getByRole('link', { name: 'Create an account' })).toHaveCount(0)

    // And the endpoint behind the form is closed, not merely unlinked.
    const response = await request.post('/api/auth/sign-up/email', {
      data: { name: 'Mal Actor', email: 'mal@single.test', password: 'a-perfectly-long-password' },
      failOnStatusCode: false,
    })
    expect(response.ok()).toBe(false)
  })

  test('the administrator adds a member, who signs in with the password they were given', async ({ browser }) => {
    const adminPage = await (await browser.newContext()).newPage()
    await signIn(adminPage, admin)
    await adminPage.goto('/settings/members')

    // No invitation form here: there would be no sign-up for an invitee to
    // complete.
    await expect(adminPage.getByRole('button', { name: 'Send invitation' })).toHaveCount(0)

    await adminPage.getByLabel('Name', { exact: true }).fill(developer.name)
    await adminPage.getByLabel('Email').fill(developer.email)
    await adminPage.getByLabel('Role').selectOption('developer')
    await adminPage.getByLabel('Initial password').fill(developer.password)
    await adminPage.getByRole('button', { name: 'Add member' }).click()
    await expect(adminPage.getByText(`${developer.name} can now sign in as ${developer.email}.`)).toBeVisible()

    const devPage = await (await browser.newContext()).newPage()
    await signIn(devPage, developer)

    // In the organization immediately, with a developer's access and nothing
    // more -- and no organization switcher, because there is only one.
    await devPage.goto('/settings/organization')
    await expect(devPage.getByText('Only owners and admins can change these settings.')).toBeVisible()
    await expect(devPage.getByRole('link', { name: 'API keys' })).toHaveCount(0)
    await expect(devPage.getByLabel('Organization', { exact: true })).toHaveCount(0)
  })

  test('joining is audited the same way an accepted invitation is', async ({ page }) => {
    await signIn(page, admin)
    await page.goto('/settings/audit-log')
    await expect(page.getByText('organization.created')).toBeVisible()
    await expect(page.getByText('member.joined')).toBeVisible()
  })
})
