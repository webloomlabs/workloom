import { expect, test } from '@playwright/test'

/**
 * S14 in one journey: the agency sets up how its invoices look and are
 * numbered, raises a deposit, and then a final invoice that states the whole
 * project and takes the paid deposit off it -- due "At launch".
 */

const run = Date.now()
const owner = { name: 'Statement Owner', email: `statements+${run}@e2e.test`, password: 'statements-long-password' }
/** A real 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test('a final invoice states the project, takes the deposit off, and is due at launch', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Webloom ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const send = async (method: 'post' | 'patch', path: string, data: unknown) => {
    const response = await page.request[method](path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }

  // Branding and bank details, in the settings form.
  await page.getByLabel('Base currency').fill('LKR')
  await page.getByLabel('Legal name').fill('Webloom Labs (Pvt) Ltd')
  await page.getByLabel('Financial year starts in').selectOption('4')
  await page.getByLabel('Date format').selectOption('D MMMM YYYY')
  await page.getByLabel('Detail 2 value').fill('93389900')
  await page.getByLabel('Footer').fill('This is a computer-generated invoice and is valid without a signature.')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible()

  await page.getByLabel('Logo file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG })
  await page.getByRole('button', { name: 'Upload' }).click()
  await expect(page.getByRole('img', { name: 'Your logo' })).toBeVisible()

  // Numbering: the agency's format, starting where its old system stopped.
  await page.goto('/settings/numbering')
  const invoices = page.locator('form').filter({ has: page.locator('input[name="kind"][value="invoice"]') })
  await invoices.getByLabel('Format').fill('WL-{YYYY}-{NNNN}')
  await invoices.getByLabel('Start again from 1').selectOption('yearly')
  await invoices.getByLabel('Next number').fill('143')
  await invoices.getByRole('button', { name: 'Save numbering' }).click()
  await expect(page.getByText(/The next invoice will be WL-\d{4}-0143/)).toBeVisible()

  // A deposit, issued and paid.
  const company = await send('post', '/api/v1/companies', { name: `Kyla & Co. ${run}`, website: 'https://kylaandcoclothing.com' })
  const deposit = await send('post', '/api/v1/invoices', { companyId: company.id, title: 'Store development — deposit', lines: [{ description: 'Deposit', unitAmountMinor: 26_000_00 }] })
  const issued = await send('post', `/api/v1/invoices/${deposit.id}/send`, {})
  expect(issued.number).toMatch(/^WL-\d{4}-0143$/)
  await send('post', '/api/v1/payments', { companyId: company.id, amountMinor: 26_000_00, allocations: [{ invoiceId: deposit.id }] })

  // The final invoice: the whole project, due at launch.
  const final = await send('post', '/api/v1/invoices', {
    companyId: company.id,
    title: 'Kyla & Co. store development',
    dueLabel: 'At launch',
    lines: [
      { description: 'Kyla & Co. store development', detail: 'Initially quoted project fee', billingType: 'one_off', unitAmountMinor: 65_000_00 },
      { description: 'Gift vouchers and store credits', detail: 'Additional scope', billingType: 'one_off', unitAmountMinor: 15_000_00 },
    ],
  })

  await page.goto(`/invoices/${final.id}`)
  await expect(page.getByText('Initially quoted project fee')).toBeVisible()
  await page.getByLabel('Invoice to take off').selectOption(deposit.id)
  await page.getByRole('button', { name: 'Take it off this invoice' }).click()
  await expect(page.getByText('Project total')).toBeVisible()
  await expect(page.getByLabel('Invoice totals')).toContainText('54,000.00')

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Issue invoice' }).click()
  await expect(page.getByText(/WL-\d{4}-0144/).first()).toBeVisible()
  await expect(page.getByText(/due at launch/i)).toBeVisible()
  await expect(page.getByLabel('Invoice totals')).toContainText(`Already paid (${issued.number})`)

  const pdf = await page.request.get(`/invoices/${final.id}/pdf`)
  expect(pdf.ok()).toBe(true)
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-')

  // Launch happens: the invoice gets its date, once.
  await page.getByLabel(/Due date \(was "At launch"\)/).fill('2099-01-31')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Set due date' }).click()
  await expect(page.getByText(/due 31/i)).toBeVisible()
})
