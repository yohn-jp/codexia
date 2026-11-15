# Performance measurement

The [backend read model](../architecture/BACKEND-READ-MODEL.md) and [optimization decisions](../architecture/decisions/OPTIMIZATION-BOUNDARIES.md) define correctness constraints. This document owns how to measure improvements, not a second architecture or benchmark campaign status.

Use matched synthetic PostgreSQL workloads, disposable databases and exact baseline/candidate source and build identities. Measure current and pinned reads, cold construction and warm reuse, Knowledge/Evidence projection, tree/scene, search/statistics, history, mutations/receipts, and end-to-end navigation separately. Compare the same project hierarchy, body bytes, revision history, evidence density, concurrency, database settings, toolchain, instrumentation and cache conditions. Record counts of actual persisted records, not Git fixture file totals.

For backend work capture SQL query counts, rows and bytes, database and application wall time, transaction/lock duration, CPU, RSS, pool contention, projection bytes and growth. Capture cold and warm distributions with sample counts and raw measurements, and distinguish one-time seeding from operations. Include near-limit and rejected cases; timeouts and errors are not successful latency observations. Do not combine separate experiments into an aggregate speedup. Do not use real author data or change authentication, durability, scope or revision checks to improve a metric.

The [benchmark harness](../../scripts/performance/README.md) documents runnable entrypoints and limitations. Its deterministic Git fixture is transport only; both Core and browser workloads run against the current PostgreSQL-backed product. The browser probe uses the authenticated Persistence API, current editor, IndexedDB recovery journal and PostgreSQL revision receipt. Historical Git-era measurements do not describe current PostgreSQL behavior. Actual browser/IME acceptance remains separate from performance probes and synthetic events.

Treat cold as first Core materialization in a fresh worker for a new project version. Database and host caches are not flushed. Compare exact source/build, fixture, database configuration, browser, sample counts and cold/warm conditions. Fixture setup, failed operations and timeouts are not successful workload latency. Store baseline manifests and raw machine evidence under `evidence/performance/`, outside this product documentation; do not turn a measurement baseline into a performance improvement claim.

## Immutable historical evidence

Select the immutable archive manifest from the [evidence index](../../evidence/README.md). Its storage record is authoritative for the release repository, tag, asset name, length and SHA-256; do not derive these from the current product name. Check the archive before extraction and validate each compressed and raw member using the existing artifact verifier. Run the following in Bash with GitHub CLI authentication for the repository named in the manifest:

```sh
set -e
index=/path/to/INDEX.json
evidence=$(mktemp -d)
asset=$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const { storage } = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const url = new URL(storage.url);
  const match = /^\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/releases\/download\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+\.tar)$/.exec(url.pathname);
  if (storage.type !== "github-release-asset" || url.origin !== "https://github.com" ||
      url.username || url.password || url.search || url.hash || !match || match[3] !== storage.file) {
    throw new Error("Invalid archive storage locator");
  }
  console.log(match.slice(1).join(" "));
' "$index")
read -r repo tag archive <<< "$asset"
gh release download "$tag" --repo "$repo" --pattern "$archive" --dir "$evidence"
node scripts/performance/artifacts.mjs verify-archive "$index" "$evidence"
tar -xf "$evidence/$archive" -C "$evidence"
node scripts/performance/artifacts.mjs verify "$index" "$evidence"
```

Retain immutable comparison inputs and raw evidence outside product documentation. A historical archive is not a current performance claim; specialized probes must bind their own runtime and artifact identities.
