import type { ApiTransportPolicy } from './api-transport';
import { requestApi, requestApiEventStream, requestApiNoContent } from './api-transport';

export interface GeneratedHttpOptions extends RequestInit {
  transport?: ApiTransportPolicy;
  fetcher?: typeof fetch;
  responseMode?: 'json' | 'raw' | 'no-content';
  schema?: { safeParse(value: unknown): { success: boolean } };
}

/** Orval mutator: validate generated JSON schemas through the shared API boundary. */
export function generatedHttpFetch<T>(
  path: string,
  { transport, fetcher, responseMode, schema, ...init }: GeneratedHttpOptions,
): Promise<T> {
  if (responseMode === 'raw') {
    return requestApiEventStream(path, init, transport, fetcher) as Promise<T>;
  }
  if (responseMode === 'no-content') {
    return requestApiNoContent(path, init, transport, fetcher) as Promise<T>;
  }
  if (!schema) throw new TypeError('A generated HTTP request requires a response schema');
  const guard = (value: unknown): value is T => schema.safeParse(value).success;
  return requestApi<T>(guard, path, init, transport, fetcher);
}
