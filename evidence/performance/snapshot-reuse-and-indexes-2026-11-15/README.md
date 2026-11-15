# Snapshot reuse and index measurements

Matched before/after measurements using the PR #130 PostgreSQL performance harness. Both runs used separate fresh databases on the same loopback PostgreSQL 18.6 server, the same `long-form` synthetic fixture, core profile, 20 repeats, pool maximum 10, and lock polling interval 25 ms. Browser runs were disabled for both.

The fixture contains 400 documents, 378 scenes, 410 revisions, and 2,688,291 bytes of current manuscript text. PostgreSQL settings hashes match (`32b22fc8818ef557ae2b1a2edb77755d7a80d40dd93de7c9a266c19356103de8`); both used `shared_buffers=128MB`, `work_mem=4MB`, `fsync=on`, and `synchronous_commit=on`. The generated dataset manifests are byte-for-byte identical.

The baseline source is clean `origin/main` at `a7ebe0337e803bf70a142eaabf09b5a3c529106c`. The candidate uses that same base commit plus worktree diff SHA-256 `63f62f15943063e5e2d72e774224acd246fcb5c05bf764a932e1ca9493396de3`.

## Results

Times are application wall-clock milliseconds. Cold materialization and tree retrieval are one sample each in this harness; other listed reads have 20 samples.

| Operation | Samples | Before p50 / p95 | After p50 / p95 | Before → after SQL queries p50 |
| --- | ---: | ---: | ---: | ---: |
| `snapshot.materialize.cold` | 1 | 268.18 / 268.18 | 169.82 / 169.82 | 412 → 13 |
| `snapshot.current.warm` | 20 | 166.23 / 183.23 | 13.69 / 18.33 | 410 → 4 |
| `tree.retrieve` | 1 | 79.98 / 79.98 | 15.68 / 15.68 | 6 → 3 |
| `literal.search` | 20 | 186.33 / 208.01 | 16.15 / 19.20 | 410 → 4 |
| `writing.statistics` | 20 | 8,588.53 / 8,754.69 | 13.01 / 19.06 | 410 → 4 |

Writing statistics p50 fell by 99.85% (about 660×). The warm and search reads now fetch the one versioned Snapshot row instead of rematerializing documents and issuing one head-revision query per document. Cold materialization uses a batched exact document/revision lookup.

## Verification represented by tests

- Two concurrent cold current reads both observed a cache miss, produced the same projection, and converged on one immutable version key.
- Warm current tree and writing-statistics reads did not repeat document listing, head-revision lookup, module-record listing, or snapshot-write transactions.
- A project title update advanced the version and current reads returned the new title.
- A fresh CoreStore/PostgreSQL pool after restart read both the previous pinned Snapshot and the current Snapshot.
- Project, document create/update/delete and head changes, `core.document-paths`, `core.artifacts`, Knowledge nodes/aliases/relations, Evidence anchors/mentions/assertions/links all advanced the project version. Persisting `core.authority.snapshots` and proposal authority records did not.
- Batch head lookup tests cover input order, duplicate pairs, mismatched document/revision pairs, empty input, and cross-project scope.
- Snapshot index tests cover hierarchy order, first-match path and logical-ID behavior, and Unicode code-point writing counts.

## Raw evidence

- `before/results/` and `after/results/` contain the harness environment, raw Core samples, dataset manifest, run metadata, generated summary JSON, and summary tables.
- `before/long-form/` and `after/long-form/` contain the generated synthetic fixtures used for each run.
- Both worker statuses are `complete`; neither run reports failures or rejections.
- `SHA256SUMS` records the file digests for the preserved evidence.
