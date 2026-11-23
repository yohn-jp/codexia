# Codexia threat model

**Status: accepted design-time risk inventory; runtime acceptance not claimed.** The source model is [`threagile/model.yaml`](threagile/model.yaml). Product behavior, authorization, persistence, deployment and recovery semantics remain owned by the referenced normative design documents and [requirement register](../requirements/REQUIREMENT-REGISTER.md).

Threagile owns threat scenarios, assets, trust boundaries, risk identifiers and mitigations. The [LikeC4 model](likec4/model.likec4) owns C4 structure and trust relationships. G5 checks LikeC4 element boundaries and required/forbidden relations, plus the required Threagile risk-to-boundary and risk-to-asset assignments. Those selected structural invariants correspond to the approved API, PostgreSQL, external MCP, Cloudflare, protected operations, backup and public Pages surfaces; neither model certifies deployment or attack resistance.

## Tracked risks

| Threagile risk ID | Required design references | Threat focus | Tracking state |
| --- | --- | --- | --- |
| `codexia-bola-project-isolation` | REQ-AUTH-002, REQ-DATA-003 | Object or project identifier crosses an authorization boundary | `unchecked` |
| `codexia-mcp-issuer-resource` | REQ-AUTH-001, REQ-AUTH-003, REQ-EXT-002, REQ-MCP-001 | OAuth issuer, resource, client assignment or MCP scope is confused | `unchecked` |
| `codexia-session-scope-confusion` | REQ-AUTH-002, REQ-AUTH-003, REQ-AUTH-005 | Owner, browser session, external MCP client and reader disclosure scopes are confused | `unchecked` |
| `codexia-false-db-receipt` | REQ-DATA-002, REQ-API-002 | A mutation is reported as committed without a durable PostgreSQL revision receipt | `unchecked` |
| `codexia-edge-operations-plane` | REQ-EXT-001, REQ-OPS-001, REQ-OPS-002 | Public Cloudflare routing is mistaken for project authorization or host administration | `unchecked` |
| `codexia-backup-key-restore` | REQ-OPS-003, REQ-OPS-004, REQ-OPS-005 | Age key separation, ciphertext identity, independent receipt or isolated restore fails | `unchecked` |
| `codexia-public-pages-disclosure` | REQ-EXT-002, REQ-QUAL-002 | A public static architecture artifact contains credentials or private source data | `unchecked` |

The `risk_tracking` entries use wildcard patterns to bind each category to its generated Threagile risk instances. Every risk remains `unchecked`; the listed mitigations are design controls that require separate implementation and runtime evidence. No risk is marked `mitigated` or `false-positive` by this model.

## Ownership and trust boundaries

- **Clients:** Desktop Web and native iOS are the approved client targets. Their local draft journals are separate recoverable stores, not manuscript authorities. The existing Mobile React/Capacitor implementation is not represented as an approved client target.
- **Cloudflare edge:** Workers Static Assets and Tunnel/API ingress route traffic. Access protects the UI entry and never substitutes for Fastify's principal, project, object and effect authorization.
- **Application and data:** Fastify admission, Better Auth, MCP, shared domain actions, the trusted optional module runtime and the PostgreSQL persistence adapter lead to PostgreSQL as the sole canonical data authority.
- **Host operations:** Protected GitHub Actions uses Tailscale OIDC, pinned SSH and Ansible to reach the approved host operations path. The web UI, API and MCP adapter do not reach SSH or Ansible.
- **Backup and offsite storage:** The existing host-locked `backup.sh` path handles PostgreSQL and history data. It transfers age-encrypted ciphertext to S3-compatible storage and verifies retrieved bytes and an independent protected receipt. S3 support and isolated restore remain unimplemented design targets.
- **Public Pages:** The existing Repository Audit Pages publisher exposes allowlisted static artifacts. The model treats this public boundary separately from the protected GitHub Actions workflow; G5 scans architecture inputs and generated public-source material for credential-like values.

These groupings describe trust relationships in the design. Actual Cloudflare, Tailscale, SSH, PostgreSQL, secret-store, S3 and restore-host configuration must be verified independently.

## G5 static verification

The scoped verifier runs LikeC4 syntax/semantic validation and structural boundary checks, regenerates the checked Mermaid derivative byte-for-byte, analyzes the Threagile model with the pinned image, checks required risk instances and suppression state, and scans public architecture inputs for secret-like values.

It injects a wrong LikeC4 trust boundary, marks a required risk as mitigated, and inserts a synthetic bearer value. Each injection must be rejected by its corresponding check. This proves that the static gate detects those model faults; it does not prove the live API, OAuth, UI, host, backup or restore implementation.

Run from a clean source checkout:

```sh
npm ci --prefix scripts/architecture --ignore-scripts --no-audit --no-fund
node scripts/architecture/verify.mjs "$CODEXIA_ARCHITECTURE_EVIDENCE_DIR"
```

`CODEXIA_ARCHITECTURE_EVIDENCE_DIR` must be outside the repository. The verifier writes the exact source SHA, input digests, tool identities and generated JSON outputs there. The evidence directory is not copied into Repository Audit Pages.
