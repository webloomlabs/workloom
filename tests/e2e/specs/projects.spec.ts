import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

/**
 * S5 in one journey: a won deal becomes a project; milestones and tasks are
 * planned; a dependency holds a task open until the work before it is done; a
 * file is attached and downloads byte for byte; the same works over the API,
 * which refuses a dependency loop.
 */

const run = Date.now()
const owner = { name: 'Project Owner', email: `projects+${run}@e2e.test`, password: 'projects-long-password' }
const projectName = `Harbour rebuild ${run}`
const fileBytes = Buffer.from(`Brief for ${run}\néè \x00\x01 binary-safe`)

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/sign-in/)
}

test('a won deal becomes a project, planned, worked, and completed', async ({ page, baseURL }) => {
  await page.goto('/sign-up')
  await page.getByLabel('Your name').fill(owner.name)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Organization name').fill(`Projects ${run}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(/\/settings\/organization/)

  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  const company = await post('/api/v1/companies', { name: `Harbour ${run}` })
  const deal = await post('/api/v1/deals', { companyId: company.id, name: 'Site rebuild', valueMinor: 2_000_000 })
  await post(`/api/v1/deals/${deal.id}/stage`, { stage: 'won' })

  // From the won deal.
  await page.goto(`/deals/${deal.id}`)
  await page.getByRole('link', { name: 'Start the project' }).click()
  await page.getByLabel('Project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible()
  await expect(page.getByRole('link', { name: `Harbour ${run}` })).toBeVisible()
  const projectUrl = page.url()
  const sections = page.getByRole('navigation', { name: 'Project sections' })

  await sections.getByRole('link', { name: /Milestones/ }).click()
  await expect(page).toHaveURL(/tab=milestones/)
  await page.getByLabel('Milestone', { exact: true }).fill('Design sign-off')
  await page.getByRole('button', { name: 'Add milestone' }).click()
  await expect(page.getByRole('cell', { name: 'Design sign-off' })).toBeVisible()

  await sections.getByRole('link', { name: /Tasks/ }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/)
  for (const title of ['Wireframes', 'Build pages']) {
    await page.getByLabel('New task').fill(title)
    await page.getByLabel('Milestone', { exact: true }).selectOption({ label: 'Design sign-off' })
    await page.getByRole('button', { name: 'Add task' }).click()
    await expect(page.getByRole('link', { name: title })).toBeVisible()
  }

  // Build pages waits on Wireframes.
  await page.getByRole('link', { name: 'Build pages' }).click()
  await expect(page).toHaveURL(/\/tasks\//)
  await page.getByLabel('Waits on').selectOption({ label: 'Wireframes' })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('Waiting on 1 task.', { exact: false })).toBeVisible()

  await page.getByLabel('Status').first().selectOption('done')
  await expect(page.getByRole('alert').filter({ hasText: /waiting on 1 other task/i })).toBeVisible()

  await page.getByLabel('Add a comment…').fill('Blocked until wireframes are approved')
  await page.getByRole('button', { name: 'Post' }).click()
  await expect(page.getByText('Blocked until wireframes are approved')).toBeVisible()

  await page.locator('input[type="file"]').setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: fileBytes })
  await page.getByRole('button', { name: 'Upload' }).click()
  const fileLink = page.getByRole('link', { name: 'brief.txt' })
  await expect(fileLink).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), fileLink.click()])
  expect(download.suggestedFilename()).toBe('brief.txt')
  expect(Buffer.compare(await readFile((await download.path())!), fileBytes)).toBe(0)

  // Finish the work in order.
  await page.goto(projectUrl)
  const wireframes = page.getByRole('region', { name: /To do/ }).locator('div', { has: page.getByRole('link', { name: 'Wireframes' }) }).last()
  await wireframes.getByLabel('Status').selectOption('done')
  await expect(page.getByRole('region', { name: /Done/ }).getByRole('link', { name: 'Wireframes' })).toBeVisible()

  await page.getByRole('link', { name: 'Build pages' }).click()
  await expect(page).toHaveURL(/\/tasks\//)
  // Now unblocked: the status change goes through.
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/tasks/')),
    page.getByLabel('Status').first().selectOption('done'),
  ])
  await expect(page.getByText('Waiting on 1 task.', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('alert').filter({ hasText: /waiting on/i })).toHaveCount(0)
  await page.goto(projectUrl)
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

  // The client's page shows the project.
  await page.goto(`/companies/${company.id}?tab=projects`)
  await expect(page.getByRole('link', { name: projectName })).toBeVisible()
})

test('the API plans work, refuses dependency loops, and round-trips files', async ({ page, baseURL }) => {
  await signIn(page)
  const headers = { origin: baseURL! }

  const project = await (await page.request.post('/api/v1/projects', { headers, data: { name: `API project ${run}` } })).json()
  const create = async (title: string) =>
    (await (await page.request.post('/api/v1/tasks', { headers, data: { projectId: project.id, title } })).json()) as { id: string }
  const [a, b, c] = [await create('A'), await create('B'), await create('C')]

  expect((await page.request.post(`/api/v1/tasks/${b.id}/dependencies`, { headers, data: { dependsOnTaskId: a.id } })).status()).toBe(201)
  expect((await page.request.post(`/api/v1/tasks/${c.id}/dependencies`, { headers, data: { dependsOnTaskId: b.id } })).status()).toBe(201)
  const loop = await page.request.post(`/api/v1/tasks/${a.id}/dependencies`, { headers, data: { dependsOnTaskId: c.id } })
  expect(loop.status()).toBe(422)
  expect((await loop.json()).error.code).toBe('dependency_cycle')

  const uploaded = await page.request.post('/api/v1/attachments', {
    headers,
    multipart: { projectId: project.id, file: { name: 'api.bin', mimeType: 'application/octet-stream', buffer: fileBytes } },
  })
  expect(uploaded.status(), await uploaded.text()).toBe(201)
  const attachment = await uploaded.json()
  expect(attachment).toMatchObject({ filename: 'api.bin', sizeBytes: fileBytes.length })

  const { url } = await (await page.request.get(`/api/v1/attachments/${attachment.id}/download`)).json()
  const file = await page.request.get(url)
  expect(file.headers()['content-disposition']).toMatch(/^attachment;/)
  expect(file.headers()['x-content-type-options']).toBe('nosniff')
  expect(Buffer.compare(await file.body(), fileBytes)).toBe(0)

  // A tampered link is refused.
  const tampered = new URL(url)
  tampered.searchParams.set('type', 'text/html')
  expect((await page.request.get(tampered.toString())).status()).toBe(403)

  const detail = await (await page.request.get(`/api/v1/projects/${project.id}`)).json()
  expect(detail.progress).toMatchObject({ tasksTotal: 3, tasksDone: 0, percent: 0 })
})
