# Performance measurement

The [backend read model](../architecture/BACKEND-READ-MODEL.md) and [optimization decisions](../architecture/decisions/OPTIMIZATION-BOUNDARIES.md) define correctness constraints. This document owns how to measure improvements, not a second architecture or benchmark campaign status.

Use matched synthetic PostgreSQL workloads, disposable databases and exact baseline/candidate source and build identities. Measure current and pinned reads, cold construction and warm reuse, Knowledge/Evidence projection, tree/scene, search/statistics, history, mutations/receipts, and end-to-end navigation separately. Compare the same project hierarchy, body bytes, revision history, evidence density, concurrency, database settings, toolchain, instrumentation and cache conditions. Record counts of actual persisted records, not Git fixture file totals.

For backend work capture SQL query counts, rows and bytes, database and application wall time, transaction/lock duration, CPU, RSS, pool contention, projection bytes and growth. Capture cold and warm distributions with sample counts and raw measurements, and distinguish one-time seeding from operations. Include near-limit and rejected cases; timeouts and errors are not successful latency observations. Do not combine separate experiments into an aggregate speedup. Do not use real author data or change authentication, durability, scope or revision checks to improve a metric.

The [benchmark harness](../../scripts/performance/README.md) documents runnable entrypoints and limitations. Its synthetic Git seed generator is only fixture transport; PostgreSQL is the runtime authority. Historical Git-era measurements and browser probes that still instantiate the retired Core API are not valid current PostgreSQL baselines. Repair or replace only the affected measurement adapters before relying on them. Actual browser/IME acceptance remains separate from performance probes and synthetic events.

## Immutable historical evidence

The retained `evidence/performance/wave0/INDEX.json` is the exact manifest for the historical raw measurement archive. Check the archive before extraction and validate each compressed and raw member using the existing artifact verifier:

```sh
index=evidence/performance/wave0/INDEX.json
evidence=$(mktemp -d)
gh release download perf-wave0-2026-10-20 --repo yohn-jp/codexia \
  --pattern codexia-wave0-2026-10-20.tar --dir "$evidence"
node scripts/performance/artifacts.mjs verify-archive "$index" "$evidence"
tar -xf "$evidence/codexia-wave0-2026-10-20.tar" -C "$evidence"
node scripts/performance/artifacts.mjs verify "$index" "$evidence"
```

Retain immutable comparison inputs and raw evidence outside product documentation. A historical archive is not a current performance claim; specialized probes must bind their own runtime and artifact identities.
