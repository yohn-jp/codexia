import { CALLBACK_URI, NATIVE_OAUTH_SCOPES } from "./constants.mjs";

export { CALLBACK_URI };

export function nativeApiOrigin(env) {
  if (env.VITE_CODEXIA_API_ORIGIN === undefined || env.VITE_CODEXIA_API_ORIGIN === "") return null;
  return parseApiOrigin(env.VITE_CODEXIA_API_ORIGIN);
}

export function nativeOAuthConfig(env) {
  const clientId = env.VITE_CODEXIA_OAUTH_IOS_CLIENT_ID;
  if (clientId === undefined || clientId === "") return null;
  if (typeof clientId !== "string" || !clientId.trim()) throw new TypeError("A native iOS public client ID must be configured.");

  const apiOrigin = nativeApiOrigin(env) ?? parseApiOrigin(undefined);
  const audienceValue = env.VITE_CODEXIA_API_AUDIENCE?.trim() || `${apiOrigin.slice(0, -1)}/api`;
  const apiAudience = requireHttpsUrl(audienceValue, "API audience");
  const issuer = new URL("/api/auth", apiOrigin).toString().replace(/\/$/u, "");

  return Object.freeze({
    apiOrigin,
    apiAudience,
    issuer,
    authorizationEndpoint: new URL("/api/auth/oauth2/authorize", apiOrigin).toString(),
    tokenEndpoint: new URL("/api/auth/oauth2/token", apiOrigin).toString(),
    clientId: clientId.trim(),
    redirectUri: CALLBACK_URI,
    scopes: NATIVE_OAUTH_SCOPES,
  });
}

function parseApiOrigin(value) {
  const url = requireHttpsUrl(value, "explicit HTTPS API origin");
  const parsed = new URL(url);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("Native API origin must be an HTTPS origin without path, query, or fragment.");
  }
  return parsed.toString();
}

function requireHttpsUrl(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be an absolute HTTPS URL.`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${label} must be an absolute HTTPS URL.`); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError(`${label} must be an absolute HTTPS URL without credentials or a fragment.`);
  }
  return parsed.toString();
}
