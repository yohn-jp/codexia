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
