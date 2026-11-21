# API authentication and authorization

> **Current Better Auth implementation contract for standalone OAuth.**
> This contract specializes [Core architecture](CORE.md) and [Internal boundaries](INTERNAL-BOUNDARIES.md). Better Auth runs inside the existing Fastify API and federates login to a configured OIDC provider. Cloudflare Access and Hosted/Praetorium grants remain separate compatibility boundaries documented in [Deployment](../deployment/README.md) and [Hosted deployment](../HOSTED-DEPLOYMENT.md). Core and PostgreSQL are not identity providers.

## Decision and trust boundaries

Codexia has one API authorization boundary regardless of client presentation. Browser/PWA and installed iOS clients authenticate against an external, managed OAuth 2.0/OpenID Connect (OIDC) provider, then present an **API-specific OAuth access token**. The API authenticates the token, resolves a principal, and independently authorizes each operation and its target objects. It does not delegate data authorization to Cloudflare Access, the Tunnel, a UI bundle, an application signature, or a client-supplied project ID.

| Component | Responsibility |
| --- | --- |
| Cloudflare Access on the static Workers UI | Optional **UI entry** restriction; not an API authorization grant |
| Browser/PWA | OAuth public client; obtain API access without bundling secrets |
| iOS Capacitor shell | Separate OAuth public client; OS-mediated sign-in and protected token storage |
| Configured upstream OIDC provider | Authenticate people and provide identity assertions to the backend federation flow |
| Better Auth inside Fastify | Maintain Codexia sessions, OAuth clients/consent, authorization codes, refresh state, API JWT signing keys and OAuth metadata |
| Cloudflare Edge/Tunnel | HTTPS routing and transport to the private API; not proof of application identity |
| Codexia Fastify API admission | Token verification, trusted principal creation, authorization, origin/CSRF rules, request lifecycle, and error handling |
| Persistence/Core | Canonical project-scoped data, revision and proposal enforcement; never accept an unverified client identity |

The upstream OIDC issuer is **deploy-time configuration**, not a client-selected issuer or a dynamic trust-on-first-use endpoint. Better Auth is Codexia's downstream authorization server within the API process; it is not a separate IAM service. A self-hosted backend can change the upstream provider without changing the client protocol.

## Protocol and credential contract

- **OAuth 2.0 Authorization Code with PKCE (S256)** is required for browser and iOS clients using the Codexia OAuth provider. The backend then uses Generic OAuth to authenticate against the configured upstream OIDC provider. Register distinct downstream public clients and exact redirect URIs for Web and iOS. iOS invokes the system authentication session, not an embedded WebView login form.
- Upstream OIDC establishes an authenticated Better Auth user. **An upstream ID token or access token is not a Codexia API bearer credential**. Only a downstream access token issued by Better Auth for the configured Codexia API audience may be presented in `Authorization: Bearer`.
- The downstream API resource-server contract is signed JWT access tokens using RFC 9068, including `typ: at+jwt`. Better Auth's JWT plugin publishes signing keys; Fastify verifies signature, issuer, API audience, type, expiry, issue time, token ID, client ID, subject and required scope, then performs confidential online introspection so revoked sessions and refresh state are reflected.
- Better Auth Generic OAuth performs upstream Discovery, ID-token signature, issuer, audience, nonce and time validation. Configure an exact HTTPS upstream issuer and client ID/secret through protected runtime configuration. Do not trust a client-selected issuer, accept `alg=none`, or silently fall back when discovery, JWKS or introspection is unavailable.
- Use a stable identity key such as **(`iss`, `sub`)**. E-mail addresses are display/verification attributes, not a secure or stable authorization primary key. In dedicated single-author mode, bind the accepted identity to the explicitly configured owner; a valid token for a different identity does **not** acquire owner rights.
- Prefer short-lived access tokens; clients renew through the Codexia OAuth provider's refresh flow. Never publish refresh tokens in browser assets, logs, the IPA, a CI artifact or GitHub Secrets. Logout/revocation semantics must match the tested provider behavior; JWT signature validation alone cannot guarantee instant revocation.

## API authorization (including BOLA)

Authentication and OAuth scopes are **necessary but not sufficient** for resource access. Central admission resolves an authenticated principal with a trusted author/permission context, then checks the action and actual resource ownership/membership. Do not derive membership, project choice, author approval or permissions solely from `projectId`, a document path, an ID in a payload, `email`, or client-side UI state.

For **every** API and module operation that references a project, document, hierarchy node, revision, proposal, approval, action, snapshot, attachment, Evidence item, job, inbox entry, recent-activity cursor or export:

1. Resolve the caller's authenticated identity and allowed project/resource scope on the server.
2. Check the requested operation's permission **and** membership/ownership of the exact target object, including nested parent relationships. Recheck identifiers in URL, query, body and linked objects; enumeration and bulk endpoints must filter server-side.
3. Reject cross-project and cross-author references without exposing another user's data. A guessed UUID or a successful `GET /api/session` is not authorization.
4. For mutations, preserve the existing PostgreSQL-scoped revision/version preconditions, idempotency identity and atomic write checks. A later change of permissions or object scope must not be bypassed by a previously prepared proposal or stale snapshot.
5. Preserve restricted MCP/external-agent grants. An OAuth bearer for an **authenticated author** must be explicitly distinguished from the existing read/compute/propose-only MCP bearer. Neither a generic bearer, Cloudflare assertion, nor a provider scope string implicitly authorizes `approve`, `apply`, author-only jobs or manuscript modification.

Authorization is enforced on the API boundary and again wherever a transaction must close a time-of-check/time-of-use window. It is not implemented as scattered controller-local `if (owner)` checks. A policy engine (Cerbos/OpenFGA) is not required for the current single-author domain; adopt one only if concrete project-sharing requirements justify it.

## Browser, iOS and transport constraints

The two frontends use the **same API token validation and resource authorization contract**, not necessarily identical login UI or token storage.

- Current production serves the static UI and `/api/*` from one Access-protected hostname. Moving to a separately addressable API requires an explicit Cloudflare routing/Access policy change; **the existing deployment does not already have a public Access-independent API**. Keep the origin and PostgreSQL private throughout the transition.
- The Web UI remains Access-protected as a delivery policy. Its API sign-in is a distinct OAuth flow unless the selected identity provider supports SSO. Browser tokens must not be persisted in `localStorage` or IndexedDB. A same-origin BFF/HttpOnly session may be evaluated if browser token handling warrants it; do not invent a second authorization authority or distribute server client credentials to the browser.
- Cross-origin browser fetches require a deliberately scoped CORS/preflight policy for the configured Web UI origin. Reject wildcard credentialed CORS, reflection of arbitrary origins and unauthorized writes. For cookie-authenticated routes retain CSRF/origin protections; for bearer-authenticated routes do not substitute an `Origin` check for token validation. Differentiate browser navigation, bearer, cookie and MCP credentials without ambiguous privilege promotion.
- Tunnel and Cloudflare WAF/rate limits remain defense in depth. A sideloaded IPA is publicly inspectable and is **not** an authentication factor. No shared client secret or static API owner token is embedded.

## Implementation ownership and dependencies

Implement at the existing Fastify admission point in `packages/api`, preserving its centralized request lifecycle, Hosted policy, failure semantics, and restricted MCP bearer path. Reuse the existing project authorization, persistence preconditions and proposal boundary; do not create a second auth router or reimplement Core permissions.

Use Better Auth, Generic OAuth and OAuth Provider maintained plugins for protocol, session, client, token and key management. Use the existing `jose` verifier for API JWT profile validation and the official OAuth introspection endpoint for online token status. Do not hand-write discovery, token issuance, signature verification or a second auth router. Reuse Fastify 5 and the existing API admission boundary.

Existing standalone local-token login, optional Access owner SSO, and Hosted/Praetorium grants remain **separate compatibility modes** until their documented transitions are implemented and tested. No OAuth token may gain Hosted project authority by falling back to standalone identity. Never downgrade authentication on JWT/JWKS outage.

### Better Auth standalone owner bearer

The active standalone Better Auth configuration uses `CODEXIA_AUTH_DATABASE_URL`, `CODEXIA_PUBLIC_ORIGIN`, `CODEXIA_OIDC_ISSUER`, `CODEXIA_OIDC_CLIENT_ID`, `CODEXIA_OIDC_CLIENT_SECRET`, `CODEXIA_AUTH_SECRET`, `CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID`, `CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET`, `CODEXIA_OAUTH_OWNER_SUBJECT`, and comma-separated `CODEXIA_OAUTH_OWNER_CLIENT_IDS`. `CODEXIA_API_AUDIENCE` defaults to `<public-origin>/api`; `CODEXIA_OAUTH_MCP_CLIENT_IDS` is a separate disjoint allowlist for the limited `mcp:read`, `mcp:compute`, and `mcp:propose` scopes. Secrets are supplied only through protected runtime configuration. The owner subject is the stable Better Auth internal user ID linked to the upstream (`iss`, `sub`) account. Owner client IDs are separately registered public clients and do not themselves confer owner identity.

The Better Auth Generic OAuth callback route was observed in the signed-out PostgreSQL fixture as `<CODEXIA_PUBLIC_ORIGIN>/api/auth/callback/workspace-oidc`. Register that exact HTTPS URI with the selected upstream provider for the configured public origin. The fixture used loopback HTTP only for its local synthetic IdP/API and does not qualify a production provider configuration. Google Workspace is the first intended provider; no Google client secret, provider-side callback registration, or real Google login has been configured or tested in this change.

Auth tables live in the independent PostgreSQL `codexia_auth` schema. The runtime database role `codexia_auth_runtime` must own that schema and have only required database/schema privileges; it must have no `CREATE` on `public` or data privileges on non-auth tables/sequences. Production startup does not run migrations or create roles/schemas. After schema and grants are provisioned, run `pnpm --filter @codexia/api build`, then `pnpm --filter @codexia/api migrate:auth -- --apply` with protected `CODEXIA_*` runtime configuration loaded. The command verifies `current_schema() = codexia_auth`, `current_user = codexia_auth_runtime`, and schema ownership; calls Better Auth's official `$context.runMigrations()`; and never creates a role or schema.

Register distinct Web and iOS public OAuth clients with exact redirect URIs, `token_endpoint_auth_method: none`, Authorization Code + Refresh Token, PKCE required, the exact API resource, and only intended scopes. Register a separate confidential client for API introspection; keep its secret only in protected runtime storage. Set `CODEXIA_OAUTH_OWNER_SUBJECT` to the established internal owner user ID and `CODEXIA_OAUTH_OWNER_CLIENT_IDS` to the registered public client IDs. Unauthenticated dynamic registration is disabled.

Clients send `Authorization: Bearer <access_token>` to the existing `/api/*` API origin. The token grants only the configured owner internal subject the existing author operations; `/api/session` reports `{ authenticated: true, authorScope: "owner" }`. Other subjects receive 403, missing scopes receive 403, invalid access tokens and unknown keys receive 401, and unavailable verification/introspection dependencies fail closed. A valid legacy `CODEXIA_AUTH_TOKEN` bearer remains limited to existing read/compute/propose behavior and cannot become an author credential. Do not combine a bearer credential with the standalone owner session cookie. This mode does not activate Hosted authorization or change PostgreSQL project/object transaction guards.

Better Auth 1.7.26 behavior verified by the PostgreSQL fixture: refresh tokens rotate and the revocation endpoint invalidates refresh tokens. Its revocation endpoint returns `unsupported_token_type` for an individual signed JWT access token, so a copied access token remains usable until its short expiry or the associated session is logged out; online introspection reflects session logout. Do not claim immediate per-access-token revocation until supported and tested.

Cross-origin Web requests are optional and use `CODEXIA_CORS_ALLOWED_ORIGINS`, a comma-separated list of exact normalized HTTPS origins. An unset list permits same-origin requests only. The API returns `Access-Control-Allow-Origin` only for a configured exact origin, limits preflight methods to the requested supported method, and allows only the request's explicitly listed supported headers. It never enables credentialed CORS or reflects arbitrary origins. Cross-origin protected API calls use bearer authorization and omit browser credentials; any cross-origin cookie is denied. `Authorization`, `Content-Type`, `Idempotency-Key`, `X-Client-Id`, `X-Codexia-Recent-Activity-Order`, and `Prefer` are the supported request headers. Cookie-based mutation remains same-origin protected.

## Required acceptance evidence for implementation

- A real configured upstream OIDC provider authenticates a user; Better Auth then issues an API-audience OAuth access token through public-client Authorization Code + PKCE for Web and iOS, and both call the same protected API with equivalent authorization results.
- A valid author can list, read, create, edit, review, approve and apply permitted resources; existing revision, recovery and proposal receipts remain correct.
- Deny missing, expired, forged, unknown-key, wrong-issuer, wrong-audience, wrong-token-type, wrong-owner and insufficient-scope tokens, including rotating JWKS and unavailable metadata.
- Exercise BOLA/BFLA negative cases across each object-bearing API family, nested object IDs, bulk reads, cross-project writes, proposals, approvals, jobs, modules and SSE. A valid token must **not** bypass object access checks.
- Verify browser CSRF/CORS and iOS bearer paths separately, including concurrent cookie/bearer ambiguity, logout/reauthentication, stale-author-scope recovery and long-lived streams that outlast a grant.
- Existing Hosted MCP, local standalone access, current deployment and read-only external agents retain their authority boundaries. Record actual commands, results and environment blockers in PR/CI evidence, not this contract.

References: [OWASP API1:2023 BOLA](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/), [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068), [RFC 8252 (native OAuth apps)](https://www.rfc-editor.org/rfc/rfc8252), [RFC 7636 (PKCE)](https://www.rfc-editor.org/rfc/rfc7636), [Fastify JWT](https://github.com/fastify/fastify-jwt), [Fastify Auth](https://github.com/fastify/fastify-auth).
