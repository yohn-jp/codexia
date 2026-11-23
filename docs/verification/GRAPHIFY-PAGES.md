# Graphify code map on Repository Audit Pages

`repository-audit.yml` is the sole Pages publisher. `/graph/` is now the **file explorer**, built from the same Graphify AST graph as the upstream viewer. The native, aggregated Graphify graph remains available at `/graph/communities.html`. No additional publisher, Cloud account, secret, browser library, or external LLM backend is required.

## Generation and scope

On `main` and manual runs, the publisher checks out the exact source SHA and runs `graphifyy[sql,terraform]==0.9.115` on Python 3.12, `graphify extract . --code-only` with `GRAPHIFY_BACKEND=none`, and `graphify cluster-only --no-label`. This configuration deliberately excludes `tests/**`, `docs/**`, `evidence/**`, `.agents/**`, and `*.test.*`/`*.spec.*`. The packer reads the **source** `graph.json` (not the aggregated HTML data), intersects the repository-relative `source_file` paths with `git ls-files --cached -z` from the same checkout (excluding untracked build outputs and external package names), constructs file and symbol indices, and publishes:

- `/graph/index.html` — fully self-contained file/path/symbol search, top-level directory filtering, relevance-first default selection and results, incoming/outgoing source references, and a clickable, focused file graph (up to eight neighbors on either side; full immediate lists below). Each file has a SHA-pinned GitHub source link and a shareable `?file=` URL.
- `/graph/communities.html` — the upstream Graphify HTML **unchanged**. Above the visualization threshold it shows one meta-node per community. The count at the bottom then describes the *aggregated view*, not the source-file count.
- `/graph/source.json` — exact source commit and aggregate counts for the indexed source graph.

`graph.json`, snippets, intermediate reports, and any configuration secrets are **not** published separately. The packer validates native HTML, the JSON structure and size limits and fails before publishing an incomplete set. Native HTML is limited to 20 MiB, source JSON to 80 MiB, and file-explorer HTML to 16 MiB.

## Interpretation

Cross-file source-reference rows are formed only from Graphify's directional `imports`, `imports_from`, `re_exports`, `calls`, `references`, `depends_on`, `instantiates`, `inherits`, `implements`, `extends`, and `uses` edges whose endpoints have different valid repository-relative source paths. Other edge types, same-file edges, untracked output, and external symbols are excluded from **file-reference** counts. Multiple symbol edges between the same two files are grouped, with the observed edge count and relation types preserved. Individual source-symbol names remain searchable.

**No incoming reference in Graphify does not mean unused or safe to delete.** The graph is static analysis and its extraction coverage is deliberately bounded; it does not prove actual runtime calls, route/MCP registrations, dynamic imports, SQL access, production reachability, or the presence of excluded tests. Likewise, a static reference does not prove a feature belongs in the agreed current architecture. Architecture and deletion decisions need separate verification.

## Verification

Run `node --test scripts/graphify-pages/pack.test.mjs` for edge normalization, source-to-target grouping, safe HTML data embedding, input validation, unchanged upstream graph and correct Pages files. In the Repository Audit PR preview, confirm `graph/index.html`, `graph/communities.html`, `graph/source.json` and test the file search, directory filter, source links, graph keyboard/click navigation in a real browser. The `main` publisher is the only workflow that deploys the graph.
