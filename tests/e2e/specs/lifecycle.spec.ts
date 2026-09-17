import { expect, test } from '@playwright/test'

/**
 * MVP exit criterion 2, in one run and through the interface:
 *
 *   Create Lead → Convert to Client → Create Project → Create Invoice → Record Payment
 *
 * Every other spec proves one slice in depth. This one proves they join up:
 * that the thing an agency actually does from Monday to invoice day works
 * without dropping into the API once, and that what is recorded at each step is
 * still there at the next.
 */

const run = Date.now()
const owner = { name: 'Lifecycle Owner', email: `lifecycle+${run}@e2e.test`, password: 'lifecycle-long-password' }
const client = `Meridian ${run}`

test('a lead becomes a client, a project, an invoice, and a payment', async ({ page }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Lifecycle ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  // 1. An enquiry arrives.
  await page.getByRole('link', { name: 'Leads', exact: true }).click()
  await page.getByText('Add a lead').click()
  await page.getByLabel('Name', { exact: true }).fill('Priya Raman')
  await page.getByLabel('Company', { exact: true }).fill(client)
  await page.getByLabel('Email').fill(`priya+${run}@meridian.example`)
  await page.getByRole('button', { name: 'Add lead' }).click()
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/)

  await page.getByLabel('What happened').fill('Wants a new marketing site by March')
  await page.getByLabel('Type').selectOption('call')
  await page.getByRole('button', { name: 'Log' }).click()
  await expect(page.getByText('Wants a new marketing site by March')).toBeVisible()

  // 2. They are worth having, so they become a client.
  await page.getByRole('button', { name: 'Convert lead' }).click()
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/)
  const companyId = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByRole('heading', { name: client })).toBeVisible()
  await expect(page.getByText('Client', { exact: true })).toBeVisible()
  // The call survives the conversion: history is the point of not re-parenting.
  await expect(page.getByText('Wants a new marketing site by March')).toBeVisible()

  // 3. The work is set up, and someone does some of it.
  const projectName = `Marketing site ${run}`
  await page.goto('/projects/new')
  await page.getByLabel('Project name').fill(projectName)
  await page.getByLabel('Client').selectOption(companyId)
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/)
  const projectId = new URL(page.url()).pathname.split('/').pop()!

  await page.goto('/settings/rates')
  const rates = page.getByRole('row', { name: /Organization default/ })
  await rates.getByLabel('Billable rate for Organization default').fill('150')
  await rates.getByLabel('Cost rate for Organization default').fill('60')
  await rates.getByRole('button', { name: 'Save' }).click()
  await expect(rates.getByRole('status')).toHaveText('Saved')

  await page.goto(`/projects/${projectId}?tab=time`)
  const logTime = page.locator('form', { has: page.getByRole('button', { name: 'Log time' }) })
  await logTime.getByLabel('Project or task').selectOption({ label: `${projectName} (no task)` })
  await logTime.getByLabel('Time', { exact: true }).fill('8:00')
  await logTime.getByRole('button', { name: 'Log time' }).click()
  await expect(page.getByText('$1,200.00').first()).toBeVisible()

  // 4. The work is invoiced, at the rate it was logged at.
  await page.goto(`/invoices/new?companyId=${companyId}`)
  await page.getByLabel('Title').fill('Marketing site, phase one')
  await page.getByRole('button', { name: 'Create draft' }).click()
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/)
  const invoiceUrl = page.url()

  await page.locator('form', { has: page.getByRole('button', { name: 'Add unbilled time' }) })
    .getByRole('button', { name: 'Add unbilled time' })
    .click()
  const totals = page.getByLabel('Invoice totals')
  await expect(totals).toContainText('Total$1,200.00')

  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('form', { has: page.getByRole('button', { name: 'Issue invoice' }) })
    .getByRole('button', { name: 'Issue invoice' })
    .click()
  await expect(page.getByText('INV-0001', { exact: true })).toBeVisible()

  // 5. The client pays.
  const record = page.locator('form', { has: page.getByRole('button', { name: 'Record it' }) })
  await expect(record.getByLabel(/^Amount/)).toHaveValue('1200.00')
  await record.getByLabel('Reference').fill('TRF-LIFECYCLE')
  await record.getByRole('button', { name: 'Record it' }).click()
  await expect(totals).toContainText('Amount due$0.00')
  await expect(page.getByRole('button', { name: 'Record it' })).toHaveCount(0)

  // And the whole of it shows up where an agency would look for it.
  await page.goto('/')
  const money = page.getByLabel('Money in AUD')
  await expect(money).toContainText('Revenue$1,200.00')
  await expect(money).toContainText('Outstanding$0.00')
  // 1,200.00 billed less eight hours at 60.00.
  await expect(money).toContainText('Estimated profit$720.00')

  await page.goto(`/projects/${projectId}?tab=financials`)
  await expect(page.getByLabel('Profit and loss in AUD')).toContainText('Margin$720.00')

  await page.goto(invoiceUrl)
  await expect(page.getByRole('cell', { name: 'TRF-LIFECYCLE' })).toBeVisible()
})
