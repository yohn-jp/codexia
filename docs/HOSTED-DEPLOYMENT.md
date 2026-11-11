# Codexia hosted deployment

This guide describes how to build the standalone Core/Full profiles and the hosted Runtime Base, Build Kit, and selected composition using the existing Codexia build entry points. Hosted deployment consumes the canonical `codexia-build/v1` and `codexia-platform/v1` contracts. Praetorium remains the owner of instance lifecycle, Gateway/Instance Access, and the BuildKit worker. PostgreSQL is Codexia's only authoring database.

## Core and Full standalone images

Use Node 24 and the pnpm version declared by the Codexia root manifest. From a clean Codexia checkout:

```sh
docker build --target runtime --build-arg PROFILE=core -t codexia:core .
docker build --target runtime --build-arg PROFILE=full -t codexia:full .
```

The same package outputs can be prepared outside a container. Each output directory must be new and outside the workspace:

```sh
node scripts/profile-package.mjs --profile core --out /tmp/codexia-core
node scripts/profile-package.mjs --profile full --out /tmp/codexia-full
```

Run either standalone image with `CODEXIA_AUTH_TOKEN` of at least 32 characters and `CODEXIA_DATABASE_URL` pointing to a migrated PostgreSQL database. PostgreSQL stores all authoring state. Mount `/data` for derived module caches and `/history` for private usage/job history. These standalone settings do not apply to Hosted mode.

## Runtime Base and Build Kit

Hosted images target `linux/amd64`. Runtime Base and Build Kit must be published to the same OCI repository because the `gateway.v0` frontend resolves Runtime Base from the repository in its immutable `source` option. Use a disposable, owned registry for verification. Do not use a branch name as an artifact identity; record each pushed image's manifest digest.

Start from a clean commit and set the image repository and an output directory outside the checkout:

```sh
set -eu
REVISION="$(git rev-parse HEAD)"
test "$(git status --porcelain)" = ""
IMAGE_REPOSITORY='<owned-registry>/<namespace>/codexia'
ARTIFACT_DIR='/tmp/codexia-hosted-build'
mkdir -p "$ARTIFACT_DIR"
```

Build and push the two immutable inputs to the owned disposable registry. The `CODEXIA_DOCKERFILE_SHA256` value binds the Build Kit image to the exact Dockerfile bytes:

```sh
DOCKERFILE_SHA256="$(sha256sum Dockerfile | awk '{print $1}')"

docker buildx build --platform linux/amd64 --target runtime-base \
  --build-arg "CODEXIA_PRODUCER_REVISION=$REVISION" \
  --tag "$IMAGE_REPOSITORY:runtime-base-$REVISION" \
  --metadata-file "$ARTIFACT_DIR/runtime-base-metadata.json" --push .

docker buildx build --platform linux/amd64 --target buildkit \
  --build-arg "CODEXIA_PRODUCER_REVISION=$REVISION" \
  --build-arg "CODEXIA_DOCKERFILE_SHA256=$DOCKERFILE_SHA256" \
  --tag "$IMAGE_REPOSITORY:buildkit-$REVISION" \
  --metadata-file "$ARTIFACT_DIR/buildkit-metadata.json" --push .
```

Read `containerimage.digest` from each metadata file and use those `sha256:` values below. The mutable tags above are only push labels; all catalog and BuildInput references use digests. Generate the versioned catalog from the same clean checkout after those digests are known:

```sh
RUNTIME_BASE_DIGEST='<sha256:64-lowercase-hex>'
BUILD_KIT_DIGEST='<sha256:64-lowercase-hex>'

corepack pnpm@12.10.1 install --frozen-lockfile
corepack pnpm@12.10.1 build
node scripts/hosted-build.mjs catalog \
  --producer-revision "$REVISION" \
  --runtime-base-digest "$RUNTIME_BASE_DIGEST" \
  --build-kit-digest "$BUILD_KIT_DIGEST" \
  --out "$ARTIFACT_DIR/build-catalog.json"
```

Catalog generation requires `producerRevision` to equal `git rev-parse HEAD` and a clean worktree. Keep generated files outside the checkout. The catalog records the source, recipe, and lock digests, supported platform, shipped module versions/artifact digests, dependency requirements, resource data, Runtime Base digest, and Build Kit digest.

Resource profiles are allocation policy, not measured workload minima: `small` is 500m CPU, 512 MiB memory, and 1 GiB ephemeral storage; `balanced` is 2 CPU, 4 GiB memory, and 8 GiB ephemeral storage; `large` is 4 CPU, 8 GiB memory, and 16 GiB ephemeral storage. The base runtime allocation is 250m CPU, 256 MiB memory, and 512 MiB ephemeral storage. Modules with a shipped `workerEntry` share one `worker-runtime` allocation (1 CPU, 4 GiB memory, 512 MiB ephemeral storage); the Semantic module adds one shared `semantic-models` allocation (1 CPU, 2 GiB memory, 4 GiB ephemeral storage). The resolver charges each shared group once for the selected dependency closure. The full module closure therefore requires 2.25 CPU, 6,400 MiB memory, and 5,120 MiB ephemeral storage and fits the `large` profile. `workerLimits` records the existing runtime-wide WorkerSupervisor defaults and ceilings: 8 concurrent jobs, 8 queued one-shot jobs, 8 worker services, 1 concurrent job per service, and 4 queued jobs per service. These values describe allocation and admission policy; they do not claim model-workload measurements or per-module worker pools.

## Selected hosted composition

Create a canonical `codexia-build/v1` BuildInput from the verified catalog and the requested modules using Praetorium's existing resolver and canonical BuildInput encoder. Its fields are exactly `contractVersion`, `producerRevision`, `runtimeBaseDigest`, `buildKitDigest`, `recipeDigest`, `sourceDigest`, `lockDigest`, `requestedModules`, `resolvedModules`, `platform`, and `options`. Set `platform` to `linux/amd64` and `options` to `{}` for this producer. Every resolved module includes its catalog `id`, `version`, and `artifactDigest`. Base64url-encode the canonical JSON bytes into `INPUT_BASE64URL`; the Build Kit repeats the source, recipe, lock, resolver, and artifact checks before composing an image.

Praetorium's Build Worker runs the following BuildKit frontend command. Keep its `source` bound to the Build Kit digest, and use a unique candidate tag derived from the build key and attempt identity:

```sh
buildctl \
  --addr "$BUILDKIT_ADDR" \
  --tlsservername "$BUILDKIT_TLS_SERVER_NAME" \
  --tlscacert "$BUILDKIT_CA_FILE" \
  --tlscert "$BUILDKIT_CLIENT_CERT_FILE" \
  --tlskey "$BUILDKIT_CLIENT_KEY_FILE" \
  build --progress=rawjson --frontend gateway.v0 \
  --opt "source=$IMAGE_REPOSITORY@$BUILD_KIT_DIGEST" \
  --opt "codexia.build-input.v1=$INPUT_BASE64URL" \
  --output "type=image,name=$CANDIDATE_TAG,push=true" \
  --metadata-file "$ARTIFACT_DIR/composition-metadata.json"
```

The BuildKit metadata file's `containerimage.digest` is the candidate image digest. The composed image contains the composition manifest and producer report under `/usr/share/codexia`; admission must inspect the pushed image bytes and verify its actual server/browser package closure, native dependencies, and startup smoke before accepting it. The recipe's smoke starts a temporary local PostgreSQL database from smoke-only binaries in the Build Kit, then runs with network access disabled and no author credentials. Neither a user's PostgreSQL data, a user grant, a repository credential nor an App key is a build input or shared cache entry.

Core and Full remain standalone presets. Hosted selections use the same shipped module manifests and `resolveBuildCatalogSelection` resolver; dependency modules are included automatically, incompatible or unknown selections fail. The resulting image stores runtime metadata, the composition manifest, the build catalog, and the package lock under `/usr/share/codexia`, with the selected runtime under `/app`.

## Hosted runtime files and credentials

Run the composed image with `CODEXIA_HOSTED_MODE=1`, `CODEXIA_PROFILE=hosted`, and the generated hosted module profile. Supply `CODEXIA_DATABASE_URL` through the API service's secret configuration, set `CODEXIA_DATABASE_MIGRATE_ON_START=1`, and set `CODEXIA_HOSTED_PROJECT_ID` to the existing PostgreSQL project assigned to this runtime. Startup fails closed if the database or project binding is unavailable. Keep PostgreSQL on the private data network; the browser and Tunnel never connect to it directly.

Mount the exact canonical RuntimeAssignment JSON read-only at `/run/scriptorium/runtime-assignment.json`; `CODEXIA_RUNTIME_ASSIGNMENT_PATH` may override that path when the deployment mounts the same file elsewhere. Assignment validation retains the numeric repository, canonical repository URL, instance, runtime epoch, image and composition digests, enabled modules, and issuer/JWKS policies used by Gateway authorization and runtime control. Codexia uses the explicit PostgreSQL project binding for all authoring reads and writes and does not clone or publish the assigned repository. Runtime-control credentials are verified with `controlServicePolicy.jwksUrl`; user access grants are verified with the separate `grantPolicy.jwksUrl`. Public JWKS endpoints expose public keys only. Private signing keys and service credentials stay in their owning services.

`GET /api/platform/v1/metadata` is public and reports the immutable producer revision, listener, health paths, and shutdown contract. It carries no user or repository data. `GET /api/platform/v1/status`, `POST /api/platform/v1/quiesce`, and `POST /api/platform/v1/resume` are private control routes; they require a short-lived signed runtime-control credential verified with the assignment's `controlServicePolicy.jwksUrl`. Browser/API grants use the separate Gateway `grantPolicy.jwksUrl`.

Do not set `CODEXIA_AUTH_TOKEN` or `CODEXIA_GITHUB_TOKEN` in Hosted mode. Instance Access issues the browser grant, and Codexia checks its signature, assigned repository/instance/epoch binding, and current permissions at each protected API boundary. Codexia does not contact the repository credential broker or request GitHub App tokens. The browser receives neither PostgreSQL credentials nor runtime-control credentials.

## Browser access and authoring

Route `/_platform/handoff`, `/_platform/refresh`, `/_platform/logout`, and `/_platform/reauth` on the instance's same origin to Praetorium Instance Access. An authenticated Gateway `/entry/:instanceId` creates the one-use handoff for that origin. Instance Access sets the HttpOnly `__Host-praetorium_access` grant cookie and the readable `__Host-praetorium_csrf` cookie. The grant binds user, repository, instance, runtime epoch, permissions, and authorization/session revisions. Codexia verifies this grant for browser/API requests; MCP Bearer requests use the same policy and cannot override an ambiguous cookie. Cookie writes require the same origin and matching CSRF header.

The browser refreshes through `POST /_platform/refresh` with the CSRF header. If the grant is stale for a new runtime epoch, a failed refresh goes to `/_platform/reauth`, which clears stale cookies and returns the browser to Gateway for a fresh authorized handoff on the same instance origin. Logout uses `POST /_platform/logout`. Instance Access owns these routes and credentials; Codexia does not exchange or persist a refresh token.

The browser keeps its private recovery journal in IndexedDB and submits revision-bound proposals through the authenticated API. Codexia checks the current write permission, records approval and applies accepted operations in PostgreSQL transactions. A committed transaction returns PostgreSQL document revisions and a project version. Stale project or document versions produce conflicts; keep the browser recovery entry for author review instead of dropping it.

PostgreSQL is the durable project history. The composition declares the selected module persistence contracts and browser recovery version. Project records, documents, immutable revisions, knowledge, evidence, proposals and module-owned authoritative records are scoped by project ID in API routes and database queries. Runtime status reports `provider: postgres`, assigned `projectId` and `projectVersion`. A database outage or missing project reports unknown durability and blocks safe quiesce. Private usage/job history remains on the separately mounted `/history` volume.

## Producer admission

Use [producer attestation](hosted-producer-attestation.md) to generate and verify the canonical Sigstore bundle from immutable inputs. Statement generation alone does not sign or admit a release. Admission binds the producer revision, source/recipe/lock digests, Runtime Base and Build Kit digests, composition key and pushed composition bytes. Test browser, PostgreSQL authoring, permission checks and lifecycle behavior against the admitted artifact in an owned verification environment.
