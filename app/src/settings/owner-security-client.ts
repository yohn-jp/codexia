import { ApiError } from '../api-error';
import { ownerSecurityIdentityGet, ownerSecurityRevokeConsentPost } from '../generated/http/client';
import type { GeneratedHttpOptions } from '../generated-http-fetch';

export interface OwnerOAuthClient {
  readonly clientId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly redirectUris: readonly string[];
  readonly disabled: boolean;
}

export interface OwnerConsent {
  readonly id: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly updatedAt: string;
  readonly revision: string;
}

export interface OwnerIdentity {
  readonly provider: { readonly status: 'not-configured' | 'operator-configured-unverified' };
  readonly clients: readonly OwnerOAuthClient[];
  readonly consents: readonly OwnerConsent[];
}

export class OwnerSecurityRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string, message?: string) {
    super(message || code || `Owner security request failed (${status})`);
    this.name = 'OwnerSecurityRequestError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readError(response: Response): Promise<OwnerSecurityRequestError> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
  const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
  return new OwnerSecurityRequestError(response.status, code, message);
}

function ownerSecurityOptions(fetcher: typeof fetch, signal?: AbortSignal): GeneratedHttpOptions {
  return {
    transport: { auth: 'same-origin' },
    async fetcher(input, init) {
      const response = await fetcher(input, init);
      if (!response.ok) throw await readError(response);
      return response;
    },
    cache: 'no-store',
    redirect: 'error',
    mode: 'same-origin',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  };
}

export async function fetchOwnerIdentity(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OwnerIdentity> {
  try {
    const { provider, clients, consents } = await ownerSecurityIdentityGet(ownerSecurityOptions(fetcher, signal));
    return {
      provider: { status: provider.status },
      clients: clients.map(({ clientId, name, scopes, redirectUris, disabled }) => ({ clientId, name, scopes, redirectUris, disabled })),
      consents: consents.map(({ id, clientId, scopes, updatedAt, revision }) => ({ id, clientId, scopes, updatedAt, revision })),
    };
  } catch (error) {
    if (error instanceof OwnerSecurityRequestError || error instanceof ApiError) throw error;
    throw new Error('Owner identity could not be loaded');
  }
}

export async function revokeOwnerConsent(consent: OwnerConsent, fetcher: typeof fetch = fetch): Promise<void> {
  const { id, clientId, scopes, revision } = consent;
  await ownerSecurityRevokeConsentPost(
    { id, clientId, scopes: [...scopes], revision },
    ownerSecurityOptions(fetcher, AbortSignal.timeout(10_000)),
  );
}

export function outcomeWasUnconfirmed(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof SyntaxError) return true;
  if (error instanceof Error && ['AbortError', 'TimeoutError', 'NetworkError'].includes(error.name)) return true;
  if (!error || typeof error !== 'object' || !('status' in error) || typeof error.status !== 'number') return false;
  return error.status === 408 || error.status >= 500;
}

export function confirmAuthMutation(result: unknown, matches: (data: unknown) => boolean): void {
  if (result && typeof result === 'object') {
    if ('error' in result && result.error) throw result.error;
    if ('data' in result && matches(result.data)) return;
  }
  throw new TypeError('Better Auth did not confirm the mutation');
}
