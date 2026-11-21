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

/** Starts the configured upstream provider flow and lets the official plugin carry the signed request. */
export async function continueOAuthLogin(client: {
  signIn: { social(input: { provider: string; callbackURL: string }): Promise<{ error?: unknown } | unknown> };
}): Promise<void> {
  const result = await client.signIn.social({
    provider: UPSTREAM_PROVIDER_ID,
    callbackURL: "/oauth/login",
  });
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error("Sign-in could not be started. Retry when the identity provider is available.");
  }
}
