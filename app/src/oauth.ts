/** Minimal public-client Authorization Code + PKCE (S256) browser transport.
 * The application owns token lifetime in memory; only the short-lived PKCE
 * transaction needed to survive the provider redirect is kept in tab storage.
 */
import * as oauth from 'oauth4webapi';
import { parseApplicationLocation } from './application/navigation';

export interface OAuthWebConfig {
  issuer: string;
  clientId: string;
  apiAudience: string;
  redirectUri: string;
  scopes: string[];
}

export type WebShell = 'desktop' | 'mobile';

type ViteOAuthEnvironment = {
  VITE_CODEXIA_OAUTH_ISSUER?: string;
  VITE_CODEXIA_OAUTH_CLIENT_ID?: string;
  VITE_CODEXIA_API_AUDIENCE?: string;
  VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI?: string;
  VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI?: string;
  VITE_CODEXIA_OAUTH_SCOPES?: string;
};

/** Read only public, non-secret build configuration. */
export function webOAuthConfig(shell: WebShell): OAuthWebConfig | null {
  const env = (import.meta as ImportMeta & { env?: ViteOAuthEnvironment }).env;
  if (!env) return null;
  const issuer = env.VITE_CODEXIA_OAUTH_ISSUER;
  const clientId = env.VITE_CODEXIA_OAUTH_CLIENT_ID;
  const apiAudience = env.VITE_CODEXIA_API_AUDIENCE;
  const redirectUri = shell === 'desktop' ? env.VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI : env.VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI;
  if (!issuer && !clientId && !apiAudience && !redirectUri) return null;
  if (!issuer?.trim() || !clientId?.trim() || !apiAudience?.trim() || !redirectUri?.trim()) {
    throw new Error('OAuth Web configuration is incomplete.');
  }
  return {
    issuer,
    clientId,
    apiAudience,
    redirectUri,
    scopes: (env.VITE_CODEXIA_OAUTH_SCOPES ?? 'openid codexia:api').split(/\s+/u).filter(Boolean),
  };
}

interface OAuthTransaction {
  state: string;
  verifier: string;
  createdAt: number;
  returnPath: string | null;
}
const TRANSACTION_KEY = 'codexia.oauth.pkce.v1';
const TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;

function trustedHttpsUrl(value: unknown, name: string): URL {
  let url: URL;
  try {
    if (typeof value !== 'string') throw new Error();
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error(`${name} must use HTTPS.`);
  }
  if (url.username || url.password || url.hash) throw new Error(`${name} must not contain credentials or a fragment.`);
  return url;
}

function validateConfig(config: OAuthWebConfig): URL {
  const issuer = trustedHttpsUrl(config.issuer, 'OAuth issuer');
  if (issuer.search || issuer.pathname.endsWith('/')) throw new Error('OAuth issuer must be a canonical origin and path.');
  const redirect = trustedHttpsUrl(config.redirectUri, 'Redirect URI');
  if (typeof window !== 'undefined' && redirect.origin !== window.location.origin) {
    throw new Error("OAuth redirect URI must use this Web application's exact origin.");
  }
  if (issuer.origin !== redirect.origin) throw new Error("OAuth login must use the Web application's exact origin.");
  if (!config.clientId.trim() || !config.apiAudience.trim()) throw new Error('OAuth client ID and API audience are required.');
  trustedHttpsUrl(config.apiAudience, 'API audience');
  if (!config.scopes.length || config.scopes.some(scope => !/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope))) {
    throw new Error('At least one valid OAuth scope is required.');
  }
  return issuer;
}

function requestOptions(issuer: URL, fetcher: typeof fetch) {
  return {
    // validateConfig has already restricted HTTP to loopback.
    [oauth.allowInsecureRequests]: issuer.protocol === 'http:',
    [oauth.customFetch]: (url: string, init: oauth.CustomFetchOptions<'GET' | 'POST', URLSearchParams | undefined>) =>
      fetcher(url, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error' }),
  };
}

function advertises(value: unknown, ...required: string[]): boolean {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') && required.every(entry => value.includes(entry));
}

async function discoverAuthorizationServer(
  config: OAuthWebConfig,
  issuer: URL,
  options: ReturnType<typeof requestOptions>,
): Promise<oauth.AuthorizationServer> {
  let metadata: oauth.AuthorizationServer;
  try {
    const response = await oauth.discoveryRequest(issuer, { ...options, algorithm: 'oauth2' });
    metadata = await oauth.processDiscoveryResponse(issuer, response);
  } catch {
    throw new Error('OAuth authorization-server metadata does not meet the public-client security requirements.');
  }

  if (
    metadata.issuer !== config.issuer ||
    !advertises(metadata.response_types_supported, 'code') ||
    !advertises(metadata.grant_types_supported, 'authorization_code') ||
    !advertises(metadata.token_endpoint_auth_methods_supported, 'none') ||
    !advertises(metadata.code_challenge_methods_supported, 'S256') ||
    metadata.authorization_response_iss_parameter_supported !== true ||
    (metadata.scopes_supported !== undefined && !advertises(metadata.scopes_supported, ...config.scopes))
  ) {
    throw new Error('OAuth authorization-server metadata does not meet the public-client security requirements.');
  }

  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
    const url = trustedHttpsUrl(endpoint, 'OAuth endpoint');
    if (url.origin !== issuer.origin || !url.pathname.startsWith(`${issuer.pathname}/`)) {
      throw new Error('OAuth endpoints must remain within the configured same-origin issuer.');
    }
  }
  return metadata;
}

const RESPONSE_PARAMETERS = ['code', 'state', 'iss', 'error', 'error_description', 'error_uri'];
const UNSUPPORTED_RESPONSE_PARAMETERS = ['response', 'access_token', 'refresh_token', 'id_token', 'token', 'token_type', 'expires_in'];
const CALLBACK_PARAMETERS = [...RESPONSE_PARAMETERS, ...UNSUPPORTED_RESPONSE_PARAMETERS];

function hasCallbackParameters(params: URLSearchParams): boolean {
  return CALLBACK_PARAMETERS.some(name => params.has(name));
}

function applicationReturnPath(value: unknown, redirect: URL): string | null {
  if (typeof value !== 'string') return null;
  const shell = parseApplicationLocation(redirect.pathname)?.mode;
  if (!shell) return null;
  try {
    const url = new URL(value, redirect.origin);
    if (
      url.origin !== redirect.origin ||
      url.username ||
      url.password ||
      (url.pathname !== `/${shell}` && !url.pathname.startsWith(`/${shell}/`))
    )
      return null;
    for (const name of CALLBACK_PARAMETERS) url.searchParams.delete(name);
    const hash = hasCallbackParameters(new URLSearchParams(url.hash.slice(1))) ? '' : url.hash;
    return `${url.pathname}${url.search}${hash}`;
  } catch {
    return null;
  }
}

export async function beginOAuthAuthorization(config: OAuthWebConfig, fetcher: typeof fetch = fetch): Promise<void> {
  const issuer = validateConfig(config);
  const metadata = await discoverAuthorizationServer(config, issuer, requestOptions(issuer, fetcher));
  const state = oauth.generateRandomState();
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  const transaction: OAuthTransaction = {
    state,
    verifier,
    createdAt: Date.now(),
    returnPath: applicationReturnPath(window.location.href, new URL(config.redirectUri)),
  };
  sessionStorage.setItem(TRANSACTION_KEY, JSON.stringify(transaction));
  const authorizationUrl = trustedHttpsUrl(metadata.authorization_endpoint, 'Authorization endpoint');
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', config.clientId);
  authorizationUrl.searchParams.set('redirect_uri', config.redirectUri);
  authorizationUrl.searchParams.set('scope', config.scopes.join(' '));
  authorizationUrl.searchParams.set('resource', config.apiAudience);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(authorizationUrl.toString());
}

export async function completeOAuthAuthorization(
  config: OAuthWebConfig,
  callbackUrl = window.location.href,
  fetcher: typeof fetch = fetch,
): Promise<{ accessToken: string; returnPath: string } | null> {
  const issuer = validateConfig(config);
  const callback = new URL(callbackUrl);
  const expected = trustedHttpsUrl(config.redirectUri, 'Redirect URI');
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) return null;
  const query = callback.searchParams;
  const fragmentResponse = hasCallbackParameters(new URLSearchParams(callback.hash.slice(1)));
  if (!hasCallbackParameters(query) && !fragmentResponse) return null;

  const raw = sessionStorage.getItem(TRANSACTION_KEY);
  sessionStorage.removeItem(TRANSACTION_KEY);
  for (const name of RESPONSE_PARAMETERS) {
    if (query.getAll(name).length > 1) throw new Error(`OAuth callback contains an ambiguous ${name} value.`);
  }
  if (
    callback.username ||
    callback.password ||
    fragmentResponse ||
    UNSUPPORTED_RESPONSE_PARAMETERS.some(name => query.has(name)) ||
    (query.has('error')
      ? !query.get('error') || query.has('code')
      : !query.get('code') || query.has('error_description') || query.has('error_uri'))
  ) {
    throw new Error('OAuth callback has an invalid response.');
  }

  let transaction: OAuthTransaction | null = null;
  try {
    transaction = raw ? (JSON.parse(raw) as OAuthTransaction) : null;
  } catch {
    transaction = null;
  }
  const now = Date.now();
  // Existing tabs may still hold a 64-character verifier within the same ten-minute window.
  if (
    !transaction ||
    typeof transaction.state !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(transaction.state) ||
    typeof transaction.verifier !== 'string' ||
    !/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})$/u.test(transaction.verifier) ||
    !Number.isFinite(transaction.createdAt) ||
    now - transaction.createdAt > TRANSACTION_MAX_AGE_MS ||
    now < transaction.createdAt
  ) {
    throw new Error('OAuth state validation failed. Start sign-in again.');
  }

  const client: oauth.Client = { client_id: config.clientId };
  let params: URLSearchParams;
  try {
    // Validate against the pinned issuer before making any network request.
    params = oauth.validateAuthResponse(
      {
        issuer: config.issuer,
        authorization_response_iss_parameter_supported: true,
      },
      client,
      query,
      transaction.state,
    );
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError) throw new Error('The identity provider did not complete sign-in.');
    throw new Error('OAuth issuer or state validation failed. Start sign-in again.');
  }

  const options = requestOptions(issuer, fetcher);
  const metadata = await discoverAuthorizationServer(config, issuer, options);
  let response: Response;
  try {
    response = await oauth.authorizationCodeGrantRequest(metadata, client, oauth.None(), params, config.redirectUri, transaction.verifier, {
      ...options,
      additionalParameters: { resource: config.apiAudience },
    });
  } catch {
    throw new Error('Token exchange failed. Retry sign-in when the identity provider is available.');
  }

  let token: oauth.TokenEndpointResponse;
  try {
    const wireResponse = response.clone();
    token = await oauth.processAuthorizationCodeResponse(metadata, client, response);
    // oauth4webapi also accepts numeric strings and missing lifetimes. Codexia requires a positive JSON number.
    const { expires_in: lifetime } = await wireResponse.json();
    if (typeof lifetime !== 'number' || !Number.isFinite(lifetime) || lifetime <= 0 || token.token_type !== 'bearer') {
      throw new Error('Invalid bearer token lifetime or type.');
    }
  } catch {
    throw new Error('The provider did not return a usable API bearer access token.');
  }

  if (token.scope !== undefined) {
    const granted = token.scope.split(' ');
    if (
      granted.length !== config.scopes.length ||
      new Set(granted).size !== granted.length ||
      !config.scopes.every(scope => granted.includes(scope))
    ) {
      throw new Error('The provider did not grant the requested API scopes.');
    }
  }
  return {
    accessToken: token.access_token,
    returnPath: applicationReturnPath(transaction.returnPath, expected) ?? `${callback.pathname}${callback.hash}`,
  };
}

/** Resolve only API paths to the configured HTTPS API origin. */
export function apiRequestUrl(path: string, apiOrigin?: string, pageOrigin?: string): string {
  if (!path.startsWith('/api/')) throw new Error('Only Codexia API paths may use the API origin.');
  if (!apiOrigin) return path;
  const api = trustedHttpsUrl(apiOrigin, 'API origin');
  if (api.pathname !== '/' || api.search || api.hash) throw new Error('API origin must contain only an origin.');
  const page = pageOrigin ? new URL(pageOrigin) : typeof window !== 'undefined' ? window.location : undefined;
  if (page && api.origin === page.origin) return path;
  return new URL(path, api.origin).toString();
}
