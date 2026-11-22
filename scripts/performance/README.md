# PostgreSQL performance baseline harness

See [Performance measurement](../../docs/performance/README.md) for evidence rules and [Backend read model](../../docs/architecture/BACKEND-READ-MODEL.md) for supported and rejected work envelopes. The harness uses PostgreSQL as the only runtime authority. Git carries deterministic synthetic fixture files only.

## Run against disposable PostgreSQL

Use a fresh loopback PostgreSQL database named `codexia_perf_*`. The fixture applies the repository migrations and creates synthetic records without cleanup. Do not point it at author, shared, CI, or production databases. From the repository root:

```sh
pnpm install --frozen-lockfile
CODEXIA_PROFILE=core pnpm build
podman run --detach --rm --name codexia-perf-baseline-20261115 \
  --publish 127.0.0.1:55440:5432 \
  --env POSTGRES_USER=codexia --env POSTGRES_PASSWORD=codexia \
  --env POSTGRES_DB=codexia_perf_baseline \
  docker.io/library/postgres@sha256:f4b419e350fd98d4a8429603295208976dea4c8fb8326d818d346d3e29f1db6f
export CODEXIA_TEST_DATABASE_URL='postgres://codexia:codexia@127.0.0.1:55440/codexia_perf_baseline'
export CODEXIA_AUTH_TEST_DISPOSABLE=1
export BENCH_REPEATS=20
export BENCH_BROWSER_SAVE_REPEATS=3
export BENCH_TIMEOUT_MS=600000
export CODEXIA_PERF_POOL_MAX=10
export CODEXIA_PERF_LOCK_POLL_MS=25
node scripts/performance/run.mjs /tmp/codexia-postgresql-baseline-20261115
node scripts/performance/summarize.mjs /tmp/codexia-postgresql-baseline-20261115/results
```

The output path must be new. The runner records the exact source and dirty state, built output hashes, toolchain, OS/CPU, PostgreSQL version and `pg_settings` snapshot/hash, fixture hashes, sample counts and cold/warm conditions. Raw JSON, the machine summary, Markdown tables and Chromium CPU profiles remain under the output directory. Keep raw evidence outside product documentation.

`BENCH_SIZES` selects a comma-separated subset of `small,long-form,knowledge-dense,limit-999,limit-1000,limit-1001`. `BENCH_BROWSER_SIZES` selects browser runs and defaults to `small,long-form`. `BENCH_TIMEOUT_MS` defaults to 600000 (10 minutes) per worker; the earlier 180-second budget is insufficient for the measured long-form fixture. `BENCH_REPEATS` controls Core and browser navigation repeats; `BENCH_BROWSER_SAVE_REPEATS` controls editor save/receipt repeats per document size and defaults to 3. Set these variables before the command to narrow a run. `CODEXIA_E2E_CHROMIUM` selects a system Chromium; otherwise Playwright's installed Chromium is used. Browser probes use `/desktop/`, the Better Auth browser OAuth flow, the authenticated Persistence API, real PostgreSQL revisions, isolated browser storage and the current IndexedDB journal/save protocol.

## PostgreSQL fixture dimensions

| Fixture | Persisted documents | Shape and additional records | Expected snapshot outcome |
| --- | ---: | --- | --- |
| `small` | 8 | 1 volume, 1 chapter, 6 scenes; first 3 bodies are 1 KiB, 100 KiB and 1 MiB, remaining bodies 4 KiB; 3 extra revisions on the first scene | supported |
| `long-form` | 400 | 2 volumes, 20 chapters, 378 scenes; first 3 bodies are 1 KiB, 100 KiB and 1 MiB, remaining bodies 4 KiB; 10 extra revisions on the first scene | supported |
| `knowledge-dense` | 100 | 1 volume, 5 chapters, 94 scenes; first 3 bodies are 1 KiB, 100 KiB and 1 MiB, remaining bodies 2 KiB; 100 Knowledge nodes, 200 aliases, 400 Evidence anchors/mentions, 100 assertions and supporting links; 5 extra revisions | supported |
| `limit-999` | 999 | 1 volume, 1 chapter, 997 scenes; first 3 bodies are 1 KiB, 100 KiB and 1 MiB, remaining bodies 1 KiB; 1 extra revision | supported |
| `limit-1000` | 1,000 | 1 volume, 1 chapter, 998 scenes; first 3 bodies are 1 KiB, 100 KiB and 1 MiB, remaining bodies 1 KiB; 1 extra revision | rejected with `snapshot_too_large` |
| `limit-1001` | 1,001 | 1 volume, 1 chapter, 999 scenes; first 3 bodies are 1 KiB, 100 KiB and 1 MiB, remaining bodies 1 KiB; 1 extra revision | rejected with `snapshot_too_large` |

Dataset identity is derived from the fixed plan and content hashes, independent of the temporary output path or generated PostgreSQL IDs. Before migration or seeding, the importer verifies the manifest, transport plan and exact scene bytes against that identity. Persisted document and revision counts, logical Markdown bytes, PostgreSQL tuple bytes, Knowledge/Evidence row counts and bytes, and measured projection bytes are recorded from the database or actual Core projection. Fixture setup time is recorded separately and is never included in workload latency.

## Workloads and interpretation

Core workloads measure cold current snapshot materialization, repeated current reads, first and warm pinned reads, scene/tree reads, Knowledge/Evidence projection access, literal search, writing statistics, revision listing/body reads, and document save/proposal/approval/apply/receipt replay. Projection bytes are recorded from the pinned reader; projection generation is included in cold snapshot materialization. `limit-999` through `limit-1001` exercise the existing document guard; expected rejection wall time is retained as a rejection record, not successful latency.

Browser workloads measure login readiness, author login, project/scene navigation, editor changes, strict IndexedDB journal writes, and PostgreSQL save receipts at the three body sizes. They use the built API and the product authoring UI. Each browser worker builds assets for its own OAuth registration and records their hash under `harness.browserAssets`. Authentication fixture setup and browser asset build time are separate from the measured workload phases. Synthetic keyboard events and animation-frame opportunities are probes, not native IME or input-to-pixel acceptance.

Each successful operation stores application wall time, Node CPU/RSS, SQL query count, returned rows, PostgreSQL driver's `rowCount`, serialized result bytes, SQL round-trip time, pool acquisition time, transaction duration, sampled PostgreSQL lock waits, projection/result bytes and process I/O where available. Browser phases also capture browser CPU/RSS, IndexedDB activity, API status/body sizes, network transfer and long tasks. SQL round-trip time includes client/network overhead; it is not PostgreSQL executor-only time. Lock wait is a 25 ms `pg_stat_activity` sample and may miss short waits. PostgreSQL server CPU/RSS and scanned-row/physical-I/O counts are not measured by this harness.

Cold means the first Core materialization in a fresh worker for a new project version. PostgreSQL shared buffers and host page caches are not flushed. Pinned reads use the durable projection written by that cold materialization. Compare only matched source/build, fixture, browser, database configuration, pool settings, sample counts and conditions. Seeding, migrations, API startup, failed operations, pending operations and timeouts are not successful workload latency. A `NOT_CHECKED` worker remains incomplete even when earlier successful samples are retained.

Run the focused harness tests with the other required checks from [Verification](../../docs/verification/README.md):

```sh
CODEXIA_TEST_DATABASE_URL='postgres://codexia:codexia@127.0.0.1:55440/codexia_perf_harness_tests' \
  pnpm exec node --test scripts/performance/*.test.mjs
```

Set `CODEXIA_E2E_CHROMIUM` and `CODEXIA_AUTH_TEST_DISPOSABLE=1` after a Core build to additionally execute the browser benchmark smoke and IndexedDB probes. The Core CI writing browser lane also executes the same smoke against a fresh disposable database on its private PostgreSQL service, through a loopback-only forwarding adapter. The smoke is not a full matched performance campaign. The focused test database must also be disposable; the persistence pipeline test adds records and does not clean them up. Full verification uses the separate `codexia_test` database described by the verification guide.

Historical Core64, Git/OCI and release probes are specific to their recorded source/artifact identities. They are not measurements of current PostgreSQL authoring. The historical artifact packer/verifier continues to serve the immutable [wave0 evidence](../../docs/performance/README.md).
