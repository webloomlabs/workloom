import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive a running Workloom through a real browser.
 *
 * They do not start the app themselves: point E2E_BASE_URL at a running
 * instance. Locally that is `pnpm dev`; in CI it is the docker compose stack,
 * which is what makes the clean-install job an honest test of self-hosting.
 *
 * Outbound email is read back from Mailpit (E2E_MAILPIT_URL), so flows that
 * depend on an emailed link -- invitations, verification -- run for real.
 *
 * The suite is split by the tenancy the instance is configured for, because
 * the two are mutually exclusive: sign-up exists or it does not. Specs tagged
 * `@single-tenant` need MULTI_TENANT=false and a database with no accounts in
 * it yet -- setup runs once and then closes -- so they are skipped unless
 * E2E_SINGLE_TENANT is set, and everything else is skipped when it is.
 */
const singleTenant = process.env.E2E_SINGLE_TENANT === 'true'

export default defineConfig({
  testDir: './specs',
  ...(singleTenant ? { grep: /@single-tenant/ } : { grepInvert: /@single-tenant/ }),
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,
  // The dev server compiles each route on first visit, which routinely takes
  // longer than Playwright's 5s default. Production builds are far faster.
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    // Use an installed Chrome locally rather than downloading a browser.
    ...(process.env.CI ? {} : { channel: 'chrome' }),
  },
})
