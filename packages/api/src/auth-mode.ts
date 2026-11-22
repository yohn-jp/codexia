export type StandaloneAuthMode = "token" | "better-auth";

export interface BetterAuthOidcSettings {
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
}

/** Return the optional OIDC provider settings only when its complete tuple is configured. */
export function resolveBetterAuthOidcSettings(values: BetterAuthOidcSettings): BetterAuthOidcSettings {
  const configured = [values.oidcIssuer, values.oidcClientId, values.oidcClientSecret]
    .filter((value) => value !== undefined).length;
  if (configured === 0) return {};
  if (configured !== 3) {
    throw new Error("Better Auth OIDC settings require CODEXIA_OIDC_ISSUER, CODEXIA_OIDC_CLIENT_ID, and CODEXIA_OIDC_CLIENT_SECRET together");
  }
  return {
    oidcIssuer: values.oidcIssuer!,
    oidcClientId: values.oidcClientId!,
    oidcClientSecret: values.oidcClientSecret!,
  };
}

/** Resolve the standalone auth mode without allowing Better Auth inputs to be ignored. */
export function resolveStandaloneAuthMode(
  value: string | undefined,
  betterAuthConfigured: boolean,
): StandaloneAuthMode {
  if (value === undefined) {
    if (betterAuthConfigured) {
      throw new Error("CODEXIA_AUTH_MODE=better-auth is required when Better Auth settings are present");
    }
    return "token";
  }
  if (value !== "token" && value !== "better-auth") {
    throw new Error("CODEXIA_AUTH_MODE must be token or better-auth");
  }
  if (value === "token" && betterAuthConfigured) {
    throw new Error("Better Auth settings are present with CODEXIA_AUTH_MODE=token; refusing implicit token fallback");
  }
  if (value === "better-auth" && !betterAuthConfigured) {
    throw new Error("CODEXIA_AUTH_MODE=better-auth requires complete Better Auth settings");
  }
  return value;
}
