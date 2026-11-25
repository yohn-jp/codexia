import { apiRequestUrl } from "./oauth";
import { ApiError, readApiResponse, type ApiResponseGuard } from "./api-error";

export type ApiTransportAuth = "api" | "same-origin" | "anonymous";

/** Route-specific authentication policy passed through generated Orval options. */
export interface ApiTransportPolicy {
  auth: ApiTransportAuth;
}

export interface NativeApiSession {
  apiOrigin: string | null;
  accessTokenFor(requestUrl: string): Promise<string | null>;
  fetchRequest(requestUrl: string, init: RequestInit): Promise<Response>;
}

export class DocumentDepartureError extends DOMException {
  constructor() {
    super("The document is leaving.", "AbortError");
  }
}

let oauthAccessToken: string | undefined;
let nativeApiSession: NativeApiSession | undefined;
const configuredApiOrigin = (import.meta as ImportMeta & { env?: { VITE_CODEXIA_API_ORIGIN?: string } }).env?.VITE_CODEXIA_API_ORIGIN;
let documentDeparting = false;
let documentLifecycle = 0;

function markDocumentDeparting(): void {
  if (documentDeparting) return;
  documentDeparting = true;
  documentLifecycle += 1;
}

function resumeDocument(): void {
  if (!documentDeparting) return;
  documentDeparting = false;
  documentLifecycle += 1;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", event => {
    queueMicrotask(() => {
      if (!event.defaultPrevented) markDocumentDeparting();
    });
  }, { capture: true });
  window.addEventListener("pagehide", markDocumentDeparting, { capture: true });
  window.addEventListener("pageshow", resumeDocument, { capture: true });
}

function assertDocumentCanStartRequest(init: RequestInit): void {
  if (documentDeparting && init.keepalive !== true) throw new DocumentDepartureError();
}

function hasLeftDocumentLifecycle(lifecycle: number): boolean {
  return documentDeparting || documentLifecycle !== lifecycle;
}

async function withDocumentDepartureClassification<T>(lifecycle: number, init: RequestInit, operation: () => Promise<T>): Promise<T> {
  try {
    const result = await operation();
    if (hasLeftDocumentLifecycle(lifecycle) && init.keepalive !== true) throw new DocumentDepartureError();
    return result;
  } catch (error) {
    if (hasLeftDocumentLifecycle(lifecycle) && init.keepalive !== true) throw new DocumentDepartureError();
    throw error;
  }
}

function effectivePolicy(path: string, policy: ApiTransportPolicy): ApiTransportPolicy {
  // Better Auth and the Codexia auth adapter must never receive API/native OAuth credentials.
  if (path.startsWith("/api/auth/") && policy.auth === "api") {
    throw new ApiError("Auth routes require an explicit cookie or anonymous policy.", 403, "AUTH_TRANSPORT_POLICY_REQUIRED");
  }
  return policy;
}

async function fetchApiRequest(
  path: string,
  init: RequestInit,
  policy: ApiTransportPolicy,
  fetcher: typeof fetch,
): Promise<Response> {
  assertDocumentCanStartRequest(init);
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  if (policy.auth === "anonymous") {
    headers.delete("Authorization");
    return fetcher(apiRequestUrl(path), { ...init, headers, credentials: "omit" });
  }

  if (policy.auth === "same-origin") {
    headers.delete("Authorization");
    return fetcher(apiRequestUrl(path), { ...init, headers, credentials: "same-origin" });
  }

  if (nativeApiSession) {
    const configuredOrigin = nativeApiSession.apiOrigin;
    if (!configuredOrigin) throw new ApiError("Native API origin is not configured.", 503, "NATIVE_API_ORIGIN_MISSING");
    const originUrl = new URL(configuredOrigin);
    if (
      originUrl.protocol !== "https:" || originUrl.pathname !== "/" || originUrl.search || originUrl.hash ||
      originUrl.username || originUrl.password
    ) throw new ApiError("Native API origin is invalid.", 503, "NATIVE_API_ORIGIN_INVALID");
    const requestUrl = new URL(apiRequestUrl(path, originUrl.origin), originUrl.origin);
    if (requestUrl.origin !== originUrl.origin || !requestUrl.pathname.startsWith("/api/")) {
      throw new ApiError("Native API request escaped its configured origin.", 503, "NATIVE_API_ORIGIN_MISMATCH");
    }
    const accessToken = await nativeApiSession.accessTokenFor(requestUrl.toString());
    if (accessToken !== null && (typeof accessToken !== "string" || !accessToken)) {
      throw new ApiError("Native authentication returned an invalid API token.", 503, "NATIVE_API_TOKEN_INVALID");
    }
    headers.delete("Authorization");
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return nativeApiSession.fetchRequest(requestUrl.toString(), { ...init, headers, credentials: "omit" });
  }

  if (oauthAccessToken) headers.set("Authorization", `Bearer ${oauthAccessToken}`);
  return fetcher(apiRequestUrl(path, configuredApiOrigin), {
    ...init,
    headers,
    // Bearer and ambient cookie credentials are never sent together.
    credentials: oauthAccessToken ? "omit" : "same-origin",
  });
}

/** Send an API request and validate its successful JSON body. Additive fields are retained. */
export async function requestApi<T>(
  guard: ApiResponseGuard<T>,
  path: string,
  init: RequestInit = {},
  policy: ApiTransportPolicy = { auth: "api" },
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const lifecycle = documentLifecycle;
  const routePolicy = effectivePolicy(path, policy);
  return withDocumentDepartureClassification(lifecycle, init, async () =>
    readApiResponse(await fetchApiRequest(path, init, routePolicy, fetcher), guard));
}

/** Fetch a response for non-JSON operations while retaining shared auth and lifecycle behavior. */
export function requestApiResponse(
  path: string,
  init: RequestInit = {},
  policy: ApiTransportPolicy = { auth: "api" },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const lifecycle = documentLifecycle;
  const routePolicy = effectivePolicy(path, policy);
  return withDocumentDepartureClassification(lifecycle, init, () => fetchApiRequest(path, init, routePolicy, fetcher));
}

/** Store an API access token only in the current JavaScript runtime. */
export function setOAuthAccessToken(token: string | null): void {
  oauthAccessToken = token ?? undefined;
}

/** Install an explicit native HTTPS API transport; never use WebView cookies for API data. */
export function configureNativeApiSession(session: NativeApiSession): void {
  if (!session || typeof session.accessTokenFor !== "function" || typeof session.fetchRequest !== "function") {
    throw new TypeError("Native API session transport is invalid.");
  }
  if (session.apiOrigin !== null) {
    const origin = new URL(session.apiOrigin);
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
      throw new TypeError("Native API origin must be an explicit HTTPS origin.");
    }
    apiRequestUrl("/api/session", origin.origin);
  }
  oauthAccessToken = undefined;
  nativeApiSession = session;
}

/** Return API request routing to the normal browser configuration. */
export function clearNativeApiSession(): void {
  nativeApiSession = undefined;
  oauthAccessToken = undefined;
}

export function hasNativeApiSession(): boolean {
  return nativeApiSession !== undefined;
}

/** Raw SSE retains the server response body and the native unsupported boundary. */
export async function requestApiEventStream(path: string, signal: AbortSignal): Promise<Response> {
  if (nativeApiSession) {
    throw new ApiError("Native job event streaming is unavailable; use the Job Inbox refresh action.", 501, "NATIVE_STREAM_UNSUPPORTED");
  }
  const init = { headers: { Accept: "text/event-stream" }, signal };
  const lifecycle = documentLifecycle;
  const policy = effectivePolicy(path, { auth: "api" });
  return withDocumentDepartureClassification(lifecycle, init, async () => {
    const response = await fetchApiRequest(path, init, policy, fetch);
    if (!response.ok) {
      let body: unknown = null;
      try { body = await response.json(); } catch { /* preserve the status and fallback error below */ }
      const details = body && typeof body === "object" ? body as Record<string, unknown> : {};
      throw new ApiError(
        typeof details.error === "string" ? details.error : `Request failed (${response.status})`,
        response.status,
        typeof details.code === "string" ? details.code : "REQUEST_FAILED",
      );
    }
    if (!response.body) throw new ApiError("Job event stream is unavailable", response.status, "STREAM_UNAVAILABLE");
    return response;
  });
}
