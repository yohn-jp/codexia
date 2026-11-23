/** Minimal public-client Authorization Code + PKCE (S256) browser transport.
 * The application owns token lifetime in memory; only the short-lived PKCE
 * transaction needed to survive the provider redirect is kept in tab storage.
 */
import { parseApplicationLocation } from "./application/navigation";

export interface OAuthWebConfig {
  issuer: string;
  clientId: string;
  apiAudience: string;
  redirectUri: string;
  scopes: string[];
}

export type WebShell = "desktop" | "mobile";

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
  const values = [env.VITE_CODEXIA_OAUTH_ISSUER,
    env.VITE_CODEXIA_OAUTH_CLIENT_ID, env.VITE_CODEXIA_API_AUDIENCE,
    shell === "desktop" ? env.VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI : env.VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value?.trim())) throw new Error("OAuth Web configuration is incomplete.");
  return {
    issuer: env.VITE_CODEXIA_OAUTH_ISSUER!,
    clientId: env.VITE_CODEXIA_OAUTH_CLIENT_ID!,
    apiAudience: env.VITE_CODEXIA_API_AUDIENCE!,
    redirectUri: shell === "desktop" ? env.VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI! : env.VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI!,
    scopes: (env.VITE_CODEXIA_OAUTH_SCOPES ?? "openid codexia:api").split(/\s+/u).filter(Boolean),
  };
}

interface OAuthTransaction { state: string; verifier: string; createdAt: number; returnPath: string | null }
const TRANSACTION_KEY = "codexia.oauth.pkce.v1";
const TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;

function trustedHttpsUrl(value: string, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error(`${name} must use HTTPS.`);
  }
  if (url.username || url.password || url.hash) throw new Error(`${name} must not contain credentials or a fragment.`);
  return url;
}

function randomBase64Url(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function validateConfig(config: OAuthWebConfig): void {
  trustedHttpsUrl(config.issuer, "OAuth issuer");
  const redirect = trustedHttpsUrl(config.redirectUri, "Redirect URI");
  if (typeof window !== "undefined" && redirect.origin !== window.location.origin) {
    throw new Error("OAuth redirect URI must use this Web application's exact origin.");
  }
  if (!config.clientId.trim() || !config.apiAudience.trim()) throw new Error("OAuth client ID and API audience are required.");
  trustedHttpsUrl(config.apiAudience, "API audience");
  if (!config.scopes.length || config.scopes.some((scope) => !scope.trim())) throw new Error("At least one OAuth scope is required.");
}

interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  authorization_response_iss_parameter_supported: boolean;
  scopes_supported?: string[];
}

function metadataEndpoint(issuerValue: string): URL {
  const issuer = trustedHttpsUrl(issuerValue, "OAuth issuer");
  if (issuer.search || issuer.pathname.endsWith("/")) throw new Error("OAuth issuer must be a canonical origin and path.");
  return new URL(`/.well-known/oauth-authorization-server${issuer.pathname}`, issuer.origin);
}

async function discoverAuthorizationServer(
  config: OAuthWebConfig,
  fetcher: typeof fetch,
): Promise<OAuthAuthorizationServerMetadata> {
  const issuer = trustedHttpsUrl(config.issuer, "OAuth issuer");
  const expectedOrigin = typeof window !== "undefined" ? window.location.origin : issuer.origin;
  if (issuer.origin !== expectedOrigin) throw new Error("OAuth login must use the Web application's exact origin.");
  const response = await fetcher(metadataEndpoint(config.issuer), {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("OAuth authorization-server metadata is unavailable.");
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object") throw new Error("OAuth authorization-server metadata is invalid.");
  const metadata = value as Partial<OAuthAuthorizationServerMetadata>;
  if (metadata.issuer !== config.issuer ||
      !Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes("code") ||
      !Array.isArray(metadata.grant_types_supported) || !metadata.grant_types_supported.includes("authorization_code") ||
      !Array.isArray(metadata.token_endpoint_auth_methods_supported) || !metadata.token_endpoint_auth_methods_supported.includes("none") ||
      !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256") ||
      metadata.authorization_response_iss_parameter_supported !== true ||
      (metadata.scopes_supported && config.scopes.some((scope) => !metadata.scopes_supported!.includes(scope)))) {
    throw new Error("OAuth authorization-server metadata does not meet the public-client security requirements.");
  }
  const authorizationEndpoint = trustedHttpsUrl(metadata.authorization_endpoint ?? "", "Authorization endpoint");
  const tokenEndpoint = trustedHttpsUrl(metadata.token_endpoint ?? "", "Token endpoint");
  const endpointPrefix = issuer.pathname.endsWith("/") ? issuer.pathname : `${issuer.pathname}/`;
  if (authorizationEndpoint.origin !== expectedOrigin || tokenEndpoint.origin !== expectedOrigin ||
      !authorizationEndpoint.pathname.startsWith(endpointPrefix) || !tokenEndpoint.pathname.startsWith(endpointPrefix)) {
    throw new Error("OAuth endpoints must remain within the configured same-origin issuer.");
  }
  return metadata as OAuthAuthorizationServerMetadata;
}

function oneSearchParam(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new Error(`OAuth callback contains an ambiguous ${name} value.`);
  return values[0] ?? null;
}

function applicationReturnPath(value: unknown, redirect: URL): string | null {
  if (typeof value !== "string") return null;
  const shell = parseApplicationLocation(redirect.pathname)?.mode;
  if (!shell) return null;
  try {
    const url = new URL(value, redirect.origin);
    if (url.origin !== redirect.origin || url.username || url.password ||
        (url.pathname !== `/${shell}` && !url.pathname.startsWith(`/${shell}/`))) return null;
    for (const name of ["code", "state", "iss", "error", "error_description"]) url.searchParams.delete(name);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export async function beginOAuthAuthorization(config: OAuthWebConfig, fetcher: typeof fetch = fetch): Promise<void> {
  validateConfig(config);
  const metadata = await discoverAuthorizationServer(config, fetcher);
  const state = randomBase64Url();
  const verifier = randomBase64Url(48);
  const transaction: OAuthTransaction = {
    state, verifier, createdAt: Date.now(),
    returnPath: applicationReturnPath(window.location.href, new URL(config.redirectUri)),
  };
  sessionStorage.setItem(TRANSACTION_KEY, JSON.stringify(transaction));
  const authorizationUrl = trustedHttpsUrl(metadata.authorization_endpoint, "Authorization endpoint");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("scope", config.scopes.join(" "));
  authorizationUrl.searchParams.set("resource", config.apiAudience);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", await challengeFor(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  window.location.assign(authorizationUrl.toString());
}

export async function completeOAuthAuthorization(
  config: OAuthWebConfig,
  callbackUrl = window.location.href,
  fetcher: typeof fetch = fetch,
): Promise<{ accessToken: string; returnPath: string } | null> {
  validateConfig(config);
  const callback = new URL(callbackUrl);
  const expected = trustedHttpsUrl(config.redirectUri, "Redirect URI");
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) return null;
  const code = oneSearchParam(callback, "code");
  const returnedState = oneSearchParam(callback, "state");
  if (!code && !returnedState && !callback.searchParams.has("error")) return null;

  const raw = sessionStorage.getItem(TRANSACTION_KEY);
  sessionStorage.removeItem(TRANSACTION_KEY);
  let transaction: OAuthTransaction | null = null;
  try { transaction = raw ? JSON.parse(raw) as OAuthTransaction : null; } catch { transaction = null; }
  if (!transaction || typeof transaction.state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(transaction.state) ||
      typeof transaction.verifier !== "string" || !/^[A-Za-z0-9_-]{64}$/u.test(transaction.verifier) ||
      !returnedState || returnedState !== transaction.state ||
      !Number.isFinite(transaction.createdAt) || Date.now() - transaction.createdAt > TRANSACTION_MAX_AGE_MS ||
      Date.now() < transaction.createdAt) {
    throw new Error("OAuth state validation failed. Start sign-in again.");
  }
  const providerError = oneSearchParam(callback, "error");
  if (providerError) throw new Error("The identity provider did not complete sign-in.");
  if (!code) throw new Error("The identity provider did not return an authorization code.");

  const metadata = await discoverAuthorizationServer(config, fetcher);
  if (oneSearchParam(callback, "iss") !== config.issuer) throw new Error("OAuth issuer validation failed. Start sign-in again.");
  const tokenEndpoint = trustedHttpsUrl(metadata.token_endpoint, "Token endpoint");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: transaction.verifier,
    resource: config.apiAudience,
  });
  const response = await fetcher(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Token exchange failed. Retry sign-in when the identity provider is available.");
  const result: unknown = await response.json().catch(() => null);
  if (!result || typeof result !== "object") throw new Error("The token response was invalid.");
  const token = result as Record<string, unknown>;
  if (typeof token.access_token !== "string" || !token.access_token ||
      typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer" ||
      typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error("The provider did not return a usable API bearer access token.");
  }
  return {
    accessToken: token.access_token,
    returnPath: applicationReturnPath(transaction.returnPath, expected) ?? `${callback.pathname}${callback.hash}`,
  };
}

/** Resolve only API paths to the configured HTTPS API origin. */
export function apiRequestUrl(path: string, apiOrigin?: string, pageOrigin?: string): string {
  if (!path.startsWith("/api/")) throw new Error("Only Codexia API paths may use the API origin.");
  if (!apiOrigin) return path;
  const api = trustedHttpsUrl(apiOrigin, "API origin");
  if (api.pathname !== "/" || api.search || api.hash) throw new Error("API origin must contain only an origin.");
  const page = pageOrigin ? new URL(pageOrigin) : typeof window !== "undefined" ? window.location : undefined;
  if (page && api.origin === page.origin) return path;
  return new URL(path, api.origin).toString();
}
