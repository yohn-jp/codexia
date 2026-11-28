#!/usr/bin/env bash
set -euo pipefail

module=cmd/codexiactl
export GOTOOLCHAIN=local GOWORK=off GOFLAGS=
expected_go="go$(awk '$1 == "go" { print $2 }' "$module/go.mod")"
if [[ "$(go env GOVERSION)" != "$expected_go" ]]; then
  printf 'codexiactl requires %s.\n' "$expected_go" >&2
  exit 1
fi

source_sha=$(git rev-parse HEAD)
version=${CODEXIACTL_BUILD_VERSION:-dev}
client_id=${CODEXIACTL_BUILD_APP_CLIENT_ID:-}
if [[ ! "$source_sha" =~ ^[a-f0-9]{40}$ || "$source_sha" != "${CODEXIACTL_BUILD_SOURCE:-$source_sha}" ]] ||
   [[ "$version" != dev && ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo 'Invalid codexiactl release source or version.' >&2
  exit 1
fi
if [[ -n "$client_id" && ! "$client_id" =~ ^Iv[0-9A-Za-z.]{10,62}$ ]]; then
  echo 'CODEXIACTL_GITHUB_APP_CLIENT_ID has an invalid GitHub App Client ID format.' >&2
  exit 1
fi
if [[ "$version" != dev && -z "$client_id" ]]; then
  echo 'Set the official App public Client ID in the publisher repository variable CODEXIACTL_GITHUB_APP_CLIENT_ID before releasing CodexiaCTL.' >&2
  exit 1
fi
if [[ "$version" != dev ]]; then
  if ! official_client_id=$(gh api --hostname github.com apps/codexiactl \
      --jq 'select(.slug == "codexiactl" and .owner.login == "yohn-jp") | .client_id') ||
      [[ -z "$official_client_id" ]]; then
    echo 'Could not verify the public CodexiaCTL GitHub App at https://api.github.com/apps/codexiactl. Check App visibility and GitHub API access before retrying.' >&2
    exit 1
  fi
  if [[ "$client_id" != "$official_client_id" ]]; then
    echo 'CODEXIACTL_GITHUB_APP_CLIENT_ID does not match the official CodexiaCTL GitHub App owned by yohn-jp.' >&2
    exit 1
  fi
fi

scratch_dir=$(mktemp -d)
trap 'rm -rf -- "$scratch_dir"' EXIT
tool_pin=$(jq -er '.golangciLint | [.version, .sha256] | @tsv' "$module/quality-toolchain.json")
IFS=$'\t' read -r lint_version lint_digest <<< "$tool_pin"
if [[ ! "$lint_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$lint_digest" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'Invalid golangci-lint release pin.' >&2
  exit 1
fi
started=$SECONDS
archive_name="golangci-lint-$lint_version-linux-amd64"
archive="$scratch_dir/$archive_name.tar.gz"
curl --silent --show-error --fail --location --retry 3 --max-time 120 --proto '=https' --proto-redir '=https' \
  --output "$archive" "https://github.com/golangci/golangci-lint/releases/download/v$lint_version/$archive_name.tar.gz"
printf '%s  %s\n' "$lint_digest" "$archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$scratch_dir" "$archive_name/golangci-lint"
lint="$scratch_dir/$archive_name/golangci-lint"
"$lint" version
printf 'Go analyzer setup: %ss\n' "$((SECONDS - started))"

started=$SECONDS
go -C "$module" mod tidy -diff
go -C "$module" mod verify
go -C "$module" list -mod=readonly -m all
printf 'Go dependency verification: %ss\n' "$((SECONDS - started))"

started=$SECONDS
(
  cd "$module"
  "$lint" config verify --config .golangci.yml
  "$lint" fmt --config .golangci.yml --diff
  CGO_ENABLED=1 "$lint" run --config .golangci.yml ./...
)
printf 'Go format and lint: %ss\n' "$((SECONDS - started))"

started=$SECONDS
CGO_ENABLED=1 go -C "$module" vet -mod=readonly ./...
CGO_ENABLED=1 go -C "$module" test -mod=readonly -race -count=1 ./...
printf 'Go vet and race tests: %ss\n' "$((SECONDS - started))"

started=$SECONDS
if [[ $# -eq 1 ]]; then
  mkdir -p -- "$1"
  stage_dir=$(realpath -- "$1")
else
  stage_dir="$scratch_dir"
fi
asset=codexiactl-linux-amd64
export CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1
package_modules=$(go -C "$module" list -mod=readonly -deps -f '{{with .Module}}{{.Path}}{{end}}' .)
if grep -Ex 'github\.com/stretchr/testify|github\.com/google/go-cmp|github\.com/golangci/golangci-lint(/v[0-9]+)?|golang\.org/x/(tools|vuln)|mvdan\.cc/gofumpt' <<< "$package_modules"; then
  echo 'A Go test or analysis module entered the CLI release package closure.' >&2
  exit 1
fi
go -C "$module" build \
  -mod=readonly -trimpath -buildvcs=true \
  -ldflags "-X main.version=$version -X main.source=$source_sha -X main.githubAppClientID=$client_id" \
  -o "$stage_dir/$asset" .

program_headers=$(readelf -lW "$stage_dir/$asset")
build_info=$(go version -m "$stage_dir/$asset")
if [[ "$program_headers" == *INTERP* || "$build_info" != *'CGO_ENABLED=0'* ||
      "$build_info" != *'GOOS=linux'* || "$build_info" != *'GOARCH=amd64'* ]]; then
  echo 'Expected a self-contained Linux amd64 binary.' >&2
  exit 1
fi
if [[ "$build_info" != *"vcs.revision=$source_sha"* ||
      ( "$version" != dev && "$build_info" != *'vcs.modified=false'* ) ]]; then
  echo 'Build metadata does not identify the exact checked-out release source.' >&2
  exit 1
fi
help_text=$("$stage_dir/$asset" help)
version_text=$("$stage_dir/$asset" version)
if [[ "$help_text" != *'init'* || "$help_text" != *'doctor'* ||
      "$version_text" != *"$version"* || "$version_text" != *"$source_sha"* ]]; then
  echo 'codexiactl help or version does not identify the verified build.' >&2
  exit 1
fi
cd "$stage_dir"
sha256sum "$asset" > "$asset.sha256"
sha256sum --check --strict "$asset.sha256"
printf 'Go release build and smoke: %ss\n' "$((SECONDS - started))"
