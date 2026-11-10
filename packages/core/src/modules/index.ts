/**
 * Importing this module registers every procedure. Transports import it once,
 * at startup, so that the registry is populated before any route is mounted.
 */
export * from './identity.ts'
export * from './organization.ts'
export * from './api-keys.ts'
export * from './oauth-grants.ts'
export * from './audit.ts'
export * from './webhooks.ts'
export * from './crm/index.ts'
export * from './projects/index.ts'
export * from './time/index.ts'
export * from './finance/index.ts'
export * from './banking/index.ts'
export * from './support/index.ts'
export * from './maintenance/index.ts'
export * from './infrastructure/index.ts'
export * from './documents/index.ts'
export * from './reports/index.ts'
export * from './exports.ts'
export * from './integrations/index.ts'
export * from './books/index.ts'
// Last: it imports the Telegram client, and procedures register -- and are
// listed in the OpenAPI document -- in the order their modules load.
export * from './organization-reset.ts'
