# Standalone MCP OAuth contract

Standalone MCP clients authenticate to the Codexia API with OAuth access tokens issued by the in-process Better Auth authorization server. Hosted/Praetorium keeps its existing grant issuer and protected-resource metadata contract.

## Resource and metadata

The protected resource is the configured Codexia API audience URI. It is not a project URL, MCP session URL, user identifier, or arbitrary request URL. MCP requests identify this resource with the OAuth `resource` parameter, and the access token must carry the same audience. The resource identifier and authorization-server issuer are independently configured and must match the API admission configuration.

For a path-bearing resource identifier, publish RFC 9728 Protected Resource Metadata at the well-known path formed by inserting `/.well-known/oauth-protected-resource` after the authority. For example, resource `https://api.example.test/api` maps to `https://api.example.test/.well-known/oauth-protected-resource/api`. The JSON document contains the exact `resource`, the configured authorization-server issuer in `authorization_servers`, `bearer_methods_supported: ["header"]`, and only the MCP scope ceiling below.

The authorization-server issuer publishes its standard OAuth Authorization Server Metadata and OIDC discovery documents, and JWKS, from Better Auth's configured base path. The MCP module does not implement OAuth protocol endpoints, signing, discovery, or a second token verifier.

## Scope ceiling

Standalone MCP scopes are explicit and limited to:

- `mcp:read` for read-only MCP operations.
- `mcp:compute` for bounded computation.
- `mcp:propose` for submitting reviewable proposals.

There is no MCP scope for approval or application. Scope is only an operation ceiling; it does not grant project or document ownership. Every request still passes API principal, project, object, revision, and existing approval checks. A token, registered client, or scope alone cannot promote a principal to owner. The MCP tools continue to submit proposals through the existing API boundary; author approval and apply remain in the existing authoring flow.

Client registration and authorization policy belong to the API's Better Auth OAuth Provider configuration. A client must use Authorization Code with PKCE S256, an exact registered redirect URI, an explicit Codexia API resource indicator, and only requested MCP scopes. Dynamic registration is not implied by protected-resource metadata and must remain disabled until its supported registration profile, redirect restrictions, and scope ceiling are enforced by that provider.

Standalone API admission separately classifies MCP clients with the comma-separated `CODEXIA_OAUTH_MCP_CLIENT_IDS` environment variable. The default is empty, which admits no MCP OAuth client; this list must be disjoint from `CODEXIA_OAUTH_OWNER_CLIENT_IDS`. Every configured client must also have an explicit existing project assignment in `CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS`, a JSON object mapping each client ID to a non-empty array of project IDs. Startup rejects missing, duplicate, malformed, unconfigured-client, and nonexistent-project assignments. API project listing, review queue results, project routes, and nested linked readers stay within that client’s assignment; the owner-wide project event stream is unavailable to MCP. A token must match an allowlisted client, the configured API audience, the strict access-token profile, and an active online introspection result. In the current single-owner deployment, its subject must also equal `CODEXIA_OAUTH_OWNER_SUBJECT`. The resulting principal remains `external-mcp`, and its scopes are reduced to the granted MCP operation scopes.


## Passkey-first identity and Access-independent MCP target

The [API authentication contract](API-AUTHN-AUTHZ.md#accepted-target-passkey-first-authentication-and-identity-management) governs the accepted, not-yet-deployed transition. Human login to Better Auth can use Passkey or a linked optional OIDC identity; remote MCP clients always use OAuth Authorization Code with PKCE, explicit API resource and limited scopes. Do not require or accept Cloudflare Access identity, browser cookies, a manually provisioned static token or a native Passkey assertion at `/mcp`. Publish protocol metadata and standard bearer challenges independently of the static UI's Access entry restrictions. API admission, introspection, project assignment and proposal-only limits remain authoritative.

The existing allowlists `CODEXIA_OAUTH_MCP_CLIENT_IDS` and `CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS` continue as the sole MCP client authorization configuration until a separately verified atomic policy-source migration. A settings screen must not appear to edit effective MCP project scope if it changes only Better Auth's client registry. Unauthenticated Dynamic Client Registration remains disabled; prefer existing explicitly approved client registration for the initial acceptance. A later switch from `oauthProvider()` to `@better-auth/mcp` is not part of this work and must not register both plugins together.

Use `/mcp` for a client with one assigned project. A client with several assignments must choose one with `/mcp?projectId=<assigned-id>` and use that URL throughout the session. The OAuth audience stays the configured API resource for both forms. Each request revalidates the access token and the project assignment. The transport session remains bound to the selected project and the verified issuer, client ID, and subject, so a new token for the same identity can continue the session.
