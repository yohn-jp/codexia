export interface OwnerConsent {
  readonly id: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export async function fetchOwnerConsents(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OwnerConsent[]> {
  const response = await fetcher("/api/auth/oauth2/get-consents", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error("Owner consents could not be loaded");
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("Invalid owner consents");
  return rows.map((row: unknown) => {
    if (!row || typeof row !== "object" || !("id" in row) || !("clientId" in row) || !("scopes" in row) ||
        typeof row.id !== "string" || !row.id || typeof row.clientId !== "string" || !row.clientId ||
        !Array.isArray(row.scopes) || !row.scopes.every((scope: unknown) => typeof scope === "string" && scope.length > 0)) {
      throw new Error("Invalid owner consent");
    }
    return { id: row.id, clientId: row.clientId, scopes: row.scopes as string[] };
  });
}

export function outcomeWasUnconfirmed(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof SyntaxError) return true;
  if (error instanceof Error && ["AbortError", "TimeoutError", "NetworkError"].includes(error.name)) return true;
  if (!error || typeof error !== "object" || !("status" in error) || typeof error.status !== "number") return false;
  return error.status === 408 || error.status >= 500;
}

export function confirmAuthMutation(result: unknown, matches: (data: unknown) => boolean): void {
  if (result && typeof result === "object") {
    if ("error" in result && result.error) throw result.error;
    if ("data" in result && matches(result.data)) return;
  }
  throw new TypeError("Better Auth did not confirm the mutation");
}
