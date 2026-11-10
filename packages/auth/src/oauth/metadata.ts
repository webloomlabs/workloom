import { ACCESS_TOKEN_SECONDS, issuer, mcpResource, OAUTH_SCOPE } from './config.ts'

/** RFC 9728: where the MCP endpoint's authorization comes from. */
export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [issuer()],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: 'Workloom',
    resource_documentation: 'https://github.com/webloomlabs/workloom/blob/main/docs/mcp.md',
  }
}

/** RFC 8414: how to obtain a token. */
export function authorizationServerMetadata() {
  const base = issuer()
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://github.com/webloomlabs/workloom/blob/main/docs/mcp.md',
    // Not a standard field; a hint for people reading the document.
    access_token_lifetime_seconds: ACCESS_TOKEN_SECONDS,
  }
}
