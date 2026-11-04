import { expect, test } from '@playwright/test'

/**
 * S18 in one journey: two alternative quotes go out, the client takes one,
 * and accepting it starts the project, sets its contract, pauses the care
 * plan until launch, and plans a deposit and a balance. An extra piece of
 * scope is quoted and added on top. The deposit is billed and paid; the
 * balance is billed as a statement -- the whole scope, the deposit taken off.
 */

const run = Date.now()
const owner = { name: 'Quote Owner', email: `quote-statement+${run}@e2e.test`, password: 'quote-statement-long-password' }

test('an accepted quote becomes the project, its contract, and a statement final invoice', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Webloom quotes ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)
  await page.getByLabel('Base currency').fill('LKR')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible()

  const send = async (method: 'get' | 'post' | 'patch', path: string, data?: unknown) => {
    const response = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }

  // Two ways to do the job, offered side by side.
  const company = await send('post', '/api/v1/companies', { name: `Kyla & Co. ${run}` })
  const optionA = await send('post', '/api/v1/quotes', {
    companyId: company.id,
    title: 'Kyla & Co. store development',
    lines: [
      { description: 'Store development', detail: 'Design, build, and launch', unitAmountMinor: 65_000_00 },
      { description: 'Hosting and care', billingType: 'recurring', intervalUnit: 'month', unitAmountMinor: 5_000_00 },
    ],
  })
  const optionB = await send('post', `/api/v1/quotes/${optionA.id}/duplicate`, { asOption: true, optionLabel: 'Option B' })
  expect(optionB.optionGroupId).toBeTruthy()
  await send('post', `/api/v1/quotes/${optionA.id}/send`, {})
  await send('post', `/api/v1/quotes/${optionB.id}/send`, {})

  const quotePdf = await page.request.get(`/quotes/${optionA.id}/pdf`)
  expect(quotePdf.ok()).toBe(true)
  expect((await quotePdf.body()).subarray(0, 5).toString()).toBe('%PDF-')

  // The client takes option A: a new project, a deposit, and the balance at launch.
  await page.goto(`/quotes/${optionA.id}`)
  await page.getByLabel('The project it is for').selectOption('new')
  await page.getByLabel('Project name').fill(`Kyla store ${run}`)
  await expect(page.getByText(/Sets the contract value to 65,000\.00/)).toBeVisible()
  await expect(page.getByText(/billing schedule of .*5,000\.00/)).toBeVisible()
  await page.getByLabel('Billing plan').selectOption('deposit_balance')
  await page.getByLabel(/^Deposit/).fill('26,000.00')
  await page.getByRole('button', { name: 'Accept the quote' }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\?tab=billing/)
  const projectId = new URL(page.url()).pathname.split('/')[2]!

  // The other option is declined; the care plan waits, paused, for launch.
  expect((await send('get', `/api/v1/quotes/${optionB.id}`)).status).toBe('declined')
  const schedules = await send('get', `/api/v1/billing-schedules?companyId=${company.id}`)
  expect(schedules.data.map((s: { status: string }) => s.status)).toEqual(['paused'])

  // More scope, quoted and accepted on top of the contract.
  const extra = await send('post', '/api/v1/quotes', {
    companyId: company.id,
    projectId,
    title: 'Gift vouchers',
    lines: [{ description: 'Gift vouchers and store credits', unitAmountMinor: 15_000_00 }],
  })
  await send('post', `/api/v1/quotes/${extra.id}/send`, {})
  const added = await send('post', `/api/v1/quotes/${extra.id}/accept`, {})
  expect(added.applied).toMatchObject({ projectId, contract: 'revision' })

  // The deposit is billed, issued, and paid.
  const plan = await send('get', `/api/v1/projects/${projectId}/billing-stages`)
  expect(plan.contractedValueMinor).toBe(80_000_00)
  const stages = plan.stages as Array<{ id: string; name: string; resolvedAmountMinor: number }>
  expect(stages.map((s) => [s.name, s.resolvedAmountMinor])).toEqual([
    ['Deposit', 26_000_00],
    ['Balance at launch', 54_000_00],
  ])
  const { invoiceId: depositId } = await send('post', `/api/v1/billing-stages/${stages[0]!.id}/release`, {})
  const deposit = await send('post', `/api/v1/invoices/${depositId}/send`, {})
  await send('post', '/api/v1/payments', { companyId: company.id, amountMinor: 26_000_00, allocations: [{ invoiceId: depositId }] })

  // The balance, as a statement of the whole job.
  await page.goto(`/projects/${projectId}?tab=billing`)
  await page.getByRole('button', { name: /^Bill .*54,000\.00/ }).click()
  await expect(page).toHaveURL(/\/invoices\//)
  await expect(page.getByText('Initially quoted project fee')).toBeVisible()
  await expect(page.getByText('Additional scope')).toBeVisible()
  await expect(page.getByLabel('Invoice totals')).toContainText('80,000.00')
  await expect(page.getByLabel('Invoice totals')).toContainText('54,000.00')

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Issue invoice' }).click()
  await expect(page.getByLabel('Invoice totals')).toContainText(`Already paid (${deposit.number})`)
  await expect(page.getByText(/due at launch/i)).toBeVisible()

  const finalId = new URL(page.url()).pathname.split('/')[2]!
  const pdf = await page.request.get(`/invoices/${finalId}/pdf`)
  expect(pdf.ok()).toBe(true)
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-')
})
