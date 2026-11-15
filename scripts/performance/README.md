# Core benchmark harness

See [Performance measurement](../../docs/performance/README.md) for evidence requirements and [Backend read model](../../docs/architecture/BACKEND-READ-MODEL.md) for correctness.

## PostgreSQL Core workloads

From the repository root, use a fresh disposable PostgreSQL database. The fixture applies migrations and creates projects without cleanup; never use an author or production database.

```sh
pnpm install --frozen-lockfile
CODEXIA_PROFILE=core pnpm build
node --test scripts/performance/*.test.mjs
export CODEXIA_TEST_DATABASE_URL='postgres://user:password@127.0.0.1:55440/codexia_benchmark'
node scripts/performance/dataset.mjs /tmp/new-fixture small
node scripts/performance/core.mjs /tmp/new-fixture /tmp/read.json 20 read
```

The other supported Core workload arguments are `mutation`, `revisions`, `search` and `stats`. Mutation runs propose/approve/apply with at most five iterations; search and stats currently produce one operation sample per invocation. Repeat independent runs before interpreting distributions. `revisions` measures snapshot reader enumeration, not the complete document revision history API. `postgres-fixture.mjs` imports only generated manuscript hierarchy and text into PostgreSQL; Git history, filler and attachments in the seed are not PostgreSQL revision counts or bytes. Dataset tiers describe generated tracked files (small 10, medium 1,000, large 10,000, stress 100,000). Large/stress exceed the current document guard; treat those outcomes as capacity/limit observations, not latency or successful coverage.

`run.mjs` orchestrates tiers and workloads in fresh output directories, with `BENCH_SIZES`, `BENCH_REPEATS`, `BENCH_TIMEOUT_MS`, `BENCH_IDLE_MS` and optional `CODEXIA_E2E_CHROMIUM`. It retains partial results on timeout. `summarize.mjs` consumes the results directory. Do not use an orchestration run as full browser acceptance: the historical `server.mjs` / `browser.mjs` path still uses the retired Git Core bootstrap and requires a PostgreSQL-backed adapter before it can measure the current product. Historical Core64 and Git/OCI probes are specific to their recorded source and artifact identities.

## Interpretation and evolution

Measure cold and warm reads, mutations and recovery separately, with actual sample counts and matched data. Extend fixtures to report persisted document/revision/Knowledge/Evidence counts and bytes and to distinguish setup from operation timing. Instrument SQL and resource use in the benchmark/test harness, not with persistent production hooks. Reuse the existing result serialization and summary where compatible. A current browser probe must use real PostgreSQL-backed API, actual authoring protocol and isolated IndexedDB; frame-opportunity proxies and synthetic IME are not native input-to-pixel measurements. Preserve raw results, command, source, fixture and failure information; never interpret NOT_CHECKED as success. See [Verification](../../docs/verification/README.md) for functional acceptance.
