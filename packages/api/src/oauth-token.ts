import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload } from "jose";

const ALLOWED_ALGORITHMS = ["ES256", "RS256"] as const;
const JWKS_TIMEOUT_MS = 3_000;

export interface OAuthAccessTokenClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface OAuthAccessTokenVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  /** Called after strict local JWT verification and policy checks. Must perform online active-token validation. */
  readonly verifyActiveToken: (token: string) => Promise<boolean>;
  readonly fetch?: typeof fetch;
}

export class OAuthTokenVerifierError extends Error {
  constructor(readonly status: 401 | 503, readonly code: string, message: string) {
    super(message);
    this.name = "OAuthTokenVerifierError";
  }
}

function assertHttpsEndpoint(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${label} must be an absolute HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error(`${label} must be an absolute HTTPS URL without credentials, query, or fragment`);
  }
  return url;
}

function tokenScopes(payload: JWTPayload): string[] {
  // RFC 9068 defines `scope` as a space-delimited string. Do not accept
  // provider-specific aliases that can blur the API capability contract.
  const raw = payload.scope;
  if (typeof raw !== "string") return [];
  return [...new Set(raw.split(/\s+/u).filter(Boolean))];
}

function isInvalidJwt(error: unknown): boolean {
  return error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTExpired || error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid ||
    error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JOSEAlgNotAllowed;
}

/** Verify the strict local JWT profile before consulting the online active-token authority. */
export function createOAuthAccessTokenVerifier(options: OAuthAccessTokenVerifierOptions) {
  assertHttpsEndpoint(options.issuer, "OAuth issuer");
  assertHttpsEndpoint(options.audience, "OAuth audience");
  assertHttpsEndpoint(options.jwksUrl, "OAuth JWKS URL");
  const resolveKey = createRemoteJWKSet(new URL(options.jwksUrl), {
    timeoutDuration: JWKS_TIMEOUT_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: 300_000,
    ...(options.fetch ? { [customFetch]: options.fetch } : {}),
  });

  return async (
    token: string,
    validateClaims?: (claims: OAuthAccessTokenClaims) => void,
  ): Promise<OAuthAccessTokenClaims> => {
    let claims: OAuthAccessTokenClaims;
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
        throw new OAuthTokenVerifierError(401, "OAUTH_TOKEN_INVALID", "OAuth access token is invalid or unverifiable");
      }
      claims = { issuer: options.issuer, subject: payload.sub, clientId: payload.client_id, scopes: tokenScopes(payload) };
    } catch (error) {
      if (error instanceof OAuthTokenVerifierError) throw error;
      if (isInvalidJwt(error)) throw new OAuthTokenVerifierError(401, "OAUTH_TOKEN_INVALID", "OAuth access token is invalid or unverifiable");
      throw new OAuthTokenVerifierError(503, "OAUTH_JWKS_UNAVAILABLE", "OAuth signing keys are unavailable");
    }

    // Client/scope admission must happen before the remote call. The remote
    // provider verifies token liveness and session revocation, while local
    // verification above preserves the strict typ/issuer/audience profile.
    validateClaims?.(claims);
    let active: boolean;
    try { active = await options.verifyActiveToken(token); }
    catch {
      throw new OAuthTokenVerifierError(503, "OAUTH_TOKEN_STATUS_UNAVAILABLE", "OAuth access-token status is unavailable");
    }
    if (!active) throw new OAuthTokenVerifierError(401, "OAUTH_TOKEN_INACTIVE", "OAuth access token is inactive or its login session was revoked");
    return claims;
  };
}
