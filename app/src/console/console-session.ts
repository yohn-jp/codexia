export type OwnerSessionState = "owner" | "unauthorized" | "forbidden" | "unavailable";

export interface ConsoleSessionRequest {
  readonly method: "POST";
  readonly credentials: "same-origin";
  readonly cache: "no-store";
  readonly redirect: "error";
  readonly headers: { readonly accept: "application/json"; readonly "content-type": "application/json" };
  readonly body: "{}";
  readonly signal?: AbortSignal;
}

/** Confirms the dedicated Better Auth owner cookie; it never sends an API bearer. */
export async function checkOwnerSession(
  fetcher: (input: string, init: ConsoleSessionRequest) => Promise<Response> = fetch,
  signal?: AbortSignal,
): Promise<OwnerSessionState> {
  let response: Response;
  try {
    response = await fetcher("/api/auth/codexia/owner-session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
      ...(signal ? { signal } : {}),
    });
  } catch {
    return "unavailable";
  }
  if (response.status === 401) return "unauthorized";
  if (response.status === 403) return "forbidden";
  if (!response.ok) return "unavailable";
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body) &&
        Object.keys(body).length === 1 && (body as Record<string, unknown>).authenticated === true) return "owner";
  } catch {
    // Invalid or incomplete server responses fail closed.
  }
  return "unavailable";
}
