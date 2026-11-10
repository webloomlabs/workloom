export { ACCESS_TOKEN_PREFIX, issuer, mcpResource } from './config.ts'
export { OAuthError } from './errors.ts'
export { authorizationServerMetadata, protectedResourceMetadata } from './metadata.ts'
export { isAllowedRedirectUri, registerClient, type OAuthClient } from './clients.ts'
export {
  approveAuthorization,
  denyAuthorization,
  listMemberships,
  validateAuthorizeRequest,
  type AuthorizeRequest,
  type AuthorizeValidation,
} from './authorize.ts'
export { exchangeToken, revokeGrant, revokeToken, verifyOAuthAccessToken, type TokenResponse } from './tokens.ts'
