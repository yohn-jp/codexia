# MCP conformance

The locked official conformance CLI runs the 2026-07-28 server requirements derived from the official frozen manifest against both a loopback fixture using the current SDK/registrars and the live Fastify/Core/PostgreSQL product. It invokes scenarios individually so each native report retains its required or non-scored classification. The full required scenario set, including `dns-rebinding-protection`, runs against fixed loopback endpoints. Pending and extension scenarios remain unscored and are run with the official CLI's `--force` flag so native pass/failure/skipped outcomes are visible. A separate run removes the JSON-RPC `id` from a successful synthetic `tools/list` response and requires the official wire-schema check to report the missing field.

The product suite runs through a loopback proxy that supplies one fixture token to the actual Fastify/Core/PostgreSQL endpoint. It does not add conformance-only tools or alter the production tool catalog. Inspector connects directly over HTTP and through the shipped stdio entry point. It exercises the catalog, a Core action, and admission or schema errors. SDK probes verify wire errors and record the negotiated stdio versions. Host and Origin admission are exercised directly and through the product proxy. The proxy translates its valid loopback authority but preserves an untrusted Host/Origin for rejection by the actual product; it never uses these headers to choose a socket destination.

The live product must return a JSON-RPC parse error `-32700` (HTTP 400, null id) for malformed JSON after MCP admission. The epoch 4 TypeSpec contract declares this envelope alongside the existing ApiError. The API compatibility guard remains active for the explicitly scoped initial-install epoch transition.

## Local run

```sh
pnpm --filter @codexia/api... build
npm ci --prefix tests/conformance/mcp --ignore-scripts --no-audit --no-fund
```

Create a dedicated disposable database named `codexia_perf_mcp_conformance` on a loopback PostgreSQL server, then run:

```sh
CODEXIA_AUTH_TEST_DISPOSABLE=1 \
CODEXIA_MCP_CONFORMANCE_DATABASE_URL='postgres://test-user:test-password@127.0.0.1:5432/codexia_perf_mcp_conformance' \
  node --import tsx tests/conformance/mcp/run.mjs
```

The runner creates a fresh subdirectory under `CODEXIA_CI_REPORT_DIR`, which defaults to the ignored `test-results/conformance/mcp`. Open `report.json` for the outcome and use the remainder of that subdirectory for official CLI logs and checks. The scenario summary records successful scenarios with official warnings as `SUCCESS_WITH_WARNINGS`. The authorization summary requires direct Host/Origin rejection and a proxy-path regression check as well as the existing OAuth checks. Required failures and exclusions cause a nonzero exit.
