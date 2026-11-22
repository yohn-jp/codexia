# Graphify code graph on Repository Audit Pages

The sole Pages publisher remains `.github/workflows/repository-audit.yml`. Its existing artifact includes `/ci/` and now includes `/graph/`. No second Pages deployer, new permission, token or external Graphify Cloud service is introduced.

On `main` pushes and manual dispatch, the publisher checks out the exact source tree, runs `graphifyy==0.9.115` with Python 3.12, `--code-only --backend none`, and copies the self-contained `graph.html` to `graph/index.html`. PR changes to the publishing workflow or packer also build a non-publishing preview artifact. The graph excludes tests, documentation, evidence, agent skills and test/spec files to keep the diagram useful and bounded. The source SHA is written to `graph/source.json`.

The packer refuses a missing, malformed, or >20 MiB HTML document. `graph.json`, source snippets and the generated report are not copied into the public Pages artifact separately. The HTML itself still exposes code structure, names, and relationships: only use this on the public repository. Graphify is third-party code executed without secrets; its version is pinned and it has no configured LLM backend. The job is time-limited and cannot publish partial output. An extraction failure blocks a new Pages deployment rather than silently replacing the previous graph.

Graphify's edges are static-analysis observations, not runtime dependency proofs. The diagram does not replace required CI verification or the existing CI Observatory.

Validation: `node --test scripts/graphify-pages/pack.test.mjs` and the repository-audit PR preview. The preview must contain `graph/index.html` and `graph/source.json`, and the eventual `main` run must deploy `/graph/` successfully.
