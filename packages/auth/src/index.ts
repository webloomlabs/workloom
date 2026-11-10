export { auth, authGET, authPOST, type Auth } from './auth.ts'
export { accessControl, roles } from './access-control.ts'
export { verifyApiKey, type ResolvedApiKey } from './api-keys.ts'
export { resolveActor, type Resolution, type ResolveOptions } from './resolve-actor.ts'
export { authErrorCode, authErrorMessage } from './errors.ts'
export {
  completeSetup,
  isInstalled,
  provisionMember,
  setMemberPassword,
  type NewAccount,
} from './provisioning.ts'
export { recordAuthEvent } from './audit-hooks.ts'
export { confirmOrganizationReset, requestOrganizationReset, RESET_CODE_MINUTES } from './organization-reset.ts'
export * as oauth from './oauth/index.ts'
