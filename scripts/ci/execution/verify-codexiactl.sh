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
cloudflare_client_id=${CODEXIACTL_BUILD_CLOUDFLARE_CLIENT_ID:-}
if [[ -n "$cloudflare_client_id" && ! "$cloudflare_client_id" =~ ^[A-Za-z0-9_-]{16,128}$ ]]; then
  echo 'Invalid official Cloudflare OAuth client ID.' >&2
  exit 1
fi
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

unformatted=$(gofmt -l "$module")
if [[ -n "$unformatted" ]]; then
  printf 'Go files that need gofmt:\n%s\n' "$unformatted" >&2
  exit 1
fi
go -C "$module" mod tidy -diff
go -C "$module" mod verify
CGO_ENABLED=1 go -C "$module" vet -mod=readonly ./...
CGO_ENABLED=1 go -C "$module" test -mod=readonly -race -count=1 ./...

if [[ $# -eq 1 ]]; then
  mkdir -p -- "$1"
  stage_dir=$(realpath -- "$1")
else
  stage_dir=$(mktemp -d)
  trap 'rm -rf -- "$stage_dir"' EXIT
fi
asset=codexiactl-linux-amd64
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 go -C "$module" build \
  -mod=readonly -trimpath -buildvcs=true \
  -ldflags "-X main.version=$version -X main.source=$source_sha -X main.githubAppClientID=$client_id -X main.cloudflareOAuthClientID=$cloudflare_client_id" \
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
