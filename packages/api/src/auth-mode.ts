export type StandaloneAuthMode = "token" | "better-auth";

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
