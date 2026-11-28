# Security Policy

The [system design](docs/architecture/SYSTEM-DESIGN.sdoc), [API authentication and authorization](docs/architecture/API-AUTHN-AUTHZ.sdoc), and [owner security management transitions](docs/design/ADMIN-SCREEN-FLOW.sdoc) define security responsibilities. The [deployment state machines](docs/deployment/INITIAL-DEPLOYMENT-FLOW.sdoc) and [update state machines](docs/deployment/UPDATE-FLOW.sdoc) define operational safeguards.

Codexia is a single-owner writing application.

## Reporting

Report suspected vulnerabilities through private GitHub Security Advisories. Do not publish tokens, manuscript contents, private service addresses, or unredacted server logs in public Issues.

## Deployment boundary

Codexia uses the embedded Better Auth OAuth provider with an enrolled owner, registered clients, and private PostgreSQL connections for application and authentication data. Authoring clients sign in with a Passkey or a configured OIDC provider, then obtain short-lived API access tokens through Authorization Code with PKCE. The API verifies the token and its scope, performs online introspection, and checks the configured owner and resource authorization. Provision secrets and enroll the owner through the [protected Better Auth procedure](docs/deployment/ANSIBLE-AUTH-RUNTIME.sdoc).

Registered MCP clients can operate only within their assigned projects and OAuth scopes. Canonical changes require separate author approval and application. Cloudflare Access can protect static UI entry. The API applies its own authorization checks.

The default local listener is localhost. The OCI image listens on all container interfaces; bind its published port to localhost or place it behind a trusted HTTPS reverse proxy. Set `CODEXIA_TRUST_PROXY=1` only when that proxy controls and replaces `X-Forwarded-Proto`; this enables Secure cookies for externally HTTPS requests. Mutating API requests require a matching Origin. Never expose the instance through plain HTTP on an untrusted network.

PostgreSQL credentials, backups and database network access contain private writing and must be protected. Keep database passwords in a secret manager or protected secret files, use a least-privilege application role, and keep the database on an internal network. Do not publish the database port or include connection URLs in browser assets, images, shell history, logs or reports.

## Persistence and recovery

PostgreSQL is the canonical store for projects, documents, immutable revisions, Knowledge, Evidence, module records, proposals and applied changes. The API requires a healthy database at startup and readiness. An unavailable database does not fall back to local files or Git. Saves use revision and project-version preconditions; conflicts retain browser recovery drafts for review instead of overwriting newer text.

Browser drafts are local recovery copies and may contain private text. They remain on the browser after logout; use a trusted browser profile and clear it deliberately when retiring the device. Private browsing, storage limits or clearing site data can prevent recovery. The UI reports inability to store a draft; save or copy the text before leaving.

Keep PostgreSQL backups and the private `/history` volume, which holds usage and job history. `/data` contains derived module caches and can be rebuilt. The API can import existing manuscript data through the explicit migration workflow; it does not read or publish a Git repository during normal operation.
