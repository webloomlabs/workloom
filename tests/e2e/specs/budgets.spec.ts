import { expect, test } from '@playwright/test'

/** S17: a retainer past 80% of its month shows on the project and the dashboard. */

const run = Date.now()
const owner = { name: 'Budget Owner', email: `budgets+${run}@e2e.test`, password: 'budgets-long-password' }

test('a retainer near its monthly budget is flagged where a manager looks', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Budgets ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  const types = await (await page.request.get('/api/v1/project-types')).json()
  const marketing = types.data.find((t: { name: string }) => t.name === 'Digital marketing')
  const company = await post('/api/v1/companies', { name: `Boutique ${run}` })
  await post('/api/v1/rates', { billableRateMinor: 5_000_00, costRateMinor: 2_000_00 })
  const project = await post('/api/v1/projects', { name: `Social ${run}`, companyId: company.id, projectTypeId: marketing.id, budgetMinor: 10_000_00 })
  expect(project.billingModel).toBe('retainer')
  await post('/api/v1/time-entries', { projectId: project.id, durationSeconds: 4 * 3600 })

  await page.goto(`/projects/${project.id}?tab=financials`)
  await expect(page.getByText('Past 80% of the budget')).toBeVisible()
  await page.goto('/')
  await expect(page.getByRole('link', { name: `Social ${run}` })).toBeVisible()
})
