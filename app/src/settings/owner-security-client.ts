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

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function parseIdentity(value: unknown): OwnerIdentity {
  if (!isRecord(value) || !isRecord(value.provider) || !Array.isArray(value.clients) || !Array.isArray(value.consents)) {
    throw new Error('Invalid owner identity');
  }
  const status = value.provider.status;
  if (status !== 'not-configured' && status !== 'operator-configured-unverified') throw new Error('Invalid owner provider status');
  const clients = value.clients.map((row: unknown): OwnerOAuthClient => {
    if (
      !isRecord(row) ||
      typeof row.clientId !== 'string' ||
      !row.clientId ||
      typeof row.name !== 'string' ||
      !stringList(row.scopes) ||
      !stringList(row.redirectUris) ||
      typeof row.disabled !== 'boolean'
    ) {
      throw new Error('Invalid owner OAuth client');
    }
    return { clientId: row.clientId, name: row.name, scopes: row.scopes, redirectUris: row.redirectUris, disabled: row.disabled };
  });
  const consents = value.consents.map((row: unknown): OwnerConsent => {
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      !row.id ||
      typeof row.clientId !== 'string' ||
      !row.clientId ||
      !stringList(row.scopes) ||
      typeof row.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(row.updatedAt)) ||
      typeof row.revision !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(row.revision)
    ) {
      throw new Error('Invalid owner consent');
    }
    return { id: row.id, clientId: row.clientId, scopes: row.scopes, updatedAt: row.updatedAt, revision: row.revision };
  });
  return { provider: { status }, clients, consents };
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

export async function fetchOwnerIdentity(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OwnerIdentity> {
  let response: Response;
  try {
    response = await fetcher('/api/auth/codexia/owner-security/identity', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      mode: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new Error('Owner identity could not be loaded');
  }
  if (!response.ok) throw await readError(response);
  return parseIdentity(await response.json());
}

export async function revokeOwnerConsent(consent: OwnerConsent, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher('/api/auth/codexia/owner-security/revoke-consent', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    mode: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ id: consent.id, clientId: consent.clientId, scopes: consent.scopes, revision: consent.revision }),
  });
  if (!response.ok) throw await readError(response);
  const receipt: unknown = await response.json();
  if (!isRecord(receipt) || receipt.consentRemoved !== true || receipt.grantRevoked !== true) {
    throw new TypeError('Owner security did not confirm the grant withdrawal');
  }
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
