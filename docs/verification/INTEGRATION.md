# Integration verification

Build the Full workspace before integration tests. Run acceptance only against disposable synthetic data. Model caches, credentials and generated artifacts belong outside the checkout.

```sh
pnpm install --frozen-lockfile
CODEXIA_PROFILE=full pnpm build
```

## MCP and approved mutation

```sh
CODEXIA_MCP_ACCEPTANCE_MODULES=story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp \
  node --test tests/integration/mcp-acceptance.test.mjs
```

This runs the production stdio and SDK Streamable HTTP transports with Core and optional modules. It checks project isolation, cancellation, proposal replay, partial approval, revision-bound PostgreSQL application and reconstruction. MCP may propose changes but cannot grant itself approval or author permission. Provider-free checks must remain usable without external transmission.

## Import and derived-state reconstruction

```sh
node --test modules/diagnostics/tests/production.acceptance.mjs
node --test tests/integration/migration-acceptance.test.mjs
```

These checks exercise derived-state reconstruction and legacy manuscript import into PostgreSQL through Core review. Verify idempotence, authoritative corrections/settings, retained provisional records, source immutability and recovery after replacing the API process. A local fixture round trip does not establish hosted lifecycle behavior.

## CPU model lifecycle

Provide a model cache containing the artifacts required by the acceptance sources. The tests bind model repository/revision identities; arbitrary replacement weights do not satisfy those checks. Cache preparation may require downloading public models and tokenizer artifacts. Review their licenses and reserve appropriate disk and memory capacity.

```sh
CODEXIA_P13_MODEL_CACHE=/path/to/model-cache \
  node --test tests/integration/model-lifecycle.acceptance.mjs

OCI_ENGINE=podman CODEXIA_P13_MODEL_CACHE=/path/to/model-cache \
  node --test tests/integration/model-oci-lifecycle.acceptance.mjs
```

The OCI test builds the Full production image, mounts the model cache read-only and exercises inference without network access. It checks shared model leases, cancellation, disable/release, index rebuild, launcher replacement, health and preserved author state. Confirm actual worker/process release; dropping a JavaScript reference alone does not establish native memory release. Model absence or an unsupported host is an unavailable check, not successful inference.

## Local provider reference

The provider reference accepts a loopback OpenAI-compatible endpoint serving `Qwen3-0.6B-Q4_K_M`. Prepare the model outside the repository and start a compatible `llama-server` with reasoning disabled:

```sh
llama-server --model /path/to/Qwen3-0.6B-Q4_K_M.gguf \
  --host 127.0.0.1 --port 18088 --ctx-size 2048 --threads 4 \
  --n-gpu-layers 0 --alias Qwen3-0.6B-Q4_K_M \
  --reasoning off --reasoning-format none --reasoning-budget 0
```

Then run the production Assistant/MCP reference against synthetic inputs:

```sh
CODEXIA_MCP_ACCEPTANCE_MODULES=story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp \
CODEXIA_MCP_ACCEPTANCE_REWRITE_PROVIDER=qwen-local \
CODEXIA_ASSISTANT_REFERENCE_PROVIDER=qwen-local \
ARCADIA_LLM_PROVIDER=openai-compatible \
ARCADIA_LLM_BASE_URL=http://127.0.0.1:18088/v1 \
ARCADIA_LLM_MODEL=Qwen3-0.6B-Q4_K_M \
ARCADIA_LLM_API_KEY=local-only-placeholder \
node --test tests/integration/mcp-acceptance.test.mjs
```

The placeholder is for the local fixture endpoint. The checks exercise streaming, cancellation, durable usage, context preview, author-selected proposals and PostgreSQL reconstruction. They do not certify model output quality. Stop the provider process after the run.

## PostgreSQL restore and container replacement

Use an isolated PostgreSQL database with synthetic projects. Apply the checked migrations, create sample documents and revisions through the API, then dump and restore the database into a blank instance. Start a replacement API process against the restored database and verify project/document history, revision reads, authorization scope, `/health/ready`, and browser draft recovery on the same origin. Keep the PostgreSQL URL and restored data private. `OCI_ENGINE` selects the local engine and `CODEXIA_E2E_CHROMIUM` may select a system browser.

Only the exact tested source/artifact and executed assertions are certified. Keep private fixture URLs, tokens, manuscript content and raw recovery records out of public reports.
