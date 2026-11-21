# Codexia deployment

This directory describes the deployable boundary in [CODEXIA-REBOOT-RFC.md](../architecture/CODEXIA-REBOOT-RFC.md). The React/Vite application is released as Cloudflare Workers Static Assets. The API is a separate rootless Podman service; Cloudflare Tunnel is its only public origin path.

## Request and release paths

```text
Browser
  -> Cloudflare Access (one hostname and identity policy)
  -> assets-only catch-all -> codexia-frontend Static Assets -> Vite assets
  -> scriptless API/health/MCP exclusions -> Cloudflare Tunnel -> codexia-api container

API browser calls stay on the same hostname at /api/*.
The Worker has no API route and no origin-proxy fallback.
```

The route contract in `deploy/cloudflare/ui-routes.json` assigns a catch-all to the assets-only Worker and more-specific scriptless exclusions to the Tunnel for API, health, MCP and OAuth metadata paths. This also covers query-string root requests. Unknown static paths and missing assets return 404. No Worker script, binding, or Worker-first route is deployed. Static 200 proxies in `edge/frontend/static/_redirects` serve the distinct Desktop/Mobile and reader shells without executing code at the edge.

Static response headers are defined in `edge/frontend/static/_headers`. Script execution is restricted to same-origin external scripts; dynamic CodeMirror styles require inline styles in the static delivery CSP. The API-hosted UI retains per-response style nonces. The static frontend contains no secrets or origin-proxy code. Static asset requests do not incur Worker invocation charges.

## Authentication, API URL, and CORS

This section documents the **current same-origin standalone deployment**. The separately addressable, provider-neutral API and Web/iOS OAuth target is specified in [API authentication and authorization](../architecture/API-AUTHN-AUTHZ.md) and [iOS client](IOS-CLIENT.md); those are not live routing or authentication instructions until implemented and accepted.

Cloudflare Access applies an explicit identity allowlist to the application hostname. The Tunnel origin also requires the Access application audience. Access is the outer identity gate; the Codexia API keeps its authorization boundary. Dedicated deployments may opt into browser SSO without an additional token prompt.

By default the standalone API accepts `CODEXIA_AUTH_TOKEN` at `POST /api/login`, issues an HttpOnly SameSite=Strict session cookie (Secure on HTTPS), and applies same-origin checks to browser writes. The token must never be placed in a Worker variable, Vite build argument, browser bundle, or repository file.

### Dedicated browser SSO

Set the following in the private VM Quadlet configuration; do not enable this mode on an isolated local or Hosted instance.

| Environment | Value |
| --- | --- |
| `CODEXIA_BROWSER_AUTH` | `cloudflare-access` |
| `CODEXIA_ACCESS_ISSUER` | `https://<team>.cloudflareaccess.com` |
| `CODEXIA_ACCESS_AUDIENCE` | Access application's AUD tag |
| `CODEXIA_ACCESS_ORIGIN` | Exact public HTTPS application origin |
| `CODEXIA_ACCESS_OWNER_EMAIL` | The single approved author identity |
| `CODEXIA_TRUST_PROXY` | `1`, only on the private Tunnel origin |

Keep the auth-token Podman secret for external MCP bearer requests. The origin verifies the signed Access assertion for each browser API request using the team's HTTPS JWKS endpoint, checks issuer, audience, times, human identity, owner email and exact origin, and maintains the existing `owner` author scope. A missing or invalid assertion fails closed; the token login endpoint is retired in this mode. Explicit Authorization headers never acquire author authority from an Access assertion. Browser mutations retain exact same-origin checks. Browser logout navigates to Cloudflare's `/cdn-cgi/access/logout` (Access logout affects the user's other Access applications). An expired or revoked edge session requires top-level reauthentication; a signed JWT is not a separate long-lived Codexia session.

Deploy the compatible static UI and immutable API image, then enable the VM settings and restart only the API. Test Access login without a token prompt, existing draft recovery, same-origin saves, cross-origin rejection, missing/invalid/wrong-owner assertions, bearer-only proposals and denied author mutations, logout, and reauthentication. Check the VM's outbound HTTPS access to the team's public signing-key endpoint. Do not weaken Access, introduce an API proxy, or publish the API port. To roll back, remove the SSO environment settings and restart using the retained previous image if necessary; the default token flow remains available and the author scope is unchanged.

The current UI uses relative `/api/...` URLs, so production has no `VITE_API_URL` or API-origin secret. UI and API share one origin and no CORS allowlist is configured by default. The OAuth transition supports optional cross-origin Web calls only when an operator configures exact HTTPS origins in `CODEXIA_CORS_ALLOWED_ORIGINS`; those calls are bearer-only, omit browser credentials, and cannot carry cookies. This setting does not change Cloudflare routes or enable a separate API hostname. External MCP/API clients must use their supported authorization flow and do not receive a CORS exception.

### OAuth public Web client (prepared, not deployed)

The browser now supports an optional public OAuth client configuration in `app/.env.example`. It contains only public endpoints, client ID, API resource/audience, exact desktop/mobile redirect URIs, and scopes. Register both redirect URIs on the same public Web client. The browser uses Authorization Code + PKCE S256, validates the one-time state callback, keeps the verifier only in tab-scoped session storage during redirect, and keeps the API access token in JavaScript memory. OAuth API calls send `Authorization: Bearer` and omit cookies. No refresh token is requested or persisted; after access-token expiry or page reload, the user signs in again. OAuth sign-out clears the in-memory bearer.

The current static UI origin is `https://codexia.yohn.jp`; its Access-protected asset delivery stays unchanged. `VITE_CODEXIA_API_ORIGIN` is unset for the current same-origin route and must be set to an operator-approved HTTPS origin before cross-origin deployment. No separate API hostname has been selected or deployed. The OAuth issuer, API audience, registered client and redirect URIs, API hostname, exact backend CORS allowlist, Cloudflare Access application/policy, Tunnel hostname mapping and live authorization acceptance therefore remain operator/IdP prerequisites. Keep the origin and database private. The API must allow only the exact Web origin and required preflight headers/methods, without credentialed or wildcard CORS; the identity provider's token endpoint must also permit the registered Web origin to exchange the PKCE code. The client setting alone does not establish either boundary.

## Build and release ownership

[CI/CD architecture](../verification/CI-CD.md) owns verification, artifact certification and release admission. The following describes component artifacts, operational configuration and deployment ownership. A successful component build does not by itself authorize publication.

- UI changes build `app/dist` with `pnpm run build:frontend`, check and test the static Worker, then upload only the `codexia-frontend` asset Worker. The release job runs only after a push to the configured base branch and uses the `codexia-production` GitHub Environment. Production UI is built with the Full profile. Zone Routes are operated separately and are never changed by Wrangler.
- Frontend and Backend use independent SemVer bases in `app/package.json` and `packages/api/package.json`. CI adds the component workflow's run number to the base patch. Compatible changes need no version-only commit; intentionally change the major/minor base for a new version line. Local builds retain the declared base. Successful frontend deployment creates an immutable-by-policy `frontend-v<version>` GitHub Release; certified backend publication creates `backend-v<version>` with Core/Full immutable digest references. Release records include the API epoch. Existing release tags and records may not be repointed or replaced. GitHub workflow run numbers are independent, retries keep the same number, and unused PR numbers are harmless gaps.
- The frontend declares its required API epoch in `deploy/frontend-compatibility.json`. Backend advertises its provided epoch in `deploy/update-compatibility.json` and its running `/api/version` response. Independent release versions are compatible exactly when their API epochs and deployment profiles match. Before enabling the frontend gate, install the new backend that reports `apiEpoch` (legacy backends omit it), using the previously deployed compatible frontend identity. Configure the protected production environment variable `CODEXIA_PUBLIC_ORIGIN` (HTTPS application origin) and service token secrets `CODEXIA_ACCESS_CLIENT_ID` / `CODEXIA_ACCESS_CLIENT_SECRET` before activation. CI runs the read-only Production Access Preflight in parallel with the build, daily and on manual dispatch from main; it verifies both identity JSON responses, the candidate's required Full profile and API epoch against the live backend, anonymous denial and CI-token denial on non-probe paths. It reports endpoint, HTTP status and CF-Ray without logging credentials or bodies. A Cloudflare `cf-mitigated: challenge` on an identity path is reported separately as `EDGE_CHALLENGE`, not an Access token failure. Anonymous identity probes must reach the authorization boundary; a geographic challenge on an out-of-scope author route proves external denial only. The production mutation job still rechecks live backend compatibility immediately before replacing the UI. The VM checks the actual deployed UI before replacing the backend. The two identity probe paths and their exact Tunnel regexes are defined in `deploy/cloudflare/identity-probes.json`; their path apps use the reusable CI policy, while normal paths retain only author authorization. A failing preflight blocks frontend replacement, not repository verification or backend artifact publication. An epoch change requires a coordinated operator rollout, and is never automatically applied.
- Backend changes build `Dockerfile.backend`, test the resulting image, and publish `ghcr.io/yohn-jp/codexia-backend:sha-<40-character-commit>` only after a push to the configured base branch and successful complete main-push verification for that exact commit, including certification. The publication gate waits up to one hour and fails closed if verification is unavailable or unsuccessful. Core retains the existing `sha-<40-character-commit>` tag. Both Core and Full have independent signed stable-channel identities. Full is independently built and tested in parallel and published as `ghcr.io/yohn-jp/codexia-backend:sha-<40-character-commit>-full` behind the same exact-source gate. Both images contain only the selected API profile and runtime dependencies, not `app/dist`.
- Release lane selection and the common certification gate are defined in [CI/CD architecture](../verification/CI-CD.md).
- The production push job in [Push deployment](PUSH-DEPLOYMENT.md) consumes the exact certified Core digest after publication. Its protected enable flag stays false until the `codexia` VM account, SSH trust, backup mount and deployment rollback checks are accepted. PR validation never attaches the production Environment or receives Tailnet OIDC credentials. The old signed pull channel remains active during this transition; retire it only after the new path passes target-host acceptance. A dedicated Full VM still requires its matching Full digest and `CODEXIA_PROFILE=full`.
- `CLOUDFLARE_API_TOKEN` is only available to the protected production Worker job. `CLOUDFLARE_ACCOUNT_ID` is a GitHub Environment secret. GHCR publication uses the job-scoped `GITHUB_TOKEN` with `packages: write`.

The Cloudflare Terraform example manages the author Access application, two exact-path CI identity applications, remotely managed Tunnel, DNS record, and disabled-by-default UI Routes. Supply account, zone, identity-provider, and the existing account-owned reusable author Allow policy ID (`access_policy_id`) and CI Service Auth policy ID (`access_ci_policy_id`) in a private tfvars file. Follow [Access policy migration](../../deploy/cloudflare/terraform/ACCESS-POLICY-MIGRATION.md) when transitioning an existing deployment; the author allowlist is managed by the account policy owner, not this Terraform configuration. The zone owner must exclude the exact HTTPS identity GET paths from any interactive geographic WAF challenge; the Codexia Terraform module does not own shared zone rules. For `codexia.yohn.jp`, the `OutRage Challenge` rule must preserve its existing non-JP predicate and append `and not (http.host eq "codexia.yohn.jp" and http.request.method eq "GET" and http.request.uri.path in {"/api/version" "/desktop/update-identity.json"})`. Do not skip Access or exempt the full hostname, other HTTP methods, API prefixes or author routes. Confirm the exemption against `identity-probes.json` and the protected preflight. Keep Terraform state in an encrypted remote backend. The operator supplies `CLOUDFLARE_API_TOKEN` locally with only the Tunnel, Access, DNS and Worker Route permissions this configuration needs. Review imports and live state before applying; CI runs `fmt`, `init -backend=false`, and `validate`, never `apply`.

## VM environment and Secrets

[Infrastructure as code](IAC.md) is the normative VM desired-state authority. Rootless host inspection and the protected secret, storage, network, PostgreSQL and Tunnel stages are implemented; the manual procedures and updater lifecycle below remain transitional until runtime convergence, cutover, maintenance and target-host acceptance are verified.

`deploy/quadlet/codexia-api.container` defines these runtime values:

| Variable | Owner | Purpose |
| --- | --- | --- |
| `HOST=0.0.0.0` | Container | Listen on the private Podman network. |
| `PORT=3000` | Container | API port consumed by Tunnel. |
| `CODEXIA_PROFILE=core` | Release | Select the immutable server profile packaged into the image. |
| `CODEXIA_DATA_DIR=/data` | VM operator | Derived module caches; project authoring state lives in PostgreSQL. |
| `CODEXIA_USAGE_DIR=/history` | VM operator | Persistent usage/job history. |
| `CODEXIA_HOSTED_PROJECT_ID` | Hosted VM operator | Existing PostgreSQL project bound to the verified runtime assignment; required in hosted mode. |
| `CODEXIA_DATABASE_MIGRATE_ON_START=1` | VM operator | Apply existing checksum-verified PostgreSQL schema migrations before accepting requests. |
| `CODEXIA_DATABASE_PASSWORD_FILE` | Podman secret | Startup reads the hexadecimal `codexia` application-role password and builds the private service connection URL. |
| `CODEXIA_TRUST_PROXY=1` | Origin boundary | Honor HTTPS forwarding only because the API has no published host port and is reachable through the configured Tunnel. |
| `CODEXIA_AUTH_TOKEN_FILE` | Podman secret | Secret-file path read by `deploy/backend/start.sh`; the token is never baked into the image. |

Create `codexia-auth-token`, `codexia-tunnel-token`, `codexia-postgres-admin-password`, and `codexia-postgres-app-password` as rootless Podman secrets from protected files on the VM. Use independent 32-byte hexadecimal database passwords. PostgreSQL initializes a private `codexia_admin` superuser and a separate `codexia` application role that owns the application database; both database secrets are mounted in PostgreSQL for initialization of the separate roles; only the application secret is mounted in the API. Copy `deploy/postgres/010-create-app-role.sh` to `/etc/codexia/postgres/010-create-app-role.sh` before the first database start so the official image can create the least-privileged application role. Ansible installs the canonical, credential-free initializer as mode `0555` inside the service-owned `0750` directory: the rootless container maps the host service owner to container root, so the PostgreSQL UID requires other-read and execute on the read-only bind. Passwords remain in Podman secrets. The Tunnel token and database passwords must not appear in Quadlet text, shell history, Terraform outputs, or logs. The API has no published host port; Tunnel metrics are the only host binding and remain loopback-only. The API and PostgreSQL share the internal-only `codexia-data` network; the Tunnel cannot reach the database. The separate `codexia` network lets the Tunnel reach the API.

Install the `.container`, `.network`, and `.volume` files in the rootless service account's `~/.config/containers/systemd/` directory. Run `systemctl --user daemon-reload`, then start the generated services with `systemctl --user start codexia-db.service codexia-api.service codexia-tunnel.service`. Quadlet services are generated units and cannot be enabled with `systemctl enable`; their `[Install] WantedBy=default.target` sections make them start with the user's default target. Configure systemd lingering for that service account so its user services survive logout and start at boot. The systemd dependency starts PostgreSQL before the API; API startup applies checksummed schema migrations before opening its listener, and systemd retries a failed API start. The API reports ready only while PostgreSQL answers health checks. The API and database have no host ports. Tunnel metrics bind to `0.0.0.0:2000` inside its private network but publish only as `127.0.0.1:2000` on the VM; they are not reachable from the Internet.

The Worker build has no runtime secret and no API-origin variable. The Cloudflare token exists only in the GitHub production environment. Cloudflare Access emails and IdP IDs are configuration, not authentication secrets.

## Health and recovery

The API exposes unauthenticated process probes at `/health/startup`, `/health/live`, and `/health/ready`; `/api/ready` also reports request draining. Quadlet checks `/health/ready` from inside the API container. `cloudflared` exposes `/ready` and Prometheus metrics on port 2000; from the VM, `curl --fail http://127.0.0.1:2000/ready` checks for an active Cloudflare edge connection, while systemd restarts an exited tunnel process. The operator checks connection status in the Cloudflare dashboard and owns alerting from the VM-local metrics endpoint. No service endpoint or metrics port is exposed to the Internet.

### Persistence and backups

All workspaces use PostgreSQL as their canonical project, document, revision, Knowledge, and Evidence store. The schema is applied from the API image's existing checksum-verified migrations before the API accepts traffic. Use the explicit migration tooling to import an existing manuscript before opening it. Browser recovery drafts are local to their browser profile and remain separate from the database.

PostgreSQL uses the persistent `codexia-postgres` volume on an internal-only Podman network. The VM operator owns encrypted, off-VM `pg_dump -Fc` backups, WAL/PITR retention if the recovery-point objective requires it, and recurring restore exercises. For example, run `podman exec codexia-db sh -ec 'PGPASSWORD="$(cat /run/secrets/app-password)" pg_dump -h 127.0.0.1 -U codexia -d codexia -Fc'` and direct stdout to a protected backup file; encrypt it before moving it off the VM. Restore into a blank replacement database or isolated replacement volume, verify the API readiness probe and project/document counts, and only then direct the service to the restored database. Do not restore over the only production copy.

The operator also owns consistent backups and restore for `codexia-data` (`/data`) and `codexia-history` (`/history`), which contain derived module caches and private usage/job history. Stop the API or use a filesystem snapshot that guarantees a consistent point in time. Module cache data is derived and can be rebuilt. Retain the prior API image tag and origin UI image until rollback is rehearsed.

## Rollback and live acceptance

Keep the last origin image that still contains the UI until static delivery and Access behavior are proven. Terraform's `frontend_route_enabled=false` removes the static catch-all and its scriptless exclusions; all requests then reach the Tunnel. Rollback restores the retained origin image, disables the UI routes, and checks API login, write CSRF protection, Access denial, static 404 behavior, and an authenticated UI session.

Before setting `frontend_route_enabled=true`, validate Access on both the Worker routes and Tunnel origin. Test Access denial, API login and write CSRF protection, authenticated UI/API use, static asset 404 behavior, Tunnel readiness, and rollback. Keep the last origin image until the new route and identity behavior pass those checks. To roll back, set `frontend_route_enabled=false`, restore the retained origin image, and verify the UI and API again.

Hosted authorization retains signed Praetorium v1 issuer, audience, repository, instance and epoch verification. `CODEXIA_HOSTED_PROJECT_ID` binds that verified runtime to one existing PostgreSQL project; missing or unknown bindings fail startup. Project lists, module linked reads, actions, proposals and persistence routes enforce the same binding. Hosted project creation is forbidden. No repository credential broker is contacted.

Runtime status and quiesce responses use `codexia-runtime-status/v2`: durability reports `provider: postgres`, `projectId` and `projectVersion`. A database outage or missing project reports unknown durability and prevents safe quiesce. Control requests and credentials retain their signed v1 formats; external status consumers must adopt the v2 response before rollout.
