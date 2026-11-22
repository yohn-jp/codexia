#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

const MCP_SCOPES = Object.freeze(['mcp:read', 'mcp:compute', 'mcp:propose']);
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource/api';
const AS_METADATA_PATH = '/.well-known/oauth-authorization-server/api/auth';
const OIDC_METADATA_PATH = '/.well-known/openid-configuration/api/auth';
const MCP_PATH = '/mcp';
const PROTECTED_API_PATH = '/api/projects';
const PROTECTED_UI_PATH = '/desktop';
const AUTH_METHODS_PATH = '/api/auth/codexia/auth-methods';
const AUTH_SESSION_PATH = '/api/auth/get-session';
const OAUTH_LOGIN_PATH = '/oauth/login';
const OAUTH_CONSENT_PATH = '/oauth/consent';

function assertOrigin(value) {
  let origin;
  try { origin = new URL(value); }
  catch { throw new Error('CODEXIA_PUBLIC_ORIGIN must be an absolute HTTPS origin.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('CODEXIA_PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query or fragment.');
  }
  return origin;
}

function evidence(response) {
  const ray = response.headers.get('cf-ray');
  return `HTTP ${response.status}${ray && /^[0-9a-f]+-[A-Z0-9]+$/u.test(ray) ? `, CF-Ray ${ray}` : ''}`;
}

function requireStatus(response, expected, path) {
  if (response.headers.get('cf-mitigated') === 'challenge') {
    throw new Error(`${path} returned an interactive edge challenge (${evidence(response)}).`);
  }
  if (response.status !== expected) {
    throw new Error(`${path} returned ${evidence(response)}; expected HTTP ${expected} without an Access redirect or edge challenge.`);
  }
  if (response.headers.has('location')) {
    throw new Error(`${path} returned a redirect despite a public protocol route (${evidence(response)}).`);
  }
}

async function readJson(response, path) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(`${path} did not return JSON (${evidence(response)}).`);
  }
  try { return await response.json(); }
  catch { throw new Error(`${path} returned invalid JSON (${evidence(response)}).`); }
}

/**
 * Read-only, anonymous verification of the public OAuth/MCP edge boundary.
 * It never sends Authorization, Cookie, or Cloudflare Access service-token headers.
 * @param {{origin:string|URL,fetchImpl?:typeof fetch}} options
 */
export async function probePublicOAuthEdge({ origin: inputOrigin, fetchImpl = fetch }) {
  const origin = assertOrigin(inputOrigin instanceof URL ? inputOrigin.toString() : inputOrigin);
  const expectedResource = new URL('/api', origin).toString();
  const expectedIssuer = new URL('/api/auth', origin).toString();
  const protectedResourceUrl = new URL(PROTECTED_RESOURCE_PATH, origin).toString();

  async function request(path, { accept = 'application/json', method = 'GET' } = {}) {
    const headers = new Headers({ Accept: accept, 'Cache-Control': 'no-cache' });
    for (const forbidden of ['authorization', 'cookie', 'cf-access-client-id', 'cf-access-client-secret', 'cf-access-jwt-assertion']) {
      if (headers.has(forbidden)) throw new Error('Public edge verification must not send user or Access credentials.');
    }
    try {
      return await fetchImpl(new URL(path, origin), {
        method,
        headers,
        credentials: 'omit',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`${path} is unreachable; check the HTTPS origin, DNS, Tunnel and TLS.`);
    }
  }

  async function readPublicJson(path) {
    const response = await request(path);
    requireStatus(response, 200, path);
    return readJson(response, path);
  }

  async function readPublicOAuthPage(path) {
    const response = await request(path, { accept: 'text/html' });
    requireStatus(response, 200, path);
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${path} did not return the dedicated OAuth HTML document (${evidence(response)}).`);
    }
    const html = await response.text();
    if (!/<html\b/iu.test(html)) throw new Error(`${path} did not return an HTML document.`);
    const references = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/giu)].map((match) => match[1]);
    if (references.length === 0) throw new Error(`${path} has no dedicated OAuth assets.`);

    const assets = new Set();
    for (const reference of references) {
      let assetUrl;
      try { assetUrl = new URL(reference, origin); }
      catch { throw new Error(`${path} contains an invalid asset reference.`); }
      if (assetUrl.origin !== origin.origin || !assetUrl.pathname.startsWith('/oauth/assets/') || assetUrl.search || assetUrl.hash) {
        throw new Error(`${path} references an asset outside the dedicated /oauth/assets/ prefix.`);
      }
      assets.add(assetUrl.pathname);
    }

    for (const assetPath of assets) {
      const assetResponse = await request(assetPath, { accept: '*/*' });
      requireStatus(assetResponse, 200, assetPath);
      if ((assetResponse.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
        await assetResponse.body?.cancel().catch(() => undefined);
        throw new Error(`${assetPath} returned HTML instead of a static asset (${evidence(assetResponse)}).`);
      }
      await assetResponse.body?.cancel().catch(() => undefined);
    }
    return { status: response.status, assets: assets.size };
  }

  const resource = await readPublicJson(PROTECTED_RESOURCE_PATH);
  if (resource?.resource !== expectedResource ||
      !Array.isArray(resource.authorization_servers) ||
      resource.authorization_servers.length !== 1 || resource.authorization_servers[0] !== expectedIssuer ||
      !Array.isArray(resource.scopes_supported) ||
      resource.scopes_supported.length !== MCP_SCOPES.length ||
      !MCP_SCOPES.every((scope) => resource.scopes_supported.includes(scope)) ||
      JSON.stringify(resource.bearer_methods_supported) !== JSON.stringify(['header'])) {
    throw new Error(`${PROTECTED_RESOURCE_PATH} does not publish the configured API audience, issuer and limited MCP scopes.`);
  }

  const authorizationServer = await readPublicJson(AS_METADATA_PATH);
  const openIdConfiguration = await readPublicJson(OIDC_METADATA_PATH);
  for (const [name, metadata] of [['authorization server', authorizationServer], ['OpenID configuration', openIdConfiguration]]) {
    if (metadata?.issuer !== expectedIssuer ||
        metadata.authorization_endpoint !== new URL('/api/auth/oauth2/authorize', origin).toString() ||
        metadata.token_endpoint !== new URL('/api/auth/oauth2/token', origin).toString() ||
        metadata.jwks_uri !== new URL('/api/auth/jwks', origin).toString()) {
      throw new Error(`${name} metadata advertises an unexpected issuer or OAuth endpoint.`);
    }
  }
  if (!Array.isArray(openIdConfiguration.code_challenge_methods_supported) ||
      !openIdConfiguration.code_challenge_methods_supported.includes('S256')) {
    throw new Error('OpenID configuration does not advertise PKCE S256.');
  }

  const jwksUrl = new URL(authorizationServer.jwks_uri);
  if (jwksUrl.origin !== origin.origin || jwksUrl.pathname !== '/api/auth/jwks' || jwksUrl.search || jwksUrl.hash) {
    throw new Error('OAuth signing keys must be hosted at the configured origin and fixed JWKS path.');
  }
  const jwks = await readPublicJson(jwksUrl.pathname);
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error('The public JWKS document contains no signing keys.');

  await readPublicJson(AUTH_METHODS_PATH);
  await readPublicJson(AUTH_SESSION_PATH);
  const oauthLogin = await readPublicOAuthPage(OAUTH_LOGIN_PATH);
  const oauthConsent = await readPublicOAuthPage(OAUTH_CONSENT_PATH);

  const mcp = await request(MCP_PATH, { accept: 'application/json, text/event-stream' });
  requireStatus(mcp, 401, MCP_PATH);
  const challenge = mcp.headers.get('www-authenticate') ?? '';
  if (!challenge.includes(`resource_metadata="${protectedResourceUrl}"`)) {
    throw new Error(`${MCP_PATH} did not return the expected OAuth protected-resource challenge (${evidence(mcp)}).`);
  }
  await mcp.body?.cancel().catch(() => undefined);

  const dataApi = await request(PROTECTED_API_PATH);
  if (![401, 403].includes(dataApi.status) || dataApi.headers.has('location') || dataApi.headers.get('cf-mitigated') === 'challenge') {
    await dataApi.body?.cancel().catch(() => undefined);
    throw new Error(`${PROTECTED_API_PATH} was not denied by API authentication without a token (${evidence(dataApi)}).`);
  }
  await dataApi.body?.cancel().catch(() => undefined);

  const ui = await request(PROTECTED_UI_PATH, { accept: 'text/html' });
  if (![301, 302, 303, 307, 308, 401, 403].includes(ui.status) || ui.headers.get('cf-mitigated') === 'challenge') {
    await ui.body?.cancel().catch(() => undefined);
    throw new Error(`${PROTECTED_UI_PATH} did not remain behind the static UI Access boundary (${evidence(ui)}).`);
  }
  const location = ui.headers.get('location');
  if ([301, 302, 303, 307, 308].includes(ui.status)) {
    let target;
    try { target = new URL(location ?? '', origin); }
    catch { throw new Error(`${PROTECTED_UI_PATH} redirected to an invalid destination.`); }
    if (target.hostname !== origin.hostname && !target.hostname.endsWith('.cloudflareaccess.com')) {
      throw new Error(`${PROTECTED_UI_PATH} redirected outside the Access login boundary.`);
    }
  }
  await ui.body?.cancel().catch(() => undefined);

  return {
    resource: resource.resource,
    issuer: authorizationServer.issuer,
    mcpUnauthorizedStatus: mcp.status,
    protectedApiUnauthorizedStatus: dataApi.status,
    uiAccessBoundaryStatus: ui.status,
    oauthLoginStatus: oauthLogin.status,
    oauthConsentStatus: oauthConsent.status,
    oauthStaticAssetCount: oauthLogin.assets + oauthConsent.assets,
  };
}

async function main() {
  const origin = process.env.CODEXIA_PUBLIC_ORIGIN;
  if (!origin) throw new Error('Set CODEXIA_PUBLIC_ORIGIN to the HTTPS production origin. No credentials are needed.');
  await probePublicOAuthEdge({ origin });
  console.log('Verified public OAuth metadata/JWKS, dedicated login/consent HTML and assets, MCP challenge, protected API denial, and UI Access boundary.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Public OAuth edge verification failed.');
    process.exitCode = 1;
  });
}
