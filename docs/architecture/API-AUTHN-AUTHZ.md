# API authentication and authorization

> **Accepted target architecture; not a description of the currently deployed authentication flow.**
> This contract specializes [Core architecture](CORE.md) and [Internal boundaries](INTERNAL-BOUNDARIES.md). The current standalone Access/cookie and Hosted grant behavior remains documented in [Deployment](../deployment/README.md) and [Hosted deployment](../HOSTED-DEPLOYMENT.md) until a separately verified migration. Authentication belongs to the existing Fastify API admission boundary; Core and PostgreSQL are not identity providers.

## Decision and trust boundaries

Codexia has one API authorization boundary regardless of client presentation. Browser/PWA and installed iOS clients authenticate against an external, managed OAuth 2.0/OpenID Connect (OIDC) provider, then present an **API-specific OAuth access token**. The API authenticates the token, resolves a principal, and independently authorizes each operation and its target objects. It does not delegate data authorization to Cloudflare Access, the Tunnel, a UI bundle, an application signature, or a client-supplied project ID.

| Component | Responsibility |
| --- | --- |
| Cloudflare Access on the static Workers UI | Optional **UI entry** restriction; not an API authorization grant |
| Browser/PWA | OAuth public client; obtain API access without bundling secrets |
| iOS Capacitor shell | Separate OAuth public client; OS-mediated sign-in and protected token storage |
| External managed authorization server / OIDC provider | Authenticate people, authorize OAuth client requests, issue API-audience access tokens and publish verification metadata |
| Cloudflare Edge/Tunnel | HTTPS routing and transport to the private API; not proof of application identity |
| Codexia Fastify API admission | Token verification, trusted principal creation, authorization, origin/CSRF rules, request lifecycle, and error handling |
| Persistence/Core | Canonical project-scoped data, revision and proposal enforcement; never accept an unverified client identity |

The configured authorization server is **deploy-time configuration**, not a client-selected issuer or a dynamic trust-on-first-use endpoint. A self-hosted backend can configure its own managed provider without changing the application protocol. Codexia does **not** operate an OAuth authorization server or self-host an IdP.

## Protocol and credential contract

- **OAuth 2.0 Authorization Code with PKCE (S256)** is required for interactive browser and iOS sign-in. Register distinct public client IDs and exact redirect URIs for each client. Validate `state`; when an ID token is used for login, validate its OIDC `nonce` and normal ID-token properties in the client. iOS invokes the system authentication session, not an embedded WebView login form.
- OIDC establishes an authenticated subject. **An OIDC ID token is not a Codexia API bearer credential**. Only an access token explicitly issued for this API may be presented in `Authorization: Bearer`.
- The initial API resource-server contract is **signed JWT access tokens**, preferably the interoperable [RFC 9068 JWT access token profile](https://www.rfc-editor.org/rfc/rfc9068). An IdP is compatible only after confirming that it can issue an **access token** whose issuer, audience, signature, type and claims are actually valid for this API. A provider's support for OIDC login alone is insufficient. Opaque access tokens require a separately designed, fail-closed RFC 7662 introspection contract; they are not silently decoded as JWTs.
- Configure an exact HTTPS issuer and API audience/resource identifier; obtain authorization-server metadata and JWKS only from configured trusted endpoints. Pin allowed asymmetric signing algorithms; enforce signature, issuer, API audience, token type where supported (mandatory `at+jwt` under RFC 9068), `exp`, `nbf`/`iat` constraints, stable nonempty `sub`, and required token scopes or entitlements. Reject `alg=none`, wrong-audience ID tokens, malformed or ambiguous credentials, and unknown signing keys. Use bounded JWKS caching, key rotation, request timeouts and fail-closed handling.
- Use a stable identity key such as **(`iss`, `sub`)**. E-mail addresses are display/verification attributes, not a secure or stable authorization primary key. In dedicated single-author mode, bind the accepted identity to the explicitly configured owner; a valid token for a different identity does **not** acquire owner rights.
- Prefer short-lived access tokens; clients renew with their provider's supported refresh/session flow. Never store refresh tokens in the Codexia database or publish them in browser assets, logs, the IPA, a CI artifact or GitHub Secrets. Logout/revocation semantics must be documented against the provider's actual behavior; JWT signature validation alone cannot guarantee instant revocation.

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

Use maintained libraries, not hand-written JWT parsers/cryptographic verification. **Preferred Fastify integration** is `@fastify/jwt` for JWT verification and `@fastify/auth` only when composing multiple authentication strategies. Neither plugin performs OIDC discovery, remote JWKS rotation, object-level authorization or BOLA protection automatically; use a vetted JWKS verifier/resolver (for example `jose`) where the Fastify integration does not provide these guarantees. The choice must pass the exact issuer/audience/type/rotation and denial cases rather than being justified by package names alone. Reuse Fastify 5 and the existing API surface.

Existing standalone local-token login, optional Access owner SSO, and Hosted/Praetorium grants remain **separate compatibility modes** until their documented transitions are implemented and tested. No OAuth token may gain Hosted project authority by falling back to standalone identity. Never downgrade authentication on JWT/JWKS outage.

## Required acceptance evidence for implementation

- A managed provider actually issues an API-audience OAuth access token through public-client Authorization Code + PKCE for Web and iOS; both call the same protected API with equivalent authorization results.
- A valid author can list, read, create, edit, review, approve and apply permitted resources; existing revision, recovery and proposal receipts remain correct.
- Deny missing, expired, forged, unknown-key, wrong-issuer, wrong-audience, wrong-token-type, wrong-owner and insufficient-scope tokens, including rotating JWKS and unavailable metadata.
- Exercise BOLA/BFLA negative cases across each object-bearing API family, nested object IDs, bulk reads, cross-project writes, proposals, approvals, jobs, modules and SSE. A valid token must **not** bypass object access checks.
- Verify browser CSRF/CORS and iOS bearer paths separately, including concurrent cookie/bearer ambiguity, logout/reauthentication, stale-author-scope recovery and long-lived streams that outlast a grant.
- Existing Hosted MCP, local standalone access, current deployment and read-only external agents retain their authority boundaries. Record actual commands, results and environment blockers in PR/CI evidence, not this contract.

References: [OWASP API1:2023 BOLA](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/), [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068), [RFC 8252 (native OAuth apps)](https://www.rfc-editor.org/rfc/rfc8252), [RFC 7636 (PKCE)](https://www.rfc-editor.org/rfc/rfc7636), [Fastify JWT](https://github.com/fastify/fastify-jwt), [Fastify Auth](https://github.com/fastify/fastify-auth).
