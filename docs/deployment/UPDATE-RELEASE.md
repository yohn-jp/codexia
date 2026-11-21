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

## Authenticated stable channel

The stable channel envelope has exactly two fields: `payload` (canonical base64 of the signed UTF-8 JSON bytes) and `signature` (canonical base64 of the 64-byte Ed25519 signature). The signed payload contains `format: "codexia-update-channel/v1"`, a positive monotonic integer `sequence`, UTC ISO millisecond timestamps `issuedAt` and `expiresAt`, and the currently advertised `releases` array using the manifest above. Its validity window may not exceed 24 hours. The v1 verifier accepts at most 1000 release records and at most 1 MiB of signed payload. When either bound is reached, the publisher drops the oldest records as needed while retaining the newest two published releases per platform/profile and the exact release being withdrawn. Hosts still require signed membership for the active and previous release during an update or rollback; a host that remains offline across multiple promotions may need operator-assisted recovery if its installed release has aged out of the bounded channel.

The protected `codexia-stable-channel` branch also stores `stable-channel-registry.json`, a publisher-only Ed25519-signed history registry. It binds the exact current channel document bytes and sequence, and retains every released identity and withdrawal status so eviction never permits an old version, source or digest to be advertised again. The publisher authenticates both files from one immutable branch commit, creates a replacement Git tree and child commit containing both, then advances the branch with a non-force ref update. Concurrent writers based on the same head conflict; retry only after rereading and authenticating the new head. Existing complete v1 channels migrate their history into the registry on the first maintenance operation. Once a parent commit contains the registry, a missing registry blocks publication instead of reconstructing history from the bounded channel.

The registry is a single Git blob. Its signed JSON payload is capped at 64 MiB so the base64 envelope remains below GitHub's 100 MiB Git object/API limit. A registry that reaches this ceiling fails closed; the channel remains unchanged. Sequence increases on every changed channel payload, including a freshness renewal.

`scripts/update-channel.mjs` signs and verifies exact bytes using an operator-pinned Ed25519 key. The verifier rejects expired/future, tampered, malformed, rollback or equivocated snapshots, using a durable checkpoint of sequence and payload hash supplied by the host. A first install requires an operator-trusted bootstrap checkpoint or an explicitly trusted initial snapshot. Later missing/corrupt checkpoint state must block automated updates rather than reset trust. The host must persist the returned checkpoint atomically before choosing or activating a candidate, including when no compatible update exists. Selection considers the newest published forward release for the installed platform/profile and does not silently downgrade to an older compatible candidate after rejecting the newest.

The private signing key must remain at the trusted publisher, never in the repository, API, Worker, or updater. Signing is not certification: the publisher must independently validate exact-main CI, immutable registry digest and artifact-derived identities before signing. The host must fetch a fresh channel over its configured authenticated transport, independently inspect the pulled artifact, and verify the real DB before activation. The host storage, delivery endpoint, automated publisher, key provisioning/rotation, and activation controller are separate implementation boundaries.

## Stable publication and observation

The backend publication workflow records the immutable registry digest after the exact-main certification gate and verifies that the pulled digest resolves to the locally tested image ID. It never replaces an existing commit tag. On retry, an existing digest is reused only if it matches the locally tested image ID or passes the full backend image verification for the same source, version and profile. Its downstream protected `codexia-stable-channel` job verifies both Core and Full immutable digests, embedded identities and packaged SQL fingerprints against the same certified checkout, then advertises the eligible profiles in one signed channel update. The two profile identities are independent; an already-advertised version is never replaced, and retrying a version with a different digest is rejected. Backend versions are independent of frontend versions. The backend workflow assigns a stable patch number from its run number; reruns retain the same number. The separate frontend workflow uses its own run number.

The operator must explicitly provision the separate `codexia-stable-channel` branch, protect its write access, configure the protected environment secret `CODEXIA_CHANNEL_SIGNING_KEY` (Ed25519 private PEM), and enable `CODEXIA_STABLE_CHANNEL_ENABLED`. Bootstrap the empty signed channel through the manual maintenance workflow once. Publish backend changes through the normal main-push release workflow; refresh the signed channel every four hours or manually, and withdraw by exact digest. The publisher authenticates the channel and registry at the same parent commit, writes both in one child commit, and advances the branch with a non-force ref update. After a ref conflict, read and authenticate both files again from the new head before retrying. Channel validity is twelve hours; refresh failure makes clients refuse updates, not stop the installed API.

The host retrieves the raw signed document at the GitHub Contents endpoint `/repos/yohn-jp/codexia/contents/stable-channel.json?ref=codexia-stable-channel` using a host-only read credential. Its pinned public key and persistent checkpoint must be provisioned independently. The frontend advertises the actual built compatibility epoch and profile at `/desktop/update-identity.json` through the existing Access-protected static route with no-store. The host must check that endpoint, not a guessed local value. Older browser bundles are compatible only within the unchanged API epoch; introducing a breaking epoch requires an explicitly coordinated manual rollout.
