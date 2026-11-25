/**
 * Cookie-only transport for the public OAuth login capability endpoint.
 * This file deliberately has no dependency on the author API transport, session
 * state, bearer credentials, or native runtime adapters.
 */
export interface GeneratedAuthMethodsOptions extends RequestInit {
  readonly fetcher?: typeof fetch;
  readonly schema?: { safeParse(value: unknown): { success: boolean } };
}

export async function generatedAuthMethodsFetch<T>(path: string, { fetcher, schema, ...init }: GeneratedAuthMethodsOptions): Promise<T> {
  if (path !== '/api/auth/codexia/auth-methods') {
    throw new TypeError(`Unexpected auth methods endpoint: ${path}`);
  }
  if (!schema) throw new TypeError('Generated auth methods schema is required');

  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  headers.delete('authorization');
  const response = await (fetcher ?? fetch)(path, {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
  return readApiResponse<T>(response, (value): value is T => schema.safeParse(value).success);
}

import { readApiResponse } from './api-error';
