# Automatic product version releases

The product version is shared by the root, app, API, Core and Full profile package manifests. Individual module manifests and contract versions remain independent. The API reports its packaged manifest version; both backend identity and frontend identity derive the product version from the source manifest. The stable channel publishes the immutable backend digest from the exact certified main release source. Tag-triggered full application OCI releases remain a separate explicit operation.

## Release declarations

For a PR affecting backend runtime inputs, add one uniquely named file under `.release-intents/`, for example `.release-intents/search-ranking.json`:

```json
{
  "type": "feature",
  "summary": "Improve compatible search ranking"
}
```

The author/reviewer must classify semantic compatibility. CI enforces the release declaration, exact version transition and structural compatibility signals; passing CI is not a proof of semantic backward compatibility.

| Declaration | 0.x | 1.x and later |
| --- | --- | --- |
| patch — compatible fix | PATCH | PATCH |
| feature — compatible feature | PATCH | MINOR |
| breaking — incompatible behavior, storage or API | MINOR | MAJOR |

Changes under the PostgreSQL migration directory or changes to the API/persistence compatibility epochs require a breaking declaration, and epochs cannot decrease. Increment the appropriate compatibility epoch for incompatible protocol or persistent-format changes. Changes only to app UI, browser-only module code, documentation or tests do not create a backend release. A release PR must consume all outstanding declarations; the strongest declaration determines the new version. Existing pending declarations cannot be modified or deleted by a normal PR.

Do not manually change the product version in feature PRs. The `Verify Codexia` plan job validates the exact PR diff and main push transition. A release PR may only update the five product manifests to the planned version and remove the pending declarations; it must be based on current main.

## Automatic release workflow

After successful full main-push certification, `Prepare Codexia version release` checks that the certified source is still current, computes the next version, and creates or refreshes the reserved `automation/semver-release` PR. It uses a fast-forward-only branch update and never writes directly to main. Concurrent main changes are coalesced into the next release candidate; strict base checks reject stale candidates. A release commit consumes its declarations, so its own successful certification does not trigger another release. A manual dispatch on main may recover a missed run, subject to the same certification gate.

Compatible release PRs may be automatically merged by GitHub only after the required up-to-date PR checks pass. A breaking release PR is left for operator approval. The exact-main OCI publishing gate is unchanged; the host compatibility policy continues to reject schema/epoch/breaking upgrades. No workflow grants the VM permission to apply migrations automatically.

When automatic releases are enabled, backend main-push publication is deferred until the version release commit, avoiding separate builds/publications for each intermediate source merge. PR OCI validation is retained, and the actual version commit receives full main verification and Core/Full backend image tests before publication. UI-only changes continue to use the independent Worker release. Production UI deployment additionally requires the built API epoch to equal the operator-approved active API epoch (default 1); coordinate a breaking epoch change with the VM before advancing this value.

## Operator activation

- Complete the signed Stable Channel bootstrap and host rollout described in [update release](UPDATE-RELEASE.md) and [standalone updater](STANDALONE-UPDATER.md). Enable the channel before the first automatic version release.
- Reserve the branch `automation/semver-release` for the release bot. Configure a protected GitHub Environment `codexia-release-automation`, limited to main, with `CODEXIA_RELEASE_BOT_TOKEN`: a repository-scoped fine-grained user token with Contents and Pull requests write access. A distinct bot identity is recommended. The built-in GITHUB_TOKEN is not used for PR creation because its events do not reliably trigger normal CI. The token must not bypass main protection. If using auto-merge, also grant Administration read for the protection check.
- Set repository variable `CODEXIA_AUTO_RELEASE_ENABLED=true` to generate release PRs and defer intermediate backend publication. To enable unattended compatible releases, configure GitHub auto-merge and strict main required status checks (require branches to be up to date), including `certification` and `Build and test backend OCI image (core)` / `Build and test backend OCI image (full)`. Require ordinary review policies as appropriate; do not grant bypass to the bot. Then set `CODEXIA_AUTO_RELEASE_MERGE=true`. If strict protection cannot be verified, the release PR remains open. Without this variable, the bot prepares the PR but does not merge it.
- The production environment variable `CODEXIA_ACTIVE_API_EPOCH` is the operator's approved currently compatible API epoch. Advance it only as part of a coordinated breaking rollout; do not use it to bypass the VM compatibility policy.
- Run the version workflow manually on main for the initial pending release if needed. Check both exact-main OCI jobs and the signed channel entry for the release; check the actual host controller status separately.
