export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiResponseGuard<T> = (value: unknown) => value is T;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Decode one successful JSON response while retaining the server's additive fields. */
export function decodeApiResponse<T>(value: unknown, guard: ApiResponseGuard<T>): T {
  if (!guard(value)) throw new ApiError('The server returned an invalid response', 502, 'INVALID_RESPONSE');
  return value;
}

/** Shared JSON response boundary for generated and handwritten API operations. */
export async function readApiResponse<T>(response: Response, guard: ApiResponseGuard<T>): Promise<T> {
  if (response.status === 204) return decodeApiResponse(undefined, guard);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (response.ok) throw new ApiError('The server returned invalid JSON', 502, 'INVALID_RESPONSE');
  }
  if (!response.ok) {
    const details = isRecord(body) ? body : {};
    throw new ApiError(
      typeof details.error === 'string' ? details.error : `Request failed (${response.status})`,
      response.status,
      typeof details.code === 'string' ? details.code : 'REQUEST_FAILED',
    );
  }
  return decodeApiResponse(body, guard);
}
