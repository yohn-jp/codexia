# Integration verification

Build the Full workspace before integration tests. Run acceptance only against disposable synthetic data. Model caches, credentials and generated artifacts belong outside the checkout.

```sh
pnpm install --frozen-lockfile
CODEXIA_PROFILE=full pnpm build
```

## MCP and approved mutation

These required checks need a disposable PostgreSQL database. The MCP and legacy-inspection tests fail clearly if database configuration is absent; use `CODEXIA_TEST_DATABASE_URL` for this disposable database. A database-dependent skip is not acceptance evidence. For a local run:

```sh
docker run --rm -d --name codexia-integration-postgres \
  -e POSTGRES_USER=codexia -e POSTGRES_PASSWORD=codexia \
  -e POSTGRES_DB=codexia_test -p 55440:5432 postgres:17-alpine
export CODEXIA_TEST_DATABASE_URL='postgres://codexia:codexia@127.0.0.1:55440/codexia_test'
until docker exec codexia-integration-postgres pg_isready -q -U codexia -d codexia_test >/dev/null 2>&1; do sleep 1; done
```

Stop the disposable database after verification with `docker stop codexia-integration-postgres`.

```sh
CODEXIA_MCP_ACCEPTANCE_MODULES=story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp \
  node --test tests/integration/mcp-acceptance.test.mjs
```

This runs production stdio and SDK Streamable HTTP transports against PostgreSQL. It checks scoped native Knowledge access, project/version boundaries, proposal replay, stale-preview rejection, provider non-execution, MCP bearer denial of approval/application, and owner HTTP approval/application with a durable receipt. With the full module set shown here, a separate test also exercises cancellation through the real NLP worker on both transports; a restricted native MCP composition does not require NLP. Partial module proposal approval and retry after Core reconstruction remain covered by `packages/api/src/server.test.ts` and `modules/story/tests/production.acceptance.mjs`. MCP can propose native changes; it cannot grant itself author approval. The provider-admission probe confirms denied Assistant calls make no provider request or usage record.

## Import and derived-state reconstruction

The Diagnostics production acceptance needs `CODEXIA_TOKENIZER_MODELS_DIR` to point to an external tokenizer cache containing the same pinned `tokenizer.json` and `tokenizer_config.json` at both `Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78/` and `Xenova/multilingual-e5-small/`. These tokenizer files are required; model weight files are not. Set the variable before running the command below; without the pinned tokenizer artifacts, the required acceptance is unavailable and must not be reported as passed.

```sh
export CODEXIA_TOKENIZER_MODELS_DIR=/path/to/tokenizer-cache
node --test modules/diagnostics/tests/production.acceptance.mjs
node --test tests/integration/migration-acceptance.test.mjs
```

These checks exercise derived-state reconstruction and read-only legacy inspection through Core review against PostgreSQL. Migration acceptance repeats inspection and proposal submission, checks operation replay receipts after reconnecting to PostgreSQL, preserves an author-maintained Speaker correction and opaque records with both Story enabled and disabled, and compares the legacy Git/files/SQLite sources before and after review and application. The migration package tests also check deterministic operation identity and withholding conflicting producer writes. `packages/migration` is an operator-side conversion tool; the ordinary product import is the portable PostgreSQL work archive described in [Core architecture](../architecture/CORE.md). The integration acceptance does not exercise Git publish, remote commit reconstruction, or Git as runtime persistence. Diagnostics recovery after reopening PostgreSQL remains covered by its production acceptance test. A local fixture round trip does not establish hosted lifecycle behavior.

## CPU model lifecycle

Provide a model cache containing the artifacts required by the acceptance sources. The tests bind model repository/revision identities; arbitrary replacement weights do not satisfy those checks. Cache preparation may require downloading public models and tokenizer artifacts. Review their licenses and reserve appropriate disk and memory capacity.

```sh
CODEXIA_P13_MODEL_CACHE=/path/to/model-cache \
  node --test tests/integration/model-lifecycle.acceptance.mjs

OCI_ENGINE=podman CODEXIA_P13_MODEL_CACHE=/path/to/model-cache \
  node --test tests/integration/model-oci-lifecycle.acceptance.mjs
```

The OCI test builds the Full production image, mounts the model cache read-only and exercises inference without network access. It checks shared model leases, cancellation, disable/release, index rebuild, launcher replacement, health and preserved author state. Confirm actual worker/process release; dropping a JavaScript reference alone does not establish native memory release. Model absence or an unsupported host is an unavailable check, not successful inference.

## Provider execution

MCP integration acceptance uses a synthetic provider probe only to verify that denied Assistant requests make no provider call or usage record. The previous local-provider reference that streamed model output and published approved rewrites is retired with the Git publish and `remoteCommit` verification contract. Optional CPU model execution is described above; it requires its own model cache and does not certify provider streaming or model output quality.

## PostgreSQL restore and container replacement

Use an isolated PostgreSQL database with synthetic projects. Apply the checked migrations, create sample documents and revisions through the API, then dump and restore the database into a blank instance. Start a replacement API process against the restored database and verify project/document history, revision reads, authorization scope, `/health/ready`, and browser draft recovery on the same origin. Keep the PostgreSQL URL and restored data private. `OCI_ENGINE` selects the local engine and `CODEXIA_E2E_CHROMIUM` may select a system browser.

Only the exact tested source/artifact and executed assertions are certified. Keep private fixture URLs, tokens, manuscript content and raw recovery records out of public reports.
