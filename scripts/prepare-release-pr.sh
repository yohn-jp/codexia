#!/usr/bin/env bash
set -euo pipefail
: "${GH_TOKEN:?Release bot credential required}"
: "${RELEASE_VERSION:?Planned version required}"
: "${RELEASE_KIND:?Planned intent required}"
: "${RELEASE_SOURCE:?Verified source required}"
[[ "$GITHUB_REPOSITORY" == yohn-jp/codexia && "$GITHUB_REF" == refs/heads/main ]]
[[ "$RELEASE_SOURCE" =~ ^[a-f0-9]{40}$ && "$RELEASE_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ "$RELEASE_KIND" =~ ^(patch|feature|breaking)$ ]]
[[ "$(git rev-parse HEAD)" == "$RELEASE_SOURCE" ]]

branch=automation/semver-release
ref="refs/heads/$branch"
title="chore(release): v$RELEASE_VERSION"
actor="$(gh api user --jq .login)"
[[ -n "$actor" ]]
gh auth setup-git
current_main() { git ls-remote --exit-code origin refs/heads/main | cut -f1; }
if [[ "$(current_main)" != "$RELEASE_SOURCE" ]]; then
  echo "Main advanced; refuse to open a stale release."
  exit 0
fi
prs="$(gh pr list --repo "$GITHUB_REPOSITORY" --base main --head "$branch" --state open --json number,author,title,headRefOid,autoMergeRequest)"
count="$(jq 'length' <<< "$prs")"
[[ "$count" == 0 || "$count" == 1 ]]
number=
old="$(git ls-remote origin "$ref" | cut -f1)"
if [[ "$count" == 1 ]]; then
  number="$(jq -r '.[0].number' <<< "$prs")"
  [[ "$(jq -r '.[0].author.login' <<< "$prs")" == "$actor" ]]
  [[ "$(jq -r '.[0].title' <<< "$prs")" == chore\(release\):\ v* ]]
  [[ "$(jq -r '.[0].headRefOid' <<< "$prs")" == "$old" ]]
  # An earlier compatible candidate must not stay armed after a breaking intent arrives.
  if [[ "$(jq -r '.[0].autoMergeRequest != null' <<< "$prs")" == true ]]; then
    gh pr merge "$number" --repo "$GITHUB_REPOSITORY" --disable-auto
  fi
fi

git config user.name "$actor"
git config user.email "$actor@users.noreply.github.com"
git add -- package.json app/package.json packages/api/package.json profiles/core/package.json profiles/full/package.json .release-intents
tree="$(git write-tree)"
parents=(-p "$RELEASE_SOURCE")
if [[ -n "$old" ]]; then
  [[ "$old" =~ ^[a-f0-9]{40}$ ]]
  git fetch --no-tags origin "$ref"
  [[ "$(git rev-parse FETCH_HEAD)" == "$old" ]]
  # The reserved branch may contain only previous bot-generated release heads.
  [[ "$(git show -s --format=%s "$old")" == chore\(release\):\ v* ]]
  if [[ "$(git rev-parse "$old^{tree}")" == "$tree" && "$(git rev-parse "$old^1")" == "$RELEASE_SOURCE" ]]; then
    commit="$old"
  elif ! git merge-base --is-ancestor "$old" "$RELEASE_SOURCE"; then
    parents+=(-p "$old")
  fi
fi
if [[ -z "${commit:-}" ]]; then
  commit="$(git commit-tree "$tree" "${parents[@]}" -m "$title")"
fi
# Never force-push. The previous reserved head is an ancestor of the new head.
git push origin "$commit:$ref"
if [[ "$(current_main)" != "$RELEASE_SOURCE" ]]; then
  echo "Main advanced; strict base checks prevent stale release merges."
  exit 0
fi
body="$(printf 'Automated version-only release of verified main %s.\n\nIntent: %s\nVersion: %s\n\nConsumes pending release declarations and updates product manifests. Normal CI and exact-source publication gates still apply. Breaking releases require operator approval.\n' "$RELEASE_SOURCE" "$RELEASE_KIND" "$RELEASE_VERSION")"
if [[ -z "$number" ]]; then
  gh pr create --repo "$GITHUB_REPOSITORY" --base main --head "$branch" --title "$title" --body "$body"
  number="$(gh pr list --repo "$GITHUB_REPOSITORY" --base main --head "$branch" --state open --json number --jq 'if length == 1 then .[0].number else error("Ambiguous release PR") end')"
else
  gh api --method PATCH "repos/$GITHUB_REPOSITORY/pulls/$number" -f title="$title" -f body="$body" --silent
fi
