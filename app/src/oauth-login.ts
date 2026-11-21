const UPSTREAM_PROVIDER_ID = "workspace-oidc";

/** The Better Auth login redirect carries an opaque, signed OAuth authorization request. */
export function hasSignedOAuthPrompt(search: string): boolean {
  try {
    const params = new URLSearchParams(search);
    const single = (name: string) => {
      const values = params.getAll(name);
      return values.length === 1 && Boolean(values[0]);
    };
    return single("sig") && single("exp") && single("client_id") && single("redirect_uri") && single("state");
  } catch {
    return false;
  }
}

/** Returns the fixed login page with its original opaque authorization query intact. */
export function oauthLoginCallbackURL(search: string): string {
  if (!search.startsWith("?") || !hasSignedOAuthPrompt(search)) {
    throw new Error("The authorization request is missing or invalid.");
  }
  return `/oauth/login${search}`;
}

/** Continues only to the fixed consent route; the server verifies this opaque query before display or approval. */
export function oauthConsentContinuationURL(search: string): string {
  if (!search.startsWith("?") || !hasSignedOAuthPrompt(search)) {
    throw new Error("The authorization request is missing or invalid.");
  }
  return `/oauth/consent${search}`;
}

/** Starts upstream OIDC while preserving Better Auth's signed request across the provider callback. */
export async function continueOAuthLogin(client: {
  signIn: { social(input: { provider: string; callbackURL: string }): Promise<{ error?: unknown } | unknown> };
}, authorizationSearch: string): Promise<void> {
  const result = await client.signIn.social({
    provider: UPSTREAM_PROVIDER_ID,
    callbackURL: oauthLoginCallbackURL(authorizationSearch),
  });
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error("Sign-in could not be started. Retry when the identity provider is available.");
  }
}
