import "@typespec/http";
import "@typespec/openapi";
using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

@tag("auth-adapter") @useAuth(NoAuth)
@extension("x-codexia-principal", "ANON; non-sensitive login capability summary")
@route("/api/auth/codexia/auth-methods") @get @operationId("auth_methods_get")
op getAuthMethods(): AuthMethodsResponse;

@tag("auth-adapter") @useAuth(OwnerSessionCookie)
@extension("x-codexia-principal", "OWNER-SESSION cookie only; exact same-origin Origin required; bearer credentials rejected")
@extension("x-codexia-credential-policy", "Better Auth session cookie is checked against the configured owner subject. The cookie is not an OWNER-API bearer credential.")
@route("/api/auth/codexia/owner-session") @post @operationId("owner_session_confirm_post")
op confirmOwnerSession(
  @header("Origin") origin: string,
  @body body: OwnerSessionRequest,
): OwnerSessionResponse | { @statusCode _: 400; @header("Cache-Control") cacheControl: "no-store"; @body body: ApiError; } |
  { @statusCode _: 401; @header("Cache-Control") cacheControl: "no-store"; @body body: ApiError; } |
  { @statusCode _: 403; @header("Cache-Control") cacheControl: "no-store"; @body body: ApiError; };

model OAuthConsentContextRequest {
  oauth_query: string;
  ...Record<never>;
}

model OAuthConsentRow {
  id: string;
  clientId: string;
  scopes: string[];
  createdAt?: utcDateTime;
  updatedAt?: utcDateTime;
  ...Record<unknown>;
}

model OAuthConsentRowList is Array<OAuthConsentRow>;

@tag("auth-adapter")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-principal", "OWNER-SESSION; same-origin request")
@extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. Runtime requires the Better Auth owner-session cookie; this security representation remains incomplete pending an approved compatibility baseline correction.")
@route("/api/auth/oauth2/consent-context") @post @operationId("auth_consent_context_post")
op getOAuthConsentContext(@body body: OAuthConsentContextRequest): OAuthConsentContextBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 401; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("auth-adapter")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-principal", "OWNER-SESSION; same-origin request")
@extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. Runtime requires the Better Auth owner-session cookie; this security representation remains incomplete pending an approved compatibility baseline correction.")
@extension("x-codexia-runtime-response-deviation", "Runtime serializes the consent list as a top-level array; the approved baseline response body is an object. Keep the published compatibility schema unchanged and use the Codexia desktop response projection metadata for the verified typed array shape until an approved compatibility correction.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/OAuthConsentRowList")
@route("/api/auth/oauth2/get-consents") @get @operationId("auth_list_consents_get")
op listOAuthConsents(): JsonResponse | { @statusCode _: 401; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

model OwnerSecurityIdentity {
  provider: { status: "not-configured" | "operator-configured-unverified"; };
  clients: {
    @minLength(1) clientId: string;
    name: string;
    scopes: OwnerSecurityNonEmptyString[];
    redirectUris: OwnerSecurityNonEmptyString[];
    disabled: boolean;
  }[];
  consents: {
    @minLength(1) id: string;
    @minLength(1) clientId: string;
    scopes: OwnerSecurityNonEmptyString[];
    updatedAt: utcDateTime;
    @pattern("^[A-Za-z0-9_-]{43}$") revision: string;
  }[];
}

model OwnerConsentWithdrawalRequest {
  @minLength(1) id: string;
  @minLength(1) clientId: string;
  @minItems(1) scopes: OwnerSecurityNonEmptyString[];
  @pattern("^[A-Za-z0-9_-]{43}$") revision: string;
  ...Record<never>;
}

@minLength(1)
scalar OwnerSecurityNonEmptyString extends string;

model OwnerConsentWithdrawalReceipt {
  consentRemoved: true;
  grantRevoked: true;
}

model OwnerSecurityError {
  code: string;
  message: string;
}

model OwnerSecurityResponse<Status extends int32, Body> {
  @statusCode statusCode: Status;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: Body;
}

model OwnerSecurityRateLimited {
  @statusCode statusCode: 429;
  @header("Cache-Control") cacheControl: "no-store";
  @header("X-Retry-After") retryAfter: string;
  @body body: { message: string; };
}

alias OwnerSecurityAdmissionFailure =
  | OwnerSecurityResponse<401, OwnerSecurityError>
  | OwnerSecurityResponse<403, OwnerSecurityError | ApiError>
  | OwnerSecurityRateLimited;

@tag("auth-adapter") @useAuth(OwnerSessionCookie)
@extension("x-codexia-principal", "OWNER-SESSION cookie only; same-origin request")
@route("/api/auth/codexia/owner-security/identity") @get @operationId("owner_security_identity_get")
op getOwnerSecurityIdentity():
  | OwnerSecurityResponse<200, OwnerSecurityIdentity>
  | OwnerSecurityAdmissionFailure
  | OwnerSecurityResponse<500, OwnerSecurityError>;

@tag("auth-adapter") @useAuth(OwnerSessionCookie)
@extension("x-codexia-principal", "OWNER-SESSION cookie only; exact same-origin Origin and fresh reauthentication required")
@route("/api/auth/codexia/owner-security/revoke-consent") @post @operationId("owner_security_revoke_consent_post")
op revokeOwnerSecurityConsent(@header("Origin") origin: string, @body body: OwnerConsentWithdrawalRequest):
  | OwnerSecurityResponse<200, OwnerConsentWithdrawalReceipt>
  | OwnerSecurityAdmissionFailure
  | OwnerSecurityResponse<400, OwnerSecurityError | ApiError>
  | OwnerSecurityResponse<404, OwnerSecurityError>
  | OwnerSecurityResponse<409, OwnerSecurityError>
  | OwnerSecurityResponse<413, ApiError>
  | OwnerSecurityResponse<415, ApiError>
  | OwnerSecurityResponse<500, OwnerSecurityError>;

model OwnerSetupKeyInput {
  @pattern("^[A-Za-z0-9_-]{43}$")
  key: string;
  ...Record<never>;
}

model OwnerSetupProfileInput {
  @minLength(1)
  @maxLength(120)
  name: string;

  @format("email")
  @maxLength(254)
  email: string;
  ...Record<never>;
}

model OwnerSetupTransaction {
  transaction: string;
  ...Record<never>;
}

model OwnerSetupState {
  state: "waiting" | "setup-pending" | "expired" | "blocked" | "active";
  ...Record<never>;
}

model OwnerSetupEnrolled {
  state: "owner-enrolled";
  clientsReady: boolean;
  ...Record<never>;
}

union OwnerSetupStatusResponse {
  SetupState: OwnerSetupState,
  OwnerEnrolled: OwnerSetupEnrolled,
}

model OwnerSetupCompleted {
  state: "owner-enrolled";
  clientsReady: true;
  sessionConfirmed: boolean;
  ...Record<never>;
}

model OwnerSetupSuccess<Body> {
  @statusCode statusCode: 200;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: Body;
}

model OwnerSetupError {
  code: "SETUP_SAME_ORIGIN_REQUIRED" | "SETUP_KEY_INVALID" | "SETUP_TRANSACTION_INVALID" | "SETUP_PROFILE_INVALID" |
    "SETUP_CLOSED" | "SETUP_REQUEST_INVALID" | "SETUP_RATE_LIMIT" | "SETUP_UNAVAILABLE" | "SETUP_ONLY";
  ...Record<never>;
}

model OwnerSetupInvalid {
  @statusCode statusCode: 400;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: OwnerSetupError;
}

model OwnerSetupDenied {
  @statusCode statusCode: 403;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: OwnerSetupError;
}

model OwnerSetupBodyTooLarge {
  @statusCode statusCode: 413;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: OwnerSetupError;
}

model OwnerSetupRateLimited {
  @statusCode statusCode: 429;
  @header("Cache-Control") cacheControl: "no-store";
  @header("Retry-After") retryAfter: string;
  @body body: OwnerSetupError;
}

model OwnerSetupUnavailable {
  @statusCode statusCode: 503;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: OwnerSetupError;
}

model OwnerSetupReadinessUnavailableBody {
  code: "SETUP_UNAVAILABLE";
  ...Record<never>;
}

model OwnerSetupReadinessUnavailable {
  @statusCode statusCode: 503;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: OwnerSetupReadinessUnavailableBody;
}

@tag("auth-adapter") @useAuth(NoAuth)
@extension("x-codexia-principal", "ANON; no OAuth bearer; same-origin status")
@route("/api/auth/codexia/setup/status") @get @operationId("owner_setup_status_get")
op getOwnerSetupStatus(): OwnerSetupSuccess<OwnerSetupStatusResponse> | OwnerSetupDenied | OwnerSetupRateLimited | OwnerSetupUnavailable;

@tag("auth-adapter") @useAuth(NoAuth)
@extension("x-codexia-principal", "SETUP grant; same-origin JSON; setup-only runtime")
@route("/api/auth/codexia/setup/authorize") @post @operationId("owner_setup_authorize_post")
op authorizeOwnerSetup(@body body: OwnerSetupKeyInput):
  OwnerSetupSuccess<OwnerSetupTransaction> | OwnerSetupInvalid | OwnerSetupDenied | OwnerSetupBodyTooLarge |
  OwnerSetupRateLimited | OwnerSetupUnavailable;

@tag("auth-adapter") @useAuth(NoAuth)
@extension("x-codexia-principal", "SETUP transaction; same-origin JSON; setup-only runtime")
@route("/api/auth/codexia/setup/profile") @post @operationId("owner_setup_profile_post")
op setOwnerSetupProfile(
  @header("x-codexia-setup-transaction") transaction: string,
  @body body: OwnerSetupProfileInput,
): OwnerSetupSuccess<OwnerSetupTransaction> | OwnerSetupInvalid | OwnerSetupDenied | OwnerSetupBodyTooLarge |
  { @statusCode statusCode: 409; @header("Cache-Control") cacheControl: "no-store"; @body body: OwnerSetupError; } |
  OwnerSetupUnavailable;

@tag("auth-adapter") @useAuth(NoAuth)
@extension("x-codexia-principal", "SETUP transaction matched to committed owner; same-origin JSON; setup-only runtime")
@route("/api/auth/codexia/setup/complete") @post @operationId("owner_setup_complete_post")
op completeOwnerSetup(
  @header("x-codexia-setup-transaction") transaction: string,
  @body body: Record<never>,
): OwnerSetupSuccess<OwnerSetupCompleted> | OwnerSetupInvalid | OwnerSetupDenied | OwnerSetupBodyTooLarge | OwnerSetupUnavailable;
