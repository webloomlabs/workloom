/**
 * The OAuth authorization request parameters, carried through the consent
 * form as `oauth_<name>` fields. Safe to import from client components.
 */
export const OAUTH_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'resource',
  'scope',
] as const
