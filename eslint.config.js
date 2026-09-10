import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * The architectural rules that reviewers should not have to remember.
 *
 * Two of these guard invariants that are otherwise enforced only by
 * convention -- and convention does not survive a growing codebase, a
 * background worker, a CLI, and future contributors.
 */
export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/.turbo/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  /**
   * Rule 1: the unscoped database client is off limits.
   *
   * Tenant data is reached through `withTenant`, which opens the transaction
   * that row-level security filters against. A query issued on the raw client
   * has no organization scope. The allowlist below is exhaustive and each
   * entry is documented in docs/architecture.
   */
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: [
      'packages/db/**',
      'packages/auth/**',
      'apps/worker/src/outbox/**',
      'apps/web/instrumentation.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@workloom/db',
              importNames: ['db', 'getPool'],
              message:
                'Reach tenant data through withTenant(orgId, ...) instead. The raw client has ' +
                'no organization scope, so row-level security filters it to nothing -- and a ' +
                'query that appears to work is one that has escaped the tenant boundary.',
            },
          ],
        },
      ],
    },
  },

  /**
   * Rule 2: transports carry no business logic.
   *
   * A Server Action that implements behaviour rather than delegating to a
   * service silently removes that behaviour from the public REST API and from
   * the audit log. Route handlers and actions may only call into the
   * procedure registry.
   */
  {
    files: ['apps/web/app/api/**/*.ts', 'apps/web/lib/actions/**/*.ts'],
    ignores: ['apps/web/app/api/health/**', 'apps/web/app/api/auth/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@workloom/db', '@workloom/db/*'],
              message:
                'Transports build an ActorContext and call a registered procedure; they do not ' +
                'query the database. Put the logic in packages/core so the UI, the REST API, ' +
                'the worker and the CLI all share it.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', 'packages/db/test/**'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
)
