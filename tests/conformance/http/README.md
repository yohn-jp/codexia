# HTTP Schemathesis conformance

`run.mjs` runs the official Schemathesis CLI against the generated OpenAPI and the current Fastify server backed by a dedicated disposable PostgreSQL database. It selects all generated persistence operations (39 of 115 operations on the current main source). The other operation groups are excluded from this G2 pass because auth, MCP, streaming, module, and owner API routes require their own fixture setup; they are not counted as covered here.

The harness runs three checks:

1. The complete persistence operation selection against the PostgreSQL-backed Fastify fixture.
2. An unmodified `GET /api/v1/persistence/projects` response control.
3. A test-only loopback proxy that changes that same operation's successful response body to `[]`. The official `ST108` response schema failure, operation, exact response body, nonzero exit, and single proxy mutation are required evidence.

## Local run

Build the API dependency closure first:

```sh
pnpm --filter @codexia/api... build
```

Create a fresh loopback-only disposable database named `codexia_perf_http_conformance`, then run:

```sh
CODEXIA_AUTH_TEST_DISPOSABLE=1 \
CODEXIA_HTTP_CONFORMANCE_DATABASE_URL=postgres://<test-user>:<test-password>@127.0.0.1:<port>/codexia_perf_http_conformance \
  node --import tsx tests/conformance/http/run.mjs
```

The runner maps this URL into the existing Better Auth test fixture with its explicit disposable database opt-in. It requires the caller to set `CODEXIA_AUTH_TEST_DISPOSABLE=1` explicitly and refuses to start if that opt-in is missing or if the fixture's disposable-database guard rejects the URL. Schemathesis 4.34.2 is invoked with `uvx` locally. In CI, create the isolated Python environment from `requirements.lock.txt` using the shared Python environment helper and set `SCHEMATHESIS_BIN` to its executable.

`CODEXIA_CI_REPORT_DIR` selects the evidence directory; locally the default is ignored `test-results/conformance/http`. Reports and logs are sanitized before they are copied out of a temporary Schemathesis working directory.

The baseline is allowed to fail when the current generated contract and live API disagree. The runner preserves the completed Schemathesis report and fails the task in that case; only remediation in the owning API/contract work can make the baseline green.
