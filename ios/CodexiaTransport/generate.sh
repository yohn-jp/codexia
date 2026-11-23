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

# Compare every operation ID emitted by the TypeSpec contract, including HEAD.
sed -n 's/^ *public static let id: Swift.String = "\([a-z0-9_][a-z0-9_]*\)"$/\1/p' \
  "$scratch/source/Types+Operations.swift" | LC_ALL=C sort > "$scratch/actual"
test -s "$scratch/expected"
diff -u "$scratch/expected" "$scratch/actual"

case "${1:-}" in
  --check) diff -ru "$sources" "$scratch/source" ;;
  "")
    mkdir -p "$sources"
    rm -f "$sources"/*.swift
    cp "$scratch/source"/*.swift "$sources/"
    ;;
  *) exit 2 ;;
esac
