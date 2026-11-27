import { createOAuthAccessTokenVerifier, type OAuthAccessTokenVerifierOptions, OAuthAuthenticationError } from './oauth-token.js';

export const CODEXIA_OWNER_SCOPE = 'codexia:api';

export interface OAuthOwnerOptions extends OAuthAccessTokenVerifierOptions {
  readonly ownerSubject: string;
  readonly requiredScopes: readonly string[];
  readonly allowedClientIds?: readonly string[];
  /** Permits plain HTTP loopback only in test processes for synthetic IdP fixtures. */
  readonly allowInsecureLoopbackForTests?: boolean;
}

export interface OAuthPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: readonly string[];
}

export function createOAuthOwnerAuthenticator(options: OAuthOwnerOptions): (token: string) => Promise<OAuthPrincipal> {
  if (
    !options.audience.trim() ||
    options.audience !== options.audience.trim() ||
    !options.ownerSubject.trim() ||
    !options.requiredScopes.length ||
    options.requiredScopes.some(scope => !/^[A-Za-z0-9:._/-]{1,128}$/u.test(scope))
  ) {
    throw new Error('OAuth audience, owner subject and required scopes must be configured');
  }
  const verifyToken = createOAuthAccessTokenVerifier(
    options,
    claims => {
      if (!options.requiredScopes.every(scope => claims.scopes.includes(scope))) {
        throw new OAuthAuthenticationError(403, 'OAUTH_SCOPE_REQUIRED', 'Access token does not grant the required API scope');
      }
      if (claims.subject !== options.ownerSubject) {
        throw new OAuthAuthenticationError(403, 'OAUTH_OWNER_REQUIRED', 'Authenticated identity is not configured as the standalone owner');
      }
      if (options.allowedClientIds && !options.allowedClientIds.includes(claims.clientId)) {
        throw new OAuthAuthenticationError(403, 'OAUTH_CLIENT_NOT_ALLOWED', 'OAuth client is not configured for owner access');
      }
    },
    options.allowInsecureLoopbackForTests,
  );

  return async (token: string) => {
    const { issuer, subject, scopes } = await verifyToken(token);
    return { issuer, subject, scopes };
  };
}
