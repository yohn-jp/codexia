import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload } from "jose";

const ALLOWED_ALGORITHMS = ["ES256", "RS256"] as const;
const JWKS_TIMEOUT_MS = 3_000;

export interface OAuthOwnerOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly ownerSubject: string;
  readonly requiredScopes: readonly string[];
  readonly allowedClientIds?: readonly string[];
  readonly verifyActiveToken?: (token: string) => Promise<boolean>;
  /** Permits plain HTTP loopback only in test processes for synthetic IdP fixtures. */
  readonly allowInsecureLoopbackForTests?: boolean;
  readonly fetch?: typeof fetch;
}

export interface OAuthPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: readonly string[];
}

export class OAuthAuthenticationError extends Error {
  constructor(readonly status: 401 | 403 | 503, readonly code: string, message: string) {
    super(message);
    this.name = "OAuthAuthenticationError";
  }
}

function assertHttpsEndpoint(value: string, label: string, allowInsecureLoopbackForTests = false): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${label} must be an absolute HTTPS URL`); }
  const testLoopback = allowInsecureLoopbackForTests && process.env.NODE_ENV === "test" && url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!testLoopback && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new Error(`${label} must be an absolute HTTPS URL without credentials or a fragment`);
  }
  return url;
}

function tokenScopes(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === "string") return raw.split(/\s+/u).filter(Boolean);
  if (Array.isArray(raw) && raw.every((scope) => typeof scope === "string")) return raw;
  return [];
}

export function createOAuthOwnerAuthenticator(options: OAuthOwnerOptions): (token: string) => Promise<OAuthPrincipal> {
  assertHttpsEndpoint(options.issuer, "OAuth issuer", options.allowInsecureLoopbackForTests);
  assertHttpsEndpoint(options.jwksUrl, "OAuth JWKS URL", options.allowInsecureLoopbackForTests);
  if (!options.audience.trim() || options.audience !== options.audience.trim() ||
      !options.ownerSubject.trim() || !options.requiredScopes.length ||
      options.requiredScopes.some((scope) => !/^[A-Za-z0-9:._/-]{1,128}$/u.test(scope))) {
    throw new Error("OAuth audience, owner subject and required scopes must be configured");
  }
  const resolveKey = createRemoteJWKSet(new URL(options.jwksUrl), {
    timeoutDuration: JWKS_TIMEOUT_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: 300_000,
    ...(options.fetch ? { [customFetch]: options.fetch } : {}),
  });
  return async (token: string): Promise<OAuthPrincipal> => {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, resolveKey, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: [...ALLOWED_ALGORITHMS],
        typ: "at+jwt",
        clockTolerance: 5,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id", "azp"],
      });
      if (protectedHeader.typ !== "at+jwt" || typeof payload.sub !== "string" || !payload.sub ||
          typeof payload.iat !== "number" || payload.iat > Math.floor(Date.now() / 1000) + 5 ||
          typeof payload.client_id !== "string" || !payload.client_id || payload.azp !== payload.client_id ||
          typeof payload.jti !== "string" || !payload.jti) {
        throw new Error("invalid access token profile");
      }
      const scopes = tokenScopes(payload);
      if (!options.requiredScopes.every((scope) => scopes.includes(scope))) {
        throw new OAuthAuthenticationError(403, "OAUTH_SCOPE_REQUIRED", "Access token does not grant the required API scope");
      }
      if (payload.sub !== options.ownerSubject) {
        throw new OAuthAuthenticationError(403, "OAUTH_OWNER_REQUIRED", "Authenticated identity is not configured as the standalone owner");
      }
      if (options.allowedClientIds && !options.allowedClientIds.includes(payload.client_id)) {
        throw new OAuthAuthenticationError(403, "OAUTH_CLIENT_NOT_ALLOWED", "OAuth client is not configured for owner access");
      }
      if (options.verifyActiveToken && !await options.verifyActiveToken(token)) {
        throw new OAuthAuthenticationError(401, "OAUTH_TOKEN_INACTIVE", "OAuth access token is inactive or its login session was revoked");
      }
      return { issuer: options.issuer, subject: payload.sub, scopes };
    } catch (error) {
      if (error instanceof OAuthAuthenticationError) throw error;
      if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWTClaimValidationFailed ||
          error instanceof errors.JWTExpired || error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid ||
          error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JOSEAlgNotAllowed) {
        throw new OAuthAuthenticationError(401, "OAUTH_TOKEN_INVALID", "OAuth access token is invalid or unverifiable");
      }
      throw new OAuthAuthenticationError(503, "OAUTH_JWKS_UNAVAILABLE", "OAuth signing keys are unavailable");
    }
  };
}
