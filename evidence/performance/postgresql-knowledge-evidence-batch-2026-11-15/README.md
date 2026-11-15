# PostgreSQL Knowledge/Evidence batch-read comparison

Matched before/after measurements for the Knowledge-dense PostgreSQL snapshot workload. Both runs use the PR #130 Core harness and synthetic `knowledge-dense` fixture on the same PostgreSQL 18.6 container image and host. Raw worker reports, summarized distributions, fixture manifests, and projection bytes are in [`raw/`](raw/).

## Conditions

- Before source: clean `origin/main` commit `a7ebe0337e803bf70a142eaabf09b5a3c529106c`.
- After source: clean candidate commit `852e52c0316663142d1356ba83cdd848be8244e1`.
- Fixture: `knowledge-dense`, profile SHA-256 `736a9df8d85b6765e9477ad4afd192479c314b9d3197cdbd609f73e0503c2546`.
- PostgreSQL: 18.6 (Debian 18.6-1.pgdg13+2), container image `docker.io/library/postgres@sha256:f4b419e350fd98d4a8429603295208976dea4c8fb8326d818d346d3e29f1db6f`; separate disposable databases, same server settings hash `32b22fc8818ef557ae2b1a2edb77755d7a80d40dd93de7c9a266c19356103de8`.
- Host: NixOS 26.05, Linux 6.18.52, x64, Intel Core i5-14600KF, 16 logical CPUs, 50,994,458,624 bytes RAM. Node `v24.21.0`, pnpm `12.10.1`.
- Both runs: Core profile, 20 repeats, 600,000 ms timeout, pool max 10, lock polling 25 ms, no browser sizes. Fixture generation, seeding, migrations, and startup are excluded from workload timing. PostgreSQL and host caches were not flushed.
- `environment.json` and `run.json` replace machine-local worktree/output paths with placeholders. Measurement content and identities are unchanged. All benchmark and projection content is synthetic; no database credentials are recorded.

## Results

Values show median (`p50`) unless noted. Cold materialization is one sample; warm current and scene are 20 samples. SQL rows, CPU and RSS are harness observations, not PostgreSQL executor CPU or server RSS.

| Operation | Before | After | Change |
| --- | ---: | ---: | ---: |
| Cold materialization SQL queries (`n=1`) | 1,406 | 136 | -90.3% |
| Warm current SQL queries (`n=20`) | 1,404 | 134 | -90.5% |
| Warm current app wall time p50 / p95 | 290.30 / 313.89 ms | 73.91 / 78.97 ms | p50 -74.5% |
| Warm current SQL round trip p50 | 243.82 ms | 44.68 ms | -81.7% |
| Warm current Node CPU p50 | 132.67 ms | 60.13 ms | -54.7% |
| Warm current peak RSS | 200.42 MiB | 204.87 MiB | +4.45 MiB |
| Warm current returned SQL rows p50 | 1,596 | 1,596 | unchanged |
| Warm current serialized SQL result bytes p50 | 5,425,048 | 5,440,582 | +15,534 B (+0.29%) |
| Persisted Knowledge projection size | 606,777 B | 606,777 B | unchanged |

Cold wall time was 341.80 ms before and 124.07 ms after; cold Node CPU p50 was 185.12 ms and 120.28 ms, respectively. Cold peak RSS was 163.55 MiB and 152.82 MiB. The warm peak RSS and returned SQL result bytes rose slightly; this change therefore claims lower query count, wall time, and Node CPU, with no RSS or SQL-result-byte reduction claim.

## Projection equivalence

The exact same persisted PostgreSQL project snapshot was projected by the baseline implementation and the candidate implementation. The baseline direct projection also matched the stored snapshot. Both serialized outputs are 626,287 bytes with SHA-256 `c5dfd175602e2ef2ea0fb764fcf0cda28c5f0e151697653aa58a2fbf04028c4a`; `projection-equivalence.json` records the byte-for-byte comparison and snapshot identity, and both complete outputs are preserved in raw evidence.

## Scope and limits

This comparison targets SQL fan-out and repeated Knowledge/Evidence reads during snapshot materialization. The change retains a single reader transaction and bounded parameterized batches with per-parent limits. Snapshot reuse, document head revision reads, Tree, search, and writing-statistics internal indexes were not changed. Returned rows and projection output are unchanged. Warm current scene results are also retained in [`raw/before/tables.md`](raw/before/tables.md) and [`raw/after/tables.md`](raw/after/tables.md). SQL round-trip time includes the driver and loopback path. PostgreSQL executor-only time, server CPU/RSS, physical row scans, and cold-cache behavior were not measured.
