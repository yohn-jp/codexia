# Codexia deployment

This directory describes the deployable boundary in [CODEXIA-REBOOT-RFC.md](../architecture/CODEXIA-REBOOT-RFC.md). The React/Vite application is released as Cloudflare Workers Static Assets. The API is a separate rootless Podman service; Cloudflare Tunnel is its only public origin path.

## Request and release paths

```text
Browser
  -> Cloudflare Access (one hostname and identity policy)
  -> explicit UI routes -> codexia-frontend Worker -> Vite assets
  -> all other routes -> Cloudflare Tunnel -> codexia-api container

API browser calls stay on the same hostname at /api/*.
The Worker has no API route and no origin-proxy fallback.
```

`deploy/cloudflare/ui-routes.json` is the route list shared by Terraform and the config verifier. It includes the root shell, hashed assets, Desktop/Mobile shells, and public reader shells. `/api/*`, health routes, and unknown paths do not match a Worker Route. A Worker script also rejects unknown paths if a catch-all Route is accidentally attached.

The Worker runs only for HTML shell requests, generates the per-response CodeMirror style nonce, and returns the existing CSP policy. Vite hashed assets bypass the Worker and use immutable cache headers. Missing assets return 404. The Worker never forwards a request to the VM.

## Authentication, API URL, and CORS

Cloudflare Access applies an explicit identity allowlist to the application hostname. The Tunnel origin also requires the Access application audience. Access is the outer identity gate; the Codexia API keeps its own login and authorization boundary.

The current API accepts `CODEXIA_AUTH_TOKEN` at `POST /api/login`, then issues its Secure, HttpOnly session cookie and applies same-origin checks to cookie-authenticated writes. `CODEXIA_GITHUB_TOKEN` is server-side access for registered Git repositories. Neither value belongs in a Worker variable, Vite build argument, browser bundle, or repository file.

The UI uses relative `/api/...` URLs, so production has no `VITE_API_URL` or API-origin secret. UI and API share one origin and the API does not send `Access-Control-Allow-Origin`; browser CORS is intentionally disabled. External MCP/API clients must use their supported authorization flow and do not receive a CORS exception.

## Build and release ownership

- UI changes build `app/dist` with `pnpm run build:frontend`, check and test the static Worker, then upload only the `codexia-frontend` asset Worker. The release job runs only after a push to the configured base branch and uses the `codexia-production` GitHub Environment. Zone Routes remain Terraform-owned and are never changed by Wrangler.
- Backend changes build `Dockerfile.backend`, test the resulting image, and publish `ghcr.io/yohn-jp/codexia-backend:sha-<40-character-commit>` only after a push to the configured base branch and successful complete main-push verification for that exact commit, including certification. The publication gate waits up to one hour and fails closed if verification is unavailable or unsuccessful. The image contains the API profile and runtime dependencies, not `app/dist`.
- Changes shared by both build lanes may select both. PR jobs build and validate but do not publish or deploy.
- The VM operator updates the Quadlet image to the exact published commit tag (or its recorded registry digest), reviews it, and performs the service restart. CI does not SSH to or deploy to the VM.
- `CLOUDFLARE_API_TOKEN` is only available to the protected production Worker job. `CLOUDFLARE_ACCOUNT_ID` is a non-secret GitHub Environment variable. GHCR publication uses the job-scoped `GITHUB_TOKEN` with `packages: write`.

The Cloudflare Terraform example creates an Access application, remotely managed Tunnel, DNS record, and disabled-by-default UI Routes. Supply account, zone, identity-provider, and author allowlist values in a private tfvars file. Keep Terraform state in an encrypted remote backend. The operator supplies `CLOUDFLARE_API_TOKEN` locally with only the Tunnel, Access, DNS and Worker Route permissions this configuration needs. Review imports and live state before applying; CI runs `fmt`, `init -backend=false`, and `validate`, never `apply`.

## VM environment and Secrets

`deploy/quadlet/codexia-api.container` defines these runtime values:

| Variable | Owner | Purpose |
| --- | --- | --- |
| `HOST=0.0.0.0` | Container | Listen on the private Podman network. |
| `PORT=3000` | Container | API port consumed by Tunnel. |
| `CODEXIA_PROFILE=core` | Release | Select the immutable server profile packaged into the image. |
| `CODEXIA_DATA_DIR=/data` | VM operator | Persistent CoreStore repositories and local checkpoints. |
| `CODEXIA_USAGE_DIR=/history` | VM operator | Persistent usage/job history. |
| `CODEXIA_TRUST_PROXY=1` | Origin boundary | Honor HTTPS forwarding only because the API has no published host port and is reachable through the configured Tunnel. |
| `CODEXIA_AUTH_TOKEN_FILE` | Podman secret | Secret-file path read by `deploy/backend/start.sh`; the token is never baked into the image. |
| `CODEXIA_GITHUB_TOKEN_FILE` | Podman secret | Private GitHub repository credential, read only at process start. Omit the secret mount and variable only when every registered repository is public and needs no GitHub credential. |

Create `codexia-auth-token`, `codexia-github-token`, and `codexia-tunnel-token` as rootless Podman secrets from protected files on the VM. The Tunnel token and GitHub token must not appear in Quadlet text, shell history, Terraform outputs, or logs. The API has no published host port; Tunnel metrics are the only host binding and remain loopback-only. The user-defined bridge permits the API's current GitHub access and private container-to-container traffic.

Install the `.container`, `.network`, and `.volume` files in the rootless service account's `~/.config/containers/systemd/` directory. Run `systemctl --user daemon-reload`, then `systemctl --user enable --now codexia-api.service codexia-tunnel.service`. Configure systemd lingering for that service account so its user services survive logout and start at boot. The API has no host port. Tunnel metrics bind to `0.0.0.0:2000` inside its private network but publish only as `127.0.0.1:2000` on the VM; they are not reachable from the Internet.

The Worker build has no runtime secret and no API-origin variable. The Cloudflare token exists only in the GitHub production environment. Cloudflare Access emails and IdP IDs are configuration, not authentication secrets.

## Health and recovery

The API exposes unauthenticated process probes at `/health/startup`, `/health/live`, and `/health/ready`; `/api/ready` also reports request draining. Quadlet checks `/health/ready` from inside the API container. `cloudflared` exposes `/ready` and Prometheus metrics on port 2000; from the VM, `curl --fail http://127.0.0.1:2000/ready` checks for an active Cloudflare edge connection, while systemd restarts an exited tunnel process. The operator checks connection status in the Cloudflare dashboard and owns alerting from the VM-local metrics endpoint. No service endpoint or metrics port is exposed to the Internet.

### Current persistence and backups

The current `CoreStore` is Git-backed and does not connect to PostgreSQL. This deployment does not start an unused PostgreSQL container or pretend that a database dump exists. Until the RFC's PostgreSQL-backed Core is implemented, the VM operator owns encrypted, off-VM, consistent backups of both `codexia-data` (`/data`) and `codexia-history` (`/history`). Stop the API or use a filesystem snapshot that guarantees a consistent point in time. Git remotes are not a backup of local checkpoints or working-tree state. Module cache data is derived and can be rebuilt.

The operator also owns restore into replacement volumes, API startup/readiness verification, repository identity checks, and an author review of restored local checkpoints before returning the instance to service. Retain the prior API image tag and the existing origin UI image until rollback is rehearsed.

When CoreStore moves to PostgreSQL, the VM data operator owns `pg_dump -Fc` backups, WAL/PITR retention if a recovery-point objective requires it, separate attachment-volume backups, encrypted off-VM retention, and recurring restore exercises. The PostgreSQL service and its readiness probe must be added with that persistence integration; they are not operational in this source revision.

## Rollback and live acceptance

Keep the last origin image that still contains the UI until static delivery and Access behavior are proven. Terraform's `frontend_route_enabled=false` removes only the narrow UI Worker Routes; API traffic continues through Tunnel. Rollback restores the retained origin image, disables the UI routes, and checks API login, write CSRF protection, Access denial, static 404 behavior, and an authenticated UI session.

Before setting `frontend_route_enabled=true`, validate Access on both the Worker routes and Tunnel origin. Test Access denial, API login and write CSRF protection, authenticated UI/API use, static asset 404 behavior, Tunnel readiness, and rollback. Keep the last origin image until the new route and identity behavior pass those checks. To roll back, set `frontend_route_enabled=false`, restore the retained origin image, and verify the UI and API again.
