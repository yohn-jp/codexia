# Security Policy

Codexia is a single-owner writing application in standalone mode. Hosted deployments bind each runtime to one explicitly assigned PostgreSQL project and authorize users through signed Gateway grants.

## Reporting

Report suspected vulnerabilities through private GitHub Security Advisories. Do not publish tokens, manuscript contents, private service addresses, or unredacted server logs in public Issues.

## Deployment boundary

Standalone mode requires a unique `CODEXIA_AUTH_TOKEN` of at least 32 characters and a private `CODEXIA_DATABASE_URL`. The browser exchanges the token for an HttpOnly, SameSite=Strict session cookie; session state lives in server memory. Every authenticated session can access all PostgreSQL projects served by that instance. Restarting the server requires signing in again.

Hosted mode rejects the standalone token and uses the mounted runtime assignment, signed access grants and `CODEXIA_HOSTED_PROJECT_ID`. API reads and writes enforce the assigned project. Runtime-control requests use a separate signed credential. The browser never receives database or runtime-control credentials, and the API does not contact a repository credential broker.

The default local listener is localhost. The OCI image listens on all container interfaces; bind its published port to localhost or place it behind a trusted HTTPS reverse proxy. Set `CODEXIA_TRUST_PROXY=1` only when that proxy controls and replaces `X-Forwarded-Proto`; this enables Secure cookies for externally HTTPS requests. Mutating API requests require a matching Origin. Never expose the instance through plain HTTP on an untrusted network.

PostgreSQL credentials, backups and database network access contain private writing and must be protected. Keep database passwords in a secret manager or protected secret files, use a least-privilege application role, and keep the database on an internal network. Do not publish the database port or include connection URLs in browser assets, images, shell history, logs or reports.

## Persistence and recovery

PostgreSQL is the canonical store for projects, documents, immutable revisions, Knowledge, Evidence, module records, proposals and applied changes. The API requires a healthy database at startup and readiness. An unavailable database does not fall back to local files or Git. Saves use revision and project-version preconditions; conflicts retain browser recovery drafts for review instead of overwriting newer text.

Browser drafts are local recovery copies and may contain private text. They remain on the browser after logout; use a trusted browser profile and clear it deliberately when retiring the device. Private browsing, storage limits or clearing site data can prevent recovery. The UI reports inability to store a draft; save or copy the text before leaving.

Keep PostgreSQL backups and the private `/history` volume, which holds usage and job history. `/data` contains derived module caches and can be rebuilt. The API can import existing manuscript data through the explicit migration workflow; it does not read or publish a Git repository during normal operation.
