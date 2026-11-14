# Standalone update release compatibility

This is the metadata and compatibility contract for standalone backend updates. It does not enable automatic deployment. A trusted publication and verification boundary must authenticate the exact manifest bytes, bind the registry digest to the certified source, and establish current channel membership and withdrawal status before invoking the compatibility policy.

## Manifest

The JSON object has exactly the following fields. All fields are required.

| Field | Value |
| --- | --- |
| `format` | `codexia-update-release/v1` |
| `channel` | `stable` |
| `state` | `published` or `withdrawn`; only published candidates are eligible |
| `version` | Stable numeric SemVer without a prefix, prerelease or build metadata |
| `sourceSha` | Exact 40-character lowercase source commit SHA |
| `image` | `ghcr.io/yohn-jp/codexia-backend@sha256:<64 lowercase hex characters>` |
| `platform` | `linux/amd64` |
| `profile` | `core` or `full` |
| `migrationFingerprint` | SHA-256 identity of the exact ordered migration filenames and their checksums, prefixed with `sha256:` |
| `persistenceFormat` | Positive integer compatibility epoch for durable non-SQL data and module records |
| `apiEpoch` | Positive integer compatibility epoch for browser/API wire semantics |

A metadata field is not proof of its claim. The publisher must derive and attest these identities from the released artifact, not from mutable tags or operator guesses. The controller must independently compare the real database's migration ledger to the candidate and validate the actual pulled image. Schema fingerprints must use one canonical encoding agreed by producer and verifier before automatic updates are enabled.

## Admission policy

`scripts/update-release-policy.mjs` validates authenticated metadata and rejects incompatible updates. The current installation record and candidate must have the same profile, platform, migration fingerprint, persistence format and API epoch. The supplied active UI epoch must agree with both API releases. During the initial rollout, a breaking browser/API change increments the epoch and is not eligible for independent automatic replacement. Previously served browser bundles and rollback compatibility must be accounted for before publishing an epoch.

Stable version numbers must strictly advance. Within major zero, minor versions are treated as breaking boundaries; only patch updates are eligible. For major one and later, minor and patch updates within the same major are eligible. A candidate must bind a distinct source commit and immutable backend image. Withdrawn releases, prereleases, unknown fields and incomplete metadata are rejected.

Changing a DB schema or persistent data format requires a planned manual upgrade. No compatibility check applies migrations.

The pure policy does not authenticate a publisher, query GHCR, verify registry freshness, track rollback history, activate a candidate or modify the database. Existing exact-main verification remains mandatory for publication. Do not treat success from this policy as deployment authorization.

## Automatic product version selection

See [automatic version releases](AUTO-RELEASE.md) for the release intent, release PR and operator activation contract. The compatibility admission policy above remains authoritative; automatic version selection never authorizes a schema migration or breaking host upgrade.

## Authenticated stable channel

The stable channel envelope has exactly two fields: `payload` (canonical base64 of the signed UTF-8 JSON bytes) and `signature` (canonical base64 of the 64-byte Ed25519 signature). The signed payload contains `format: "codexia-update-channel/v1"`, a positive monotonic integer `sequence`, UTC ISO millisecond timestamps `issuedAt` and `expiresAt`, and the complete currently advertised `releases` array using the manifest above. Its validity window may not exceed 24 hours. The publisher retains withdrawal records and must never republish a withdrawn identity. Sequence increases on every changed payload, including a freshness renewal.

`scripts/update-channel.mjs` signs and verifies exact bytes using an operator-pinned Ed25519 key. The verifier rejects expired/future, tampered, malformed, rollback or equivocated snapshots, using a durable checkpoint of sequence and payload hash supplied by the host. A first install requires an operator-trusted bootstrap checkpoint or an explicitly trusted initial snapshot. Later missing/corrupt checkpoint state must block automated updates rather than reset trust. The host must persist the returned checkpoint atomically before choosing or activating a candidate, including when no compatible update exists. Selection considers the newest published forward release for the installed platform/profile and does not silently downgrade to an older compatible candidate after rejecting the newest.

The private signing key must remain at the trusted publisher, never in the repository, API, Worker, or updater. Signing is not certification: the publisher must independently validate exact-main CI, immutable registry digest and artifact-derived identities before signing. The host must fetch a fresh channel over its configured authenticated transport, independently inspect the pulled artifact, and verify the real DB before activation. The host storage, delivery endpoint, automated publisher, key provisioning/rotation, and activation controller are separate implementation boundaries.

## Stable publication and observation

The backend publication workflow records the immutable registry digest after the exact-main certification gate and verifies that the pulled digest resolves to the locally tested image ID. Its downstream protected `codexia-stable-channel` job signs only that digest after matching the embedded identity and packaged SQL fingerprint to the certified checkout. Commits that do not advance the product version do not replace an already-advertised stable version.

The operator must explicitly provision the separate `codexia-stable-channel` branch, protect its write access, configure the protected environment secret `CODEXIA_CHANNEL_SIGNING_KEY` (Ed25519 private PEM), and enable `CODEXIA_STABLE_CHANNEL_ENABLED`. Bootstrap the empty signed channel through the manual maintenance workflow once. Publish a new product version through the normal backend release workflow; refresh the signed channel every four hours or manually, and withdraw by exact digest. The publisher uses a GitHub Contents blob-SHA compare-and-swap and will not reset a missing or unauthenticated channel. Channel validity is twelve hours; refresh failure makes clients refuse updates, not stop the installed API.

The host retrieves the raw signed document at the GitHub Contents endpoint `/repos/yohn-jp/codexia/contents/stable-channel.json?ref=codexia-stable-channel` using a host-only read credential. Its pinned public key and persistent checkpoint must be provisioned independently. The frontend advertises the actual built compatibility epoch and profile at `/desktop/update-identity.json` through the existing Access-protected static route with no-store. The host must check that endpoint, not a guessed local value. Older browser bundles are compatible only within the unchanged API epoch; introducing a breaking epoch requires an explicitly coordinated manual rollout.
