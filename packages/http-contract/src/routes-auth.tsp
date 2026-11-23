import "@typespec/http";
import "@typespec/openapi";
using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

model OAuthConsentContextRequest {
  oauth_query: string;
  ...Record<never>;
}

@tag("auth-adapter")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-principal", "OWNER-SESSION; same-origin request")
@route("/api/auth/oauth2/consent-context") @post @operationId("auth_consent_context_post")
op getOAuthConsentContext(@body body: OAuthConsentContextRequest): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 401; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("auth-adapter")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-principal", "OWNER-SESSION; same-origin request")
@route("/api/auth/oauth2/get-consents") @get @operationId("auth_list_consents_get")
op listOAuthConsents(): JsonResponse | { @statusCode _: 401; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };
