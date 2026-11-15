# PostgreSQL native performance baseline

This is a reproducible measurement baseline for future backend work. It makes no performance improvement claim. Raw worker reports, deterministic fixture manifests, the complete machine summary, generated metric tables and Chromium CPU profiles are in [`raw/`](raw/).

## Measured source and environment

- Harness source: clean commit `9e02d34f8dd4a00f321f1f43df9c63f6d09b4c05` (`perf/postgresql-benchmark-baseline` before this evidence commit).
- Build identity: `app/dist` SHA-256 `97aa72377d2f7cd9495ce3f9493b7f65eaa4addd85db89113cfddfa97b7c5953`; `packages/core/dist` `2829988958fbfedac6ea77b1f0a6199c56766ece8a04cd4b0c1de9a4b6a5007f`; `packages/api/dist` `dd1c4fe62e86fe87bd4a46f87db0ce2a894171dd0eaa1393fb54b883b7ef4438`; `packages/persistence-postgres/dist` `911097628cc2fb6331532fc773d0bffdc43e8d2f1522364b855278342733ef60`.
- Host: NixOS 26.05 (Yarara), Linux `6.18.52`, x64, Intel Core i5-14600KF, 16 logical CPUs, 50,994,458,624 bytes RAM.
- Toolchain: Node `v24.21.0`, pnpm `12.10.1`, Chromium `156.0.8078.47`.
- Database: PostgreSQL `18.6 (Debian 18.6-1.pgdg13+2)`, container image `docker.io/library/postgres@sha256:f4b419e350fd98d4a8429603295208976dea4c8fb8326d818d346d3e29f1db6f` (local image ID `a1be1c8380f5c8ca80b4ad72f6be191f8a283e0ecb2e9496b1ee67dc0022d0f1`), bound to `127.0.0.1:55440`. Settings SHA-256: `f2969251c9a5932c27a3f2a166ea455936a046a073b39e42e5c1f1c485c3faa4`. Key settings: `shared_buffers=128MB`, `work_mem=4MB`, `effective_cache_size=4GB`, `max_connections=100`, `fsync=on`, `synchronous_commit=on`, isolation `read committed`; pool maximum 10.
- Workload settings: 20 Core and browser navigation repeats, 3 browser save repeats per document size, 600,000 ms worker timeout, 25 ms PostgreSQL lock sampling interval. Setup and build were excluded from workload latency. PostgreSQL shared buffers and host page caches were not flushed.

Raw paths that name the local worktree or temporary output directory were replaced with placeholders; measured values and source/build identities were not changed. The disposable database URL password is omitted from this report. All fixtures contain synthetic content.

## Reproduction command

Run from the repository root with a fresh loopback PostgreSQL database and a system Chromium. The password below is a placeholder for a disposable synthetic database role.

```sh
pnpm install --frozen-lockfile
CODEXIA_PROFILE=core pnpm build
export CODEXIA_TEST_DATABASE_URL='postgres://codexia_perf_luna:<disposable-password>@127.0.0.1:55440/codexia_perf_run_luna3'
export CODEXIA_E2E_CHROMIUM='/nix/store/r0f9i35n3r7rng8162xih4c1dag0s1vw-chromium-156.0.8078.47/bin/chromium'
export BENCH_REPEATS=20
export BENCH_BROWSER_SAVE_REPEATS=3
export BENCH_TIMEOUT_MS=600000
export CODEXIA_PERF_POOL_MAX=10
export CODEXIA_PERF_LOCK_POLL_MS=25
node scripts/performance/run.mjs /tmp/codexia-postgres-baseline-luna-20261115-r3
node scripts/performance/summarize.mjs /tmp/codexia-postgres-baseline-luna-20261115-r3/results
```

Fixture identities and actual persisted sizes below are recorded in `raw/dataset-*.json` and `raw/core-*.json`. Each fixture ID is derived from the deterministic synthetic plan and content, independent of generated PostgreSQL IDs.

## Dataset dimensions and persisted inventory

`Fixture body B` is the generated corpus body-byte total. `Current / all-revision Markdown B` is measured from persisted PostgreSQL rows. `Document / revision / Knowledge / Evidence tuple B` reports per-project sums of `pg_column_size` for those row types; it excludes indexes and database-wide allocation. Evidence rows are anchors / anchor history / mentions / assertions / assertion-evidence links.

| Fixture (identity SHA-256) | Shape | Docs / revisions | Fixture body B | Current / all-revision Markdown B | Document / revision / Knowledge / Evidence tuple B | Knowledge rows (nodes / aliases / relations) | Evidence rows | Projection B | Snapshot |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `small` (`7d971750c801c46d1f1cae8ab2d5677a599e6a57562cad54ddd5e4eda2c70589`) | 1 volume, 1 chapter, 6 scenes; 1 KiB, 100 KiB, 1 MiB and 4 KiB bodies; 3 extra revisions | 8 / 11 | 1,164,288 | 1,164,375 / 1,167,534 | 1,133 / 20,496 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 | 897 | Supported |
| `long-form` (`4eab012822fc5db8e02e5c2bb24275ca02c7df8d7d9acccd5d09c9eab7d511a2`) | 2 volumes, 20 chapters, 378 scenes; 1 KiB, 100 KiB, 1 MiB and 4 KiB bodies; 10 extra revisions | 400 / 410 | 2,688,000 | 2,688,291 / 2,699,836 | 57,565 / 185,752 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 | 48,885 | Supported |
| `knowledge-dense` (`736a9df8d85b6765e9477ad4afd192479c314b9d3197cdbd609f73e0503c2546`) | 1 volume, 5 chapters, 94 scenes; 1 KiB, 100 KiB, 1 MiB and 2 KiB bodies; 5 extra revisions | 100 / 105 | 1,338,368 | 1,338,513 / 1,343,923 | 14,384 / 57,624 / 56,816 / 215,991 | 100 / 200 / 0 | 400 / 400 / 400 / 100 / 100 | 606,777 | Supported |
| `limit-999` (`aaedb47ec021a6e296e46cf1b2774b3e16ee269ff2cb47148767325203b6fdf3`) | 1 volume, 1 chapter, 997 scenes; 1 KiB, 100 KiB, 1 MiB and 1 KiB bodies; 1 extra revision | 999 / 1,000 | 2,169,856 | 2,169,885 / 2,170,909 | 143,840 / 1,209,488 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 | — | Supported; tree 67,099 B |
| `limit-1000` (`82fc0522c982fdf86c655a4fa02f05f80459602b6890ed71cc2f51fc1d74fb55`) | 1 volume, 1 chapter, 998 scenes; same boundary body plan | 1,000 / 1,001 | 2,170,880 | 2,170,909 / 2,171,933 | 143,984 / 1,210,688 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 | — | Rejected: `snapshot_too_large` |
| `limit-1001` (`ea9f9ffcd3e5dd6501fde242691fbfb0fc6b79e8ce46f7f75aa955e621745807`) | 1 volume, 1 chapter, 999 scenes; same boundary body plan | 1,001 / 1,002 | 2,171,904 | 2,171,933 / 2,172,957 | 144,128 / 1,211,888 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 | — | Rejected: `snapshot_too_large` |

The repeated body plan means the first three scenes contain the listed 1 KiB / 100 KiB / 1 MiB sizes, with the remaining documents at the fixture's default size. The complete plans are included in each raw dataset manifest. The 1,000- and 1,001-document rejection durations are rejection records only, never successful workload samples.

## Selected baseline observations

Application wall time is shown as p50 / p95 milliseconds. Cold materialization, tree retrieval and projection access are single observations (`n=1`); warm and repeated operations use 20 observations. Full distributions for application and SQL time, SQL queries, rows returned, PostgreSQL driver's `rowCount`, SQL result bytes, CPU, RSS, transactions, lock-bearing transactions, lock sampling and process I/O are in [`raw/tables.md`](raw/tables.md) and [`raw/summary.json`](raw/summary.json).

| Core dataset | Cold current snapshot (`n=1`) | Warm current (`n=20`) | Warm pinned (`n=20`) | Literal search (`n=20`) | Writing statistics (`n=20`) | Save / proposal / apply receipt (`n=20` each) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 35.61 / 35.61 | 15.54 / 18.51 | 12.23 / 14.18 | 14.93 / 17.62 | 26.57 / 32.21 | 2.78 / 3.08; 11.86 / 12.78; 21.30 / 23.54 |
| long-form | 276.82 / 276.82 | 156.92 / 184.95 | 71.55 / 80.51 | 194.16 / 223.37 | 8,172.96 / 8,233.82 | 2.54 / 3.07; 96.35 / 114.63; 189.63 / 218.90 |
| knowledge-dense | 386.74 / 386.74 | 281.66 / 331.50 | 26.43 / 31.19 | 267.48 / 293.71 | 526.02 / 551.71 | 7.94 / 8.84; 283.04 / 307.50; 527.56 / 615.80 |

Save / proposal / apply is ordered as document save, proposal creation, then operation apply with receipt. Approval and receipt-replay measurements, along with separate scene, tree and history reads, appear in the raw tables. The dense projection's actual content size was 606,777 bytes; projection access took 0.56 ms (`n=1`) after the projection was persisted by the Core snapshot.

| Browser fixture | Project and first-scene navigation (`n=1`) | Repeated navigation (`n=20`, p50 / p95) | Authoring save and PostgreSQL receipt (`n=9`, p50 / p95) | Requests / failed | Strict IndexedDB write p95 by document size |
| --- | ---: | ---: | ---: | ---: | --- |
| small | 216.90 ms | 125.50 / 166.02 ms | 1,268.89 / 3,236.61 ms | 336 / 0 | 1 KiB: 114.60–131.20 ms; 100 KiB: 264.70–329.70 ms; 1 MiB: 1,581.40–1,705.90 ms |
| long-form | 383.06 ms | 272.11 / 321.35 ms | 1,379.36 / 3,240.02 ms | 336 / 0 | 1 KiB: 208.60–255.40 ms; 100 KiB: 355.70–399.50 ms; 1 MiB: 1,648.00–1,829.00 ms |

Browser measurements use the authenticated Persistence API, PostgreSQL revisions and the current editor/IndexedDB journal protocol. Save samples cover three document sizes with three repeats per size. Each browser fixture completed all 336 requests with no failed requests; API statuses and request/body sizes are retained in raw reports. Browser tests and all Core workers reported zero runtime Git processes.

## Coverage, interpretation and limits

- Core records cold materialization; current and pinned warm reads; current and pinned scene reads; tree retrieval; Knowledge/Evidence projection; literal search and writing statistics; history listing and revision bodies; document save; proposal creation and approval; operation apply/receipt; and receipt replay. Browser runs cover startup/login, project and scene navigation, strict journal writes, editor input, PostgreSQL save and receipt.
- Every successful Core operation recorded SQL query count, returned rows, driver `rowCount`, serialized SQL result bytes, SQL round-trip time, pool acquisition, transaction wall time, lock-bearing statement/transaction duration, sampled lock waits, app wall time, Node CPU/RSS and process I/O. Browser samples additionally record browser CPU/RSS, API process CPU/RSS, network/body sizes, IndexedDB transactions and browser input probes. Seed/setup time is recorded separately.
- SQL round-trip includes the client and loopback network; it is not PostgreSQL executor-only time. `rowCount` is PostgreSQL driver's command count and can differ from rows returned. Lock waits are sampled every 25 ms and short waits may be missed. Reported tuple bytes are not index, WAL or database-allocation size. Cold means first Core materialization in a fresh worker for a new project version; database and host caches remain warm according to the observed environment.
- PostgreSQL server CPU/RSS, executor-only time, physical/scanned row counts, and native OS IME/input-to-pixel latency were not measured. Browser editor input uses synthetic keyboard events and animation-frame opportunities. Offline recovery, process-crash and long-idle behavior were also not measured; see each raw report's `notMeasured` list.
- The harness rejects snapshot materialization at 1,000 and 1,001 documents with `snapshot_too_large`; 999 documents are supported. No failed operation or timeout is represented as a successful latency sample. This run completed without failed workloads or timeouts.

`environment.json` and `run.json` retain placeholders in place of machine-local worktree and temporary-output paths. Their measurement fields are unchanged. `SHA256SUMS` covers all raw files except itself.
