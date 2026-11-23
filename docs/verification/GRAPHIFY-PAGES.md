# Graphify code map on Repository Audit Pages

`repository-audit.yml` is the sole Pages publisher. **Code Map** (`/graph/`) and the native Graphify community viewer use the same Graphify AST graph. See the [portal UX design](../design/DEVELOPMENT-PAGES-UX.md#4-graphifyの分析ux重点改善案).

## Generation and scope

PR previews and main builds check out the exact source SHA. The pack step runs `graphifyy[sql,terraform]==0.9.115` on Python 3.12, `graphify extract . --code-only` with `GRAPHIFY_BACKEND=none`, and `graphify cluster-only --no-label`. The workflow supplies the same exclusion flags to Graphify extraction and candidate detection. The packer builds the explorer from the source `graph.json` and limits the index to Git-tracked paths in that checkout.

- **Explorer** at `/graph/`. Search paths and symbols, choose incoming or outgoing references, filter by relation, and expand through multiple levels. The graph bounds the number of displayed results and retains the full immediate file lists. A selection can be reopened through `?file=` and, for a selected symbol, `?symbol=`.
- **Community overview** at `/graph/communities.html`. Graphify generates this HTML. Above its visualization threshold each node represents a community.
- **Source metadata** at `/graph/source.json`. It records the source SHA, coverage and indexed file paths. Atlas uses the SHA and indexes to check whether a file link can open in Code Map.

Exported coverage records tracked paths, measured Graphify code candidates and files represented by extracted nodes. A candidate without indexed nodes is reported as unavailable. Source JSON, snippets and intermediate Graphify reports are working inputs. Native HTML is limited to 20 MiB, source JSON to 80 MiB, and explorer HTML to 16 MiB.

## Interpretation

Cross-file counts group observed directional edges by endpoint file and relation. In symbol mode the original source and target identities also support references within a file. Evidence links open SHA-pinned source and include a line only when Graphify provides one for the edge.

**No incoming reference in Graphify does not mean unused or safe to delete.** The graph is static analysis and its extraction coverage is deliberately bounded; it does not prove actual runtime calls, route/MCP registrations, dynamic imports, SQL access, production reachability, or the presence of excluded tests. Likewise, a static reference does not prove a feature belongs in the agreed current architecture. Architecture and deletion decisions require comparison with the [canonical system design](../architecture/SYSTEM-DESIGN.md) and [documentation authority](../architecture/DOCUMENTATION-AUTHORITY.md), plus independent reachability verification. A graph edge cannot overrule a design constraint.

## Verification

Run `node --test scripts/graphify-pages/*.test.mjs` for edge normalization, coverage, bounded traversal, graph packaging and browser interactions when Chromium is configured. Repository Audit Pages verifies the assembled preview in Chromium under the project path. Main is the publishing branch.
