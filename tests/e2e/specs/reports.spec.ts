import { expect, test, type Page } from '@playwright/test'

/**
 * S8 in one journey: a project's profit and loss reads correctly from real
 * work, a rate change leaves it exactly where it was, and the reports page adds
 * the same money up over a period. Over the API, a key without financial
 * reporting is refused.
 */

const run = Date.now()
const owner = { name: 'Reports Owner', email: `reports+${run}@e2e.test`, password: 'reports-long-password' }

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

let projectId: string

test("a project's profit and loss adds up, and a rate change leaves it alone", async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Reports ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }

  const company = await post('/api/v1/companies', { name: `Harbour ${run}` })
  const project = await post('/api/v1/projects', { name: `Harbour site ${run}`, companyId: company.id, budgetMinor: 5000_00 })
  projectId = project.id
  await post('/api/v1/rates', { billableRateMinor: 150_00, costRateMinor: 60_00 })
  // Ten billable hours and two that nobody pays for.
  await post('/api/v1/time-entries', { projectId: project.id, durationSeconds: 10 * 3600, billable: true })
  await post('/api/v1/time-entries', { projectId: project.id, durationSeconds: 2 * 3600, billable: false })
  await post('/api/v1/expenses', { description: 'Stock photography', projectId: project.id, amountMinor: 200_00, billable: true, markupPercent: '25' })

  const invoice = await post('/api/v1/invoices', { companyId: company.id, projectId: project.id, title: 'March' })
  await post(`/api/v1/invoices/${invoice.id}/time`, { projectId: project.id })
  await post(`/api/v1/invoices/${invoice.id}/expenses`, {})
  await post(`/api/v1/invoices/${invoice.id}/send`, {})
  await post('/api/v1/payments', { companyId: company.id, amountMinor: 1000_00, allocations: [{ invoiceId: invoice.id, amountMinor: 1000_00 }] })

  await page.goto(`/projects/${project.id}?tab=financials`)
  const pnl = page.getByLabel('Profit and loss in AUD')
  // 10h at 150.00 plus the expense rebilled at 200.00 + 25%.
  await expect(pnl).toContainText('Billed, excluding tax$1,750.00')
  // Twelve hours at 60.00: unbillable time still costs.
  await expect(pnl).toContainText('Time-$720.00')
  await expect(pnl).toContainText('Expenses-$200.00')
  await expect(pnl).toContainText('Margin$830.00')

  const hours = page.getByLabel('Hours in AUD')
  await expect(hours).toContainText('Billable share83.33%')
  await expect(hours).toContainText('Earned per hour tracked$145.83')
  await expect(hours).toContainText('Still owed$750.00')
  await expect(hours).toContainText('18.4% spent')

  // The whole point of copying rates onto each entry: a raise today cannot
  // rewrite what last month's work was worth.
  await post('/api/v1/rates', { billableRateMinor: 300_00, costRateMinor: 120_00 })
  await page.goto(`/projects/${project.id}?tab=financials`)
  await expect(page.getByLabel('Profit and loss in AUD')).toContainText('Margin$830.00')
  await expect(page.getByLabel('Profit and loss in AUD')).toContainText('Time-$720.00')
})

test('the reports page adds the same money up over a period', async ({ page }) => {
  await signIn(page)
  await page.goto('/reports')

  const money = page.getByLabel('Money in AUD')
  await expect(money).toContainText('Billed$1,750.00')
  await expect(money).toContainText('Collected$1,000.00')
  await expect(money).toContainText('Outstanding$750.00')
  await expect(money).toContainText('Profit$830.00')
  await expect(money).toContainText('47.43% of what was billed')

  // Every figure landed in the month the thing it counts happened, which is
  // this one: the invoice was issued and paid today, and the work was today.
  const thisMonth = new Date().toISOString().slice(0, 7)
  await expect(page.getByRole('row', { name: new RegExp(`^${thisMonth}`) })).toContainText('$1,750.00')

  // The project, and its margin, one click from the money.
  const row = page.getByRole('row', { name: new RegExp(`Harbour site ${run}`) })
  await expect(row).toContainText('$830.00')
  await row.getByRole('link', { name: `Harbour site ${run}` }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=financials`))
})

test('an API key without financial reporting is refused', async ({ page, request }) => {
  await signIn(page)
  await page.goto('/settings/api-keys')
  await page.getByLabel('Name', { exact: true }).fill(`readonly ${run}`)
  await page.getByRole('checkbox').and(page.locator('[value="project:read"]')).check()
  await page.getByRole('button', { name: 'Create key' }).click()
  const secret = await page.getByLabel('API key').inputValue()

  const headers = { authorization: `Bearer ${secret}` }
  // It can read the project itself...
  expect((await request.get(`/api/v1/projects/${projectId}`, { headers })).status()).toBe(200)
  // ...but not what it earned.
  expect((await request.get(`/api/v1/projects/${projectId}/financials`, { headers })).status()).toBe(403)
  expect((await request.get('/api/v1/reports/revenue', { headers })).status()).toBe(403)
  expect((await request.get('/api/v1/reports/projects', { headers })).status()).toBe(403)
})

test('exports come out as CSV, under the same permission as reading them', async ({ page, request }) => {
  await signIn(page)
  await page.goto('/settings/api-keys')
  await page.getByLabel('Name', { exact: true }).fill(`exporter ${run}`)
  await page.getByRole('checkbox').and(page.locator('[value="project:read"]')).check()
  await page.getByRole('button', { name: 'Create key' }).click()
  const secret = await page.getByLabel('API key').inputValue()
  const headers = { authorization: `Bearer ${secret}` }

  const csv = await request.get('/api/v1/exports/projects.csv', { headers })
  expect(csv.status()).toBe(200)
  expect(csv.headers()['content-type']).toContain('text/csv')
  expect(csv.headers()['content-disposition']).toMatch(/^attachment; filename="workloom-projects-\d{4}-\d{2}-\d{2}\.csv"$/)

  const body = await csv.text()
  const [header, ...rows] = body.trim().split('\r\n')
  // The columns are a contract: a spreadsheet gets built on them.
  expect(header).toBe('id,name,companyId,companyName,status,startDate,dueDate,currency,budget,completedAt,createdAt')
  expect(rows.some((r) => r.includes(`Harbour site ${run}`))).toBe(true)

  // The same export as JSON, from the same URL without the suffix.
  const json = await request.get('/api/v1/exports/projects', { headers })
  expect(json.status()).toBe(200)
  expect((await json.json()).columns).toContain('budgetMinor')

  // And nothing this key was not given.
  expect((await request.get('/api/v1/exports/invoices.csv', { headers })).status()).toBe(403)
  expect((await request.get('/api/v1/exports/payments.csv', { headers })).status()).toBe(403)
  // Signing in is still required.
  expect((await request.get('/api/v1/exports/projects.csv')).status()).toBe(401)
})
