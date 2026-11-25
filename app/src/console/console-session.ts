import { ownerSessionConfirmPost } from "../generated/http/client";
import { ApiError } from "../api-error";

export type OwnerSessionState = "owner" | "unauthorized" | "forbidden" | "unavailable";

/** Confirms the dedicated Better Auth owner cookie; it never sends an API bearer. */
export async function checkOwnerSession(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OwnerSessionState> {
  let body: unknown;
  try {
    body = await ownerSessionConfirmPost({}, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
      transport: { auth: "same-origin" },
      fetcher,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return "unauthorized";
    if (error instanceof ApiError && error.status === 403) return "forbidden";
    return "unavailable";
  }
  return body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).length === 1 && (body as Record<string, unknown>).authenticated === true ? "owner" : "unavailable";
}
