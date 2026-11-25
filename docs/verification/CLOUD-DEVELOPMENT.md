# Codex Cloud development

This is the repository-owned development procedure for isolated Codex Cloud tasks, not a deployment or product-support contract. The Cloud environment provides Node.js, Corepack, Docker with the Compose plugin, OpenSSL and access to the required package/image registries. The root [package.json](../../package.json) owns the Node.js requirement and pnpm version; do not duplicate the version in Cloud settings.

## Boundaries

- Run Node/pnpm and the application in the task host. Only the PostgreSQL services run in Docker.
- Use the existing [UI preview](UI-PREVIEW.md) for interactive Core authoring. It provides the real local Better Auth/OAuth fixture, an isolated temporary PostgreSQL database, migrations, OAuth-configured frontend assets, health checks and an authenticated seeded project. Do not add a second application launcher, token login, smoke harness, or authentication implementation.
- Use [cloud-db.sh](../../scripts/dev/cloud-db.sh) for the separate test PostgreSQL service. Compose owns service startup, health-based waiting and the named volume. The official PostgreSQL entrypoint creates the test databases. The named volume can be reused within the task's Docker environment; its contents are disposable and are not author data or a cross-task persistence promise.
- Keep the generated runtime.env, cache, and state outside the checkout. No production URL, credential, deployment operation, or persistent author database belongs in this fixture. The existing preview intentionally discards its database at shutdown; its randomly enrolled owner/clients do not provide durable developer identity. A persistent author installation requires the normal Better Auth provisioning procedure, not a new fixture mode.
- Ordinary, auth, browser and Web OAuth tests have separate database URLs. The browser URL uses an existing permitted disposable name family (codexia_e2e_compat_*) rather than weakening the Better Auth test guard. Do not run independent destructive suites concurrently against the same database. Use the existing CI isolated-shard mechanism for CI-level parallel verification.

## Codex Cloud installer

Configure the repository as yohn-jp/codexia. Use the task's existing checkout; the paths below are the Cloud-specific adapter, not repository runtime configuration. Keep the package-manager domains enabled and allow only required additional domains. Do not expand access to all public internet.

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /workspace/codexia

setup=/workspace/scratch/codexia
mkdir -p "$setup/bin" "$setup/cache" "$setup/state"
export PATH="$setup/bin:$PATH"
export COREPACK_HOME="$setup/corepack"
export XDG_CACHE_HOME="$setup/cache"
export XDG_STATE_HOME="$setup/state"
export NODE_USE_ENV_PROXY=1
export CODEXIA_CLOUD_STATE_DIR="$setup/state/test-postgres"

corepack enable --install-directory "$setup/bin" pnpm
pnpm install --frozen-lockfile --prefer-offline
bash scripts/dev/cloud-db.sh
```

The installer prepares the dependency cache and test PostgreSQL service. Do not build the product or run a full test suite on every environment installation. Build the required profile and install Playwright browsers only for tasks that need them. Docker/Compose and Node/Corepack availability must be checked on the actual Cloud host; a failed install is not acceptance.

## Codex Cloud startup skill

Use this instruction in the environment's startup skill field:

```markdown
# Codexia Core development

Use /workspace/codexia and follow AGENTS.md. For commits use the account's GitHub-provided noreply author and committer address. Do not change main directly.

For repository commands:
    export PATH="/workspace/scratch/codexia/bin:$PATH"
    export COREPACK_HOME=/workspace/scratch/codexia/corepack
    export XDG_CACHE_HOME=/workspace/scratch/codexia/cache
    export XDG_STATE_HOME=/workspace/scratch/codexia/state
    export NODE_USE_ENV_PROXY=1
    export CODEXIA_CLOUD_STATE_DIR=/workspace/scratch/codexia/state/test-postgres
    cd /workspace/codexia

For database-backed checks, start/reuse the disposable test PostgreSQL service:
    bash scripts/dev/cloud-db.sh
    set -a
    source "$CODEXIA_CLOUD_STATE_DIR/runtime.env"
    set +a

Use the repository's applicable checks (pnpm typecheck, pnpm test,
CODEXIA_PROFILE=core pnpm build, pnpm audit:core). Refresh dependencies with
pnpm install --frozen-lockfile --prefer-offline if the lockfile changes.
Install Chromium only when needed for author browser checks; follow the
existing verification contract for any remaining legacy or public/auth check.

For interactive Core UI/API work run:
    pnpm ui:preview --profile core --port 3000 --no-capture

Use the existing local OAuth sign-in at http://127.0.0.1:3000/desktop/.
Reuse the existing preview only if it belongs to this task and is healthy.
Stop it before rebuilding/restarting. The preview database is disposable.
Never use the test database for author data, disable authentication or
point tests at a production database. Keep generated credentials private.
Code Scanning and private VM access are independent, task-specific checks.
```

For a stopped service, run cloud-db.sh again. The generated credential and Docker volume must be kept together; a credential mismatch or port collision must fail rather than deleting an existing volume or adopting another container. If a task explicitly needs a fresh test database, use the standard Compose down command with --volumes **only for this disposable project**, then rerun cloud-db.sh. Do not delete the old unrelated development container/volume as part of migration.

Acceptance on Cloud: verify Docker/Compose and Corepack availability, run the installer twice, confirm all four test databases accept connections using their generated URLs, run an applicable PostgreSQL-backed test, then start the existing Core preview and sign in through OAuth. Check the actual API/browser behavior. No claim of Cloud acceptance is made from source review alone.
