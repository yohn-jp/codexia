import type { ApiTransportPolicy } from "./api-transport";
import { requestApi, requestApiResponse } from "./api-transport";

export interface GeneratedHttpOptions extends RequestInit {
  transport?: ApiTransportPolicy;
  request?: ApiGeneratedRequest;
  fetcher?: typeof fetch;
  responseMode?: "json" | "raw";
  schema?: { safeParse(value: unknown): { success: boolean } };
}

export type ApiGeneratedRequest = <T>(guard: (value: unknown) => value is T, path: string, init: RequestInit) => Promise<T>;

/** Orval mutator: validate generated JSON schemas through the shared API boundary. */
export function generatedHttpFetch<T>(path: string, { transport, request, fetcher, responseMode, schema, ...init }: GeneratedHttpOptions): Promise<T> {
  if (responseMode === "raw") {
    return (request
      ? request((value): value is T => value instanceof Response, path, init)
      : requestApiResponse(path, init, transport, fetcher)) as Promise<T>;
  }
  if (!schema) throw new TypeError("A generated HTTP request requires a response schema");
  const guard = (value: unknown): value is T => schema.safeParse(value).success;
  return request ? request(guard, path, init) : requestApi<T>(guard, path, init, transport, fetcher);
}
