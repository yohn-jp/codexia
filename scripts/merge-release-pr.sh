#!/usr/bin/env bash
set -euo pipefail
: "${GH_TOKEN:?Release bot credential required}"
: "${CHECKS_TOKEN:?Read-only workflow credential required}"
[[ "$GITHUB_REPOSITORY" == yohn-jp/codexia && "$GITHUB_REF" == refs/heads/main ]]
branch=automation/semver-release
ref="refs/heads/$branch"
source="$(git rev-parse HEAD)"
actor="$(gh api user --jq .login)"
[[ -n "$actor" ]]
gh auth setup-git
current_main() { git ls-remote --exit-code origin refs/heads/main | cut -f1; }
if [[ "$(current_main)" != "$source" ]]; then echo 'Main advanced; wait for refreshed release.'; exit 0; fi
prs="$(gh pr list --repo "$GITHUB_REPOSITORY" --base main --head "$branch" --state open --json number,author,title,headRefOid,isDraft,headRepositoryOwner)"
count="$(jq 'length' <<< "$prs")"
if [[ "$count" == 0 ]]; then echo 'No pending release PR.'; exit 0; fi
[[ "$count" == 1 ]]
[[ "$(jq -r '.[0].author.login' <<< "$prs")" == "$actor" ]]
[[ "$(jq -r '.[0].headRepositoryOwner.login' <<< "$prs")" == yohn-jp ]]
[[ "$(jq -r '.[0].isDraft' <<< "$prs")" == false ]]
[[ "$(jq -r '.[0].title' <<< "$prs")" == chore\(release\):\ v* ]]
number="$(jq -r '.[0].number' <<< "$prs")"
head="$(jq -r '.[0].headRefOid' <<< "$prs")"
[[ "$head" =~ ^[a-f0-9]{40}$ ]]
git fetch --no-tags origin "$ref"
if [[ "$(git rev-parse FETCH_HEAD)" != "$head" ]]; then echo 'Release head changed.'; exit 0; fi
if ! git merge-base --is-ancestor "$source" "$head"; then echo 'Release candidate is stale.'; exit 0; fi
candidate="$(node scripts/release-version.mjs candidate "$source" "$head")"
kind="$(jq -r .kind <<< "$candidate")"
if [[ "$kind" == breaking ]]; then echo 'Breaking release requires operator approval.'; exit 0; fi
if [[ "$(GH_TOKEN="$CHECKS_TOKEN" node scripts/release-pr-checks.mjs "$head" "$number")" != ready ]]; then
  echo 'Exact release PR workflow set has not succeeded yet.'
  exit 0
fi
# Only the always-run certification check must be globally required.
# Path-filtered OCI/UI/config checks were verified above for this release PR.
protection="$(gh api "repos/$GITHUB_REPOSITORY/branches/main/protection/required_status_checks")"
jq -e '.strict == true and (([.contexts[]?, .checks[]?.context] | unique) | index("certification")) != null' <<< "$protection" >/dev/null
if [[ "$(current_main)" != "$source" ]]; then echo 'Main advanced after verification.'; exit 0; fi
gh pr merge "$number" --repo "$GITHUB_REPOSITORY" --merge --match-head-commit "$head"
