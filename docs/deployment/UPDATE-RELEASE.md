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
