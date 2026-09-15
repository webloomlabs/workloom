import { expect, test, type Page } from '@playwright/test'

/**
 * S6 in one journey: rates are set, a timer runs from a task and shows in the
 * header until stopped, time is logged by hand and corrected on the
 * timesheet, and the project adds it up at the rates it was logged at. Over
 * the API, starting a second timer stops the first, and changing a rate
 * leaves logged time alone.
 */

const run = Date.now()
const owner = { name: 'Time Owner', email: `time+${run}@e2e.test`, password: 'time-long-password' }
const projectName = `Retainer ${run}`

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

test('time is tracked, corrected, and valued at the rates it was logged at', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Time ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  const company = await post('/api/v1/companies', { name: `Harbour ${run}` })
  const project = await post('/api/v1/projects', { name: projectName, companyId: company.id })
  const task = await post('/api/v1/tasks', { projectId: project.id, title: 'Wireframes' })

  // Rates, before any time exists.
  await page.goto('/settings/rates')
  const organizationRow = page.getByRole('row', { name: /Organization default/ })
  await organizationRow.getByLabel('Billable rate for Organization default').fill('150')
  await organizationRow.getByLabel('Cost rate for Organization default').fill('60')
  await organizationRow.getByRole('button', { name: 'Save' }).click()
  await expect(organizationRow.getByRole('status')).toHaveText('Saved')

  // A timer from the task, visible in the header on every page until stopped.
  await page.goto(`/projects/${project.id}/tasks/${task.id}`)
  await page.getByLabel('What are you working on?').fill('Timer run')
  await page.getByRole('button', { name: 'Start timer' }).click()
  const timer = page.getByRole('status', { name: 'Running timer' })
  await expect(timer).toContainText('Wireframes')
  await expect(timer).toContainText(/\d:\d\d:\d\d/)
  await page.goto('/time')
  await expect(timer).toBeVisible()
  await timer.getByRole('button', { name: 'Stop' }).click()
  await expect(timer).toHaveCount(0)

  // Logged by hand on the timesheet.
  const logForm = page.locator('form', { has: page.getByRole('button', { name: 'Log time' }) })
  await logForm.getByLabel('Project or task').selectOption({ label: 'Wireframes' })
  await logForm.getByLabel('Time', { exact: true }).fill('1:30')
  await logForm.getByLabel('Notes').fill('Wireframe sketches')
  await logForm.getByRole('button', { name: 'Log time' }).click()
  await expect(page.getByLabel('Week total')).toHaveText('1:30')
  await expect(page.getByRole('row', { name: new RegExp(`${projectName} · Wireframes`) })).toContainText('1:30')

  // Corrected: an hour and a half becomes two.
  const manual = page.getByRole('listitem').filter({ hasText: 'Wireframe sketches' })
  await manual.getByRole('button', { name: 'Edit' }).click()
  await manual.getByLabel('Time', { exact: true }).fill('2h')
  await manual.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByLabel('Week total')).toHaveText('2:00')

  // The timer's few seconds, discarded.
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('listitem').filter({ hasText: 'Timer run' }).getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Timer run' })).toHaveCount(0)

  // The project adds it up: 2h at 150.00 billed, at 60.00 cost.
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: /Time/ }).click()
  await expect(page).toHaveURL(/tab=time/)
  await expect(page.getByText('$300.00').first()).toBeVisible()
  await expect(page.getByText('$120.00').first()).toBeVisible()
  // The by-person table comes first; recent entries name the person too.
  await expect(page.getByRole('row', { name: new RegExp(owner.name) }).first()).toContainText('2:00')
})

test('over the API, a person has one clock and logged time keeps its rates', async ({ page, baseURL }) => {
  await signIn(page)
  const headers = { origin: baseURL! }
  const post = async (path: string, data: unknown, status = 201) => {
    const response = await page.request.post(path, { headers, data })
    expect(response.status(), await response.text()).toBe(status)
    return response.json()
  }

  const project = await post('/api/v1/projects', { name: `API time ${run}` })
  const task = await post('/api/v1/tasks', { projectId: project.id, title: 'Build' })

  const first = await post('/api/v1/timer', { projectId: project.id })
  const second = await post('/api/v1/timer', { taskId: task.id })
  expect(second.stopped.id).toBe(first.entry.id)
  expect((await (await page.request.get('/api/v1/timer')).json()).entry.id).toBe(second.entry.id)
  const stopped = await post('/api/v1/timer/stop', {}, 200)
  expect(stopped).toMatchObject({ id: second.entry.id, running: false })
  expect((await post('/api/v1/timer/stop', {}, 422)).error.code).toBe('no_running_timer')

  // Rates are copied when time is logged.
  await post('/api/v1/rates', { billableRateMinor: 100_00, costRateMinor: 50_00 }, 200)
  const logged = await post('/api/v1/time-entries', { taskId: task.id, durationSeconds: 3600 })
  expect(logged).toMatchObject({ billableRateMinor: 100_00, billableRateSource: 'organization', projectId: project.id })
  await post('/api/v1/rates', { billableRateMinor: 200_00, costRateMinor: 80_00 }, 200)
  expect(await (await page.request.get(`/api/v1/time-entries/${logged.id}`)).json()).toMatchObject({ billableRateMinor: 100_00, costRateMinor: 50_00 })

  // A task with time on it stays.
  const refused = await page.request.delete(`/api/v1/tasks/${task.id}`, { headers })
  expect(refused.status()).toBe(422)
  expect((await refused.json()).error.code).toBe('task_has_time')

  // Internal project, so not billable by default; cost still counts.
  const summary = await (await page.request.get(`/api/v1/projects/${project.id}/time`)).json()
  expect(summary.totals).toMatchObject({ billableSeconds: 0, costMinor: expect.any(Number) })
  expect(summary.totals.seconds).toBeGreaterThanOrEqual(3600)
})
