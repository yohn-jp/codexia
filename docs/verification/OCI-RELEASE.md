## OCI releases

A repository-local GitHub Actions workflow publishes two independently verified `linux/amd64` images to GHCR when a semantic version tag such as `v0.1.0` is pushed:

- `ghcr.io/yohn-jp/codexia/core:v0.1.0`
- `ghcr.io/yohn-jp/codexia/full:v0.1.0`

The workflow builds each profile from the tagged source, starts the resulting image, checks HTTP/assets/profile, non-root execution, writable data and graceful shutdown, then publishes that same tested image. A failed check prevents that profile from being published. The two profile jobs are independent: a partial release is possible if one fails, and must be treated as incomplete by operators. Do not repoint a published version tag; use a new version for corrections. No `latest` or mutable stable alias is published. Deployment should pin the registry manifest digest resolved from the release tag.

This workflow is intentionally local to Codexia and does not use organization shared release workflows. The GitHub Actions job requires repository Actions permission and GHCR package write access via `GITHUB_TOKEN`. Package visibility is configured separately in GitHub Packages; a public repository does not automatically make new GHCR packages public. Publication requires a release tag to trigger the workflow.

## Exact-source verification and immutable publication

The shared exact-main verification and release authority is [CI/CD architecture](CI-CD.md). The tag-triggered publisher additionally verifies the tag-to-commit binding immediately before pushing. A tag or PR check alone is insufficient.

`verify-unpublished-image.mjs` checks GHCR immediately before each image push. An existing version tag is refused; only a registry 404 with `MANIFEST_UNKNOWN` or `NAME_UNKNOWN` confirms absence. Authorization, service, malformed-response and network failures stop publication. The workflow serializes events for the same Git ref. A partial publication must use a new version; rerunning it must not replace the profile already published.

The workflow's `Publish verified Release` job runs only after both image jobs succeed and rechecks exact-source verification. It retains an existing GitHub Release unchanged. This tag-triggered workflow is the verified publishing entrypoint; do not manually create an unverified Release. These repository checks cannot prevent an administrator from manually moving Git/registry tags, publishing a Release, or changing the workflow. No account-level protection is claimed.
