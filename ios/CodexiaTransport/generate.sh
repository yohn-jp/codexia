#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in ""|--check) ;; *) exit 2 ;; esac
package=$(cd "$(dirname "$0")" && pwd)
workspace=$(cd "$package/../.." && pwd)
contract="$workspace/packages/http-contract/openapi/codexia.openapi.yaml"
sources="$package/Sources/CodexiaAPI/Generated"
mkdir -p "$package/.build"
scratch=$(mktemp -d "$package/.build/codexia-generate.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT

(cd "$workspace" && pnpm --filter @codexia/http-contract generate:openapi)
python3 "$package/normalize-openapi.py" "$contract" "$scratch/openapi.yaml" "$scratch/expected"

generate() {
  mkdir "$1"
  swift run --package-path "$package" --force-resolved-versions --jobs 4 swift-openapi-generator generate \
    "$scratch/openapi.yaml" --config "$package/openapi-generator-config.yaml" --output-directory "$1"
  python3 "$package/check-operation-manifest.py" "$scratch/expected" \
    "$1/Types+Operations.swift" "$1/Client.swift"
}

generate "$scratch/source"
if [[ "${1:-}" == --check ]]; then
  generate "$scratch/repeat"
  diff -ru "$scratch/source" "$scratch/repeat"
fi

# Replace only the generator-owned directory after all requested checks pass.
if [[ -d "$sources" ]] && diff -qr "$sources" "$scratch/source" >/dev/null; then
  exit 0
fi
if [[ -d "$sources" ]]; then mv "$sources" "$scratch/previous"; fi
if ! mv "$scratch/source" "$sources"; then
  if [[ -d "$scratch/previous" ]]; then mv "$scratch/previous" "$sources"; fi
  exit 1
fi
