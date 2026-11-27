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
   [[ "$version" != dev && ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
   [[ -n "$client_id" && ! "$client_id" =~ ^Iv[0-9A-Za-z.]{4,62}$ ]]; then
  echo 'Invalid codexiactl release source, version, or GitHub App client ID.' >&2
  exit 1
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
