import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        // Pure logic. No database, no network, fast enough to run on save.
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Real Postgres, real migrations, real row-level security.
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['packages/*/test/**/*.isolation.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Tenant isolation runs as its own suite so that it is a visible
        // red/green signal in CI rather than a line item inside a large run.
        test: {
          name: 'isolation',
          include: ['packages/*/test/**/*.isolation.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Note: unlike the other suites, `test:isolation` does NOT pass
          // --passWithNoTests. An isolation run that matches no files must
          // fail -- silently empty looks exactly like passing, and this is the
          // suite whose failure is unrecoverable.
        },
      },
    ],
  },
})
