import type { ResponseGuard } from "./api-response";

type Request = <T>(guard: ResponseGuard<T>, path: string, init: RequestInit) => Promise<T>;

interface GeneratedFetchOptions extends RequestInit {
  request?: Request;
  schema?: { safeParse(value: unknown): { success: boolean } };
}

export function generatedHttpFetch<T>(
  path: string,
  { request, schema, ...init }: GeneratedFetchOptions,
): Promise<T> {
  if (!request || !schema) throw new TypeError("A generated HTTP request requires the API transport and response schema");
  // The API response boundary preserves additive fields after validation.
  return request((value): value is T => schema.safeParse(value).success, path, init);
}
