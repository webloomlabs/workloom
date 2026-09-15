import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Lint configuration.
 *
 * Most of this file is not style. The `no-restricted-imports` blocks encode the
 * architecture: which layers may reach the database, and which may not reach
 * each other. Each boundary exists because crossing it breaks a guarantee that
 * is otherwise easy to lose without noticing:
 *
 *   - The unscoped `db` handle and `withoutTenant` bypass tenant scoping. Every
 *     use outside the allowlist below is a potential cross-tenant query.
 *   - `drizzle-orm` and `pg` stay behind @workloom/db, so data access has one
 *     home and one place to audit.
 *   - @workloom/core never imports @workloom/auth. That is what lets the same
 *     business logic run from HTTP, background jobs, and tests.
 *   - The web app does not query the database. Transport code that reads data
 *     directly is business logic the public API cannot reach.
 *
 * ESLint applies the LAST matching block for a given rule, so blocks run from
 * general to specific.
 */

const DRIZZLE_AND_DRIVER = [
  { name: 'drizzle-orm', message: 'Import query helpers from @workloom/db instead.' },
  { name: 'pg', message: 'Database connections belong to @workloom/db.' },
]
const DRIZZLE_PATTERNS = [
  { group: ['drizzle-orm/*'], message: 'Import query helpers from @workloom/db instead.' },
]

const UNSCOPED_DB = {
  name: '@workloom/db',
  importNames: ['db', 'withoutTenant', 'getPool'],
  message:
    'The unscoped handle bypasses tenant isolation. Use withTenant(), or a procedure ' +
    'context (ctx.tx). If this really is instance-wide work, it belongs on the allowlist ' +
    'in eslint.config.js and in docs/architecture.md.',
}

const restrict = (paths, patterns = DRIZZLE_PATTERNS) => ({
  'no-restricted-imports': ['error', { paths, patterns }],
})

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/.turbo/**',
      'packages/db/src/migrations/**',
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        // `typeof import('...')` stays allowed: integration tests load modules
        // lazily, after the test database's environment is in place.
        { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
    },
  },

  // Default for all source: no driver, no ORM, no unscoped handle.
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: restrict([...DRIZZLE_AND_DRIVER, UNSCOPED_DB]),
  },

  // Core is domain logic: additionally, it must not know how requests arrive.
  {
    files: ['packages/core/src/**/*.ts'],
    rules: restrict([
      ...DRIZZLE_AND_DRIVER,
      UNSCOPED_DB,
      {
        name: '@workloom/auth',
        message:
          'core must not depend on auth. Services receive an ActorContext; they never build one.',
      },
    ]),
  },

  // The web app is transport. It calls procedures; it does not query.
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    rules: restrict([
      ...DRIZZLE_AND_DRIVER,
      {
        name: '@workloom/db',
        message:
          'The web app is a transport layer. Call a procedure from @workloom/core/registry ' +
          'so the operation is also available through the public API and the audit trail.',
      },
    ]),
  },

  /**
   * The cross-organization flags. Each widens row-level security for one narrow
   * purpose, so each may be set in exactly one place. A new use means a new
   * entry here and in docs/architecture.md, not a quiet string in a module.
   */
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['apps/worker/src/outbox/scope.ts', 'packages/auth/src/api-keys.ts', '**/test/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/workloom\\.(dispatcher|auth_lookup)/]",
          message:
            'This flag widens row-level security across organizations and may only be set in ' +
            'its one documented location. See docs/architecture.md.',
        },
        {
          selector: "TemplateElement[value.raw=/workloom\\.(dispatcher|auth_lookup)/]",
          message:
            'This flag widens row-level security across organizations and may only be set in ' +
            'its one documented location. See docs/architecture.md.',
        },
      ],
    },
  },

  /**
   * Client components run in the browser. Importing server packages here does
   * not fail typechecking -- it fails the build, or worse, ships a database
   * driver and email transport to every visitor. Server Actions are fine to
   * import: Next replaces them with references.
   */
  {
    files: ['apps/web/components/**/*.tsx', 'apps/web/components/**/*.ts'],
    rules: restrict(
      [
        ...DRIZZLE_AND_DRIVER,
        { name: '@workloom/db', message: 'Server-only. Pass data in as props.' },
        { name: '@workloom/auth', message: 'Server-only. Pass data in as props.' },
        { name: '@workloom/core', message: 'Server-only. @workloom/core/permissions is safe to import.' },
        { name: '@workloom/core/modules', message: 'Server-only. Call a Server Action instead.' },
        { name: '@workloom/core/registry', message: 'Server-only. Call a Server Action instead.' },
        { name: '@/lib/actions/errors', message: 'Server-only.' },
      ],
      [...DRIZZLE_PATTERNS, { group: ['@/lib/server/*'], message: 'Server-only. Pass data in as props.' }],
    ),
  },

  /**
   * The allowlist for the unscoped handle. Every entry is instance-wide by
   * nature, and each is described in docs/architecture.md:
   *
   *   packages/auth       Better Auth's tables are not tenant-scoped.
   *   rate-limit.ts       Counters are keyed by opaque strings, not tenants.
   *   worker outbox       Enumerates organizations, then scopes per org (S2).
   *   health, boot        Report on the database itself.
   *   auth route          Hands requests to Better Auth, which owns its tables.
   */
  {
    files: [
      'packages/auth/src/**/*.ts',
      'packages/core/src/rate-limit.ts',
      'apps/worker/src/outbox/**/*.ts',
      'apps/worker/src/maintenance.ts',
      'apps/web/app/api/health/**/*.ts',
      'apps/web/app/api/auth/**/*.ts',
      'apps/web/instrumentation.ts',
    ],
    rules: restrict(DRIZZLE_AND_DRIVER),
  },

  // Tests set up and inspect fixtures across organizations, so they may use
  // the unscoped handle -- but still not the driver or the ORM directly.
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      ...restrict(DRIZZLE_AND_DRIVER),
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // The data layer itself.
  {
    files: ['packages/db/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
)
