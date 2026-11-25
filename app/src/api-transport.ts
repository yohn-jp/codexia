import { ApiError, type ApiResponseGuard, readApiResponse } from './api-error';
import { apiRequestUrl } from './oauth';

export type ApiTransportAuth = 'api' | 'same-origin' | 'anonymous';

/** Route-specific authentication policy passed through generated Orval options. */
export interface ApiTransportPolicy {
  auth: ApiTransportAuth;
}

export class DocumentDepartureError extends DOMException {
  constructor() {
    super('The document is leaving.', 'AbortError');
  }
}

let oauthAccessToken: string | undefined;
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

if (typeof window !== 'undefined') {
  window.addEventListener(
    'beforeunload',
    event => {
      queueMicrotask(() => {
        if (!event.defaultPrevented) markDocumentDeparting();
      });
    },
    { capture: true },
  );
  window.addEventListener('pagehide', markDocumentDeparting, { capture: true });
  window.addEventListener('pageshow', resumeDocument, { capture: true });
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
  // Better Auth and the Codexia auth adapter must never receive API OAuth credentials.
  if (path.startsWith('/api/auth/') && policy.auth === 'api') {
    throw new ApiError('Auth routes require an explicit cookie or anonymous policy.', 403, 'AUTH_TRANSPORT_POLICY_REQUIRED');
  }
  return policy;
}

async function fetchApiRequest(path: string, init: RequestInit, policy: ApiTransportPolicy, fetcher: typeof fetch): Promise<Response> {
  assertDocumentCanStartRequest(init);
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  if (policy.auth === 'anonymous') {
    headers.delete('Authorization');
    return fetcher(apiRequestUrl(path), { ...init, headers, credentials: 'omit' });
  }

  if (policy.auth === 'same-origin') {
    headers.delete('Authorization');
    return fetcher(apiRequestUrl(path), { ...init, headers, credentials: 'same-origin' });
  }

  if (oauthAccessToken) headers.set('Authorization', `Bearer ${oauthAccessToken}`);
  return fetcher(apiRequestUrl(path, configuredApiOrigin), {
    ...init,
    headers,
    // Bearer and ambient cookie credentials are never sent together.
    credentials: oauthAccessToken ? 'omit' : 'same-origin',
  });
}

/** Send an API request and validate its successful JSON body. Additive fields are retained. */
export async function requestApi<T>(
  guard: ApiResponseGuard<T>,
  path: string,
  init: RequestInit = {},
  policy: ApiTransportPolicy = { auth: 'api' },
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const lifecycle = documentLifecycle;
  const routePolicy = effectivePolicy(path, policy);
  return withDocumentDepartureClassification(lifecycle, init, async () =>
    readApiResponse(await fetchApiRequest(path, init, routePolicy, fetcher), guard),
  );
}

/** Accept exactly a 204 response for operations whose runtime contract is no-content. */
export function requestApiNoContent(
  path: string,
  init: RequestInit = {},
  policy: ApiTransportPolicy = { auth: 'api' },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const lifecycle = documentLifecycle;
  const routePolicy = effectivePolicy(path, policy);
  return withDocumentDepartureClassification(lifecycle, init, async () =>
    readApiResponse(await fetchApiRequest(path, init, routePolicy, fetcher), (value): value is undefined => value === undefined),
  );
}

/** Store an API access token only in the current JavaScript runtime. */
export function setOAuthAccessToken(token: string | null): void {
  oauthAccessToken = token ?? undefined;
}

/** Raw SSE retains request options, response body, errors and lifecycle. */
export async function requestApiEventStream(
  path: string,
  init: RequestInit = {},
  policy: ApiTransportPolicy = { auth: 'api' },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'text/event-stream');
  const streamInit = { ...init, headers };
  const lifecycle = documentLifecycle;
  const routePolicy = effectivePolicy(path, policy);
  return withDocumentDepartureClassification(lifecycle, streamInit, async () => {
    const response = await fetchApiRequest(path, streamInit, routePolicy, fetcher);
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        /* preserve the status and fallback error below */
      }
      const details = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      throw new ApiError(
        typeof details.error === 'string' ? details.error : `Request failed (${response.status})`,
        response.status,
        typeof details.code === 'string' ? details.code : 'REQUEST_FAILED',
      );
    }
    if (!response.body) throw new ApiError('Job event stream is unavailable', response.status, 'STREAM_UNAVAILABLE');
    return response;
  });
}
