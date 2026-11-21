
const requiredSettings = Object.freeze([
  ['VITE_CODEXIA_OAUTH_ISSUER', 'OAuth issuer'],
  ['VITE_CODEXIA_OAUTH_CLIENT_ID', 'OAuth client ID'],
  ['VITE_CODEXIA_API_AUDIENCE', 'OAuth API audience'],
  ['VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI', 'Desktop redirect URI'],
  ['VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI', 'Mobile redirect URI'],
]);
const scopesSetting = 'VITE_CODEXIA_OAUTH_SCOPES';
const configFormat = 'codexia-web-oauth-config/v1';

function configured(value) {
  return value !== undefined && value !== null && value !== '';
}

function trustedWebUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} must be an absolute HTTPS URL.`); }
  const loopbackHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !loopbackHttp) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be an absolute HTTPS URL without credentials or a fragment.`);
  }
  return parsed;
}

/** Read and validate the public OAuth settings shared by both browser shells. */
export function readFrontendOAuthConfig(env = process.env) {
  const active = requiredSettings.some(([key]) => configured(env[key])) || configured(env[scopesSetting]);
  if (!active) return null;

  const missing = requiredSettings.filter(([key]) => typeof env[key] !== 'string' || env[key].trim() === '');
  if (missing.length) {
    throw new Error(`OAuth Web configuration is incomplete. Missing: ${missing.map(([, label]) => label).join(', ')}.`);
  }

  for (const [key, label] of requiredSettings) {
    if (env[key] !== env[key].trim()) throw new Error(`${label} must not contain leading or trailing whitespace.`);
  }

  const issuer = trustedWebUrl(env.VITE_CODEXIA_OAUTH_ISSUER, 'OAuth issuer');
  if (issuer.pathname === '/' || issuer.pathname.endsWith('/') || issuer.search) {
    throw new Error('OAuth issuer must be a canonical URL with a path and no query or trailing slash.');
  }
  const audience = trustedWebUrl(env.VITE_CODEXIA_API_AUDIENCE, 'OAuth API audience');
  const desktopRedirect = trustedWebUrl(env.VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI, 'Desktop redirect URI');
  const mobileRedirect = trustedWebUrl(env.VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI, 'Mobile redirect URI');
  if (desktopRedirect.origin !== issuer.origin || mobileRedirect.origin !== issuer.origin) {
    throw new Error('OAuth redirect URI must use the OAuth issuer origin.');
  }

  const rawScopes = configured(env[scopesSetting]) ? env[scopesSetting] : 'openid codexia:api';
  if (typeof rawScopes !== 'string' || rawScopes.trim() === '') throw new Error('OAuth scopes must not be empty.');
  const scopes = rawScopes.split(/\s+/u).filter(Boolean);
  if (scopes.length === 0) throw new Error('OAuth scopes must not be empty.');

  return Object.freeze({
    issuer: env.VITE_CODEXIA_OAUTH_ISSUER,
    clientId: env.VITE_CODEXIA_OAUTH_CLIENT_ID,
    apiAudience: env.VITE_CODEXIA_API_AUDIENCE,
    desktopRedirectUri: env.VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI,
    mobileRedirectUri: env.VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI,
    scopes,
  });
}

/** Exact identity for the public OAuth configuration embedded in a static bundle. */
export function frontendOAuthConfigIdentity(env = process.env) {
  return JSON.stringify({ format: configFormat, settings: readFrontendOAuthConfig(env) });
}

/** Reject promotion or release artifacts that were built with different public OAuth settings. */
export function assertFrontendOAuthConfigIdentity(identity, env = process.env) {
  const expected = frontendOAuthConfigIdentity(env);
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      typeof identity.oauthConfigIdentity !== 'string' || identity.oauthConfigIdentity !== expected) {
    throw new Error('Frontend artifact OAuth configuration does not match the current public settings.');
  }
  return identity;
}
