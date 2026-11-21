import { authClient } from "./auth-client";

export interface OAuthConsentContext {
  clientName: string | null;
  requestedScopes: string[];
  /** Redirect URI bound to the authorization request verified by the API. */
  redirectUri: string;
}

export interface OAuthConsentContinuation {
  redirect: true;
  url: string;
}

/** Parse only the server-verified consent context, never the browser's signed query. */
export function parseOAuthConsentContext(value: unknown): OAuthConsentContext {
  if (!value || typeof value !== "object") throw new Error("Authorization context is unavailable.");
  const record = value as Record<string, unknown>;
  const client = record.client;
  const clientName = client && typeof client === "object" && typeof (client as Record<string, unknown>).name === "string"
    ? (client as Record<string, string>).name.trim()
    : null;
  const requestedScopes = record.requestedScopes;
  if (!Array.isArray(requestedScopes) || requestedScopes.some((scope) => typeof scope !== "string" || !scope.trim()) ||
      new Set(requestedScopes).size !== requestedScopes.length) {
    throw new Error("Authorization context is invalid.");
  }
  if (typeof record.redirectUri !== "string" || !record.redirectUri.trim()) {
    throw new Error("Authorization context is missing its registered callback.");
  }
  let redirect: URL;
  try { redirect = new URL(record.redirectUri); }
  catch { throw new Error("Authorization context contains an invalid callback."); }
  if (redirect.username || redirect.password || redirect.hash) {
    throw new Error("Authorization context contains an invalid callback.");
  }
  return { clientName: clientName || null, requestedScopes: requestedScopes as string[], redirectUri: redirect.toString() };
}

const IDENTITY_SCOPES = new Set(["openid", "email", "profile", "offline_access"]);
const MCP_SCOPES = new Set(["mcp:read", "mcp:compute", "mcp:propose"]);

export function canApproveOAuthConsent(context: OAuthConsentContext): boolean {
  if (!context.clientName || !context.requestedScopes.includes("openid")) return false;
  const owner = context.requestedScopes.includes("codexia:api");
  const mcp = context.requestedScopes.some((scope) => MCP_SCOPES.has(scope));
  if (owner === mcp) return false;
  return context.requestedScopes.every((scope) => IDENTITY_SCOPES.has(scope) ||
    (owner ? scope === "codexia:api" : MCP_SCOPES.has(scope)));
}

export async function loadOAuthConsentContext(): Promise<OAuthConsentContext> {
  const result = await authClient.$fetch("/oauth2/consent-context", { method: "POST", body: {} });
  if (result.error) throw new Error("認可内容をサーバーで確認できませんでした。");
  return parseOAuthConsentContext(result.data);
}

export async function submitOAuthConsent(accept: boolean): Promise<OAuthConsentContinuation> {
  const result = await authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept } });
  if (result.error || !result.data || typeof result.data !== "object") throw new Error("認可結果を確認できませんでした。");
  const value = result.data as Record<string, unknown>;
  if (value.redirect !== true || typeof value.url !== "string" || !value.url) throw new Error("認可の継続先が無効です。");
  return { redirect: true, url: value.url };
}

const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  "javascript:", "data:", "file:", "blob:", "about:", "vbscript:", "chrome:", "chrome-extension:",
]);

/** A consent redirect can be a same-origin step or the exact callback
 * bound to the verified, server-signed OAuth authorization request.
 */
export function sameOriginOAuthContinuation(value: string, pageOrigin: string, registeredRedirectUri?: string): string {
  const page = new URL(pageOrigin);
  const target = new URL(value, page.origin);
  const invalid = () => new Error("認可の継続先が登録済みクライアントと一致しません。");
  if (target.username || target.password || target.hash) throw invalid();
  if (target.origin === page.origin) return target.toString();
  let registered: URL;
  try { registered = new URL(registeredRedirectUri ?? ""); }
  catch { throw invalid(); }
  if (target.protocol !== registered.protocol || target.host !== registered.host || target.pathname !== registered.pathname ||
      FORBIDDEN_REDIRECT_SCHEMES.has(target.protocol) ||
      (target.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) throw invalid();
  for (const [name, queryValue] of registered.searchParams) {
    if (!target.searchParams.getAll(name).includes(queryValue)) throw invalid();
  }
  return target.toString();
}
