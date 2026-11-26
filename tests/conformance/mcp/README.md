# MCP conformance

The locked official conformance CLI runs the 2026-07-28 requirements suite against a loopback fixture using the current SDK, HTTP contribution, and tool registration. The native reports include the required and non-scored scenarios. A separate run removes the JSON-RPC `id` from a successful `tools/list` response and requires the official wire-schema check to report the missing field.

The runner also starts the current Fastify API and Core with a fresh PostgreSQL database and locally signed fixture tokens. The official conformance `tools-list` scenario targets this API through a loopback proxy that supplies one fixture token. Inspector connects directly over HTTP and through the shipped stdio entry point. It exercises the catalog, a Core action, and admission or schema errors. SDK probes verify wire errors and record the negotiated stdio versions. The synthetic loopback fixture rejects foreign Host and Origin headers; a separate direct live-product HTTP probe checks a valid loopback request and independently rejects a forged Host and a foreign Origin. These probes do not substitute for the full required conformance suite. The report marks the full requirements suite against the live product as untested.

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

The runner creates a fresh subdirectory under `CODEXIA_CI_REPORT_DIR`, which defaults to the ignored `test-results/conformance/mcp`. Open `report.json` for the outcome and use the remainder of that subdirectory for official CLI logs and checks. Unsuccessful required checks cause a nonzero exit.
