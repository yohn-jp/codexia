#!/usr/bin/env bash
set -euo pipefail

package=$(cd "$(dirname "$0")" && pwd)
workspace=$(cd "$package/../.." && pwd)
contract="$workspace/packages/http-contract/openapi/codexia.openapi.yaml"
sources="$package/Sources/CodexiaAPI"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/source"

python3 "$package/normalize-openapi.py" "$contract" "$scratch/openapi.yaml" "$scratch/expected"
swift run --package-path "$package" --force-resolved-versions --jobs 4 swift-openapi-generator generate \
  "$scratch/openapi.yaml" --config "$package/openapi-generator-config.yaml" \
  --output-directory "$scratch/source"

# Compare every generated operation's ID, method and path against OpenAPI.
python3 "$package/check-operation-manifest.py" "$scratch/expected" \
  "$scratch/source/Types+Operations.swift" "$scratch/source/Client.swift"

case "${1:-}" in
  --check) diff -ru "$sources" "$scratch/source" ;;
  "")
    mkdir -p "$sources"
    rm -f "$sources"/*.swift
    cp "$scratch/source"/*.swift "$sources/"
    ;;
  *) exit 2 ;;
esac
