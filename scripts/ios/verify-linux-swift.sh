#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s):$(uname -m)" == Linux:x86_64 ]]
toolchain=scripts/ios/swift-linux-toolchain.json
version=$(jq -er .version "$toolchain")
url=$(jq -er .url "$toolchain")
sha256=$(jq -er .sha256 "$toolchain")
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/codexia-swift.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT

curl --fail --location --silent --show-error --retry 2 --connect-timeout 10 --max-time 480 \
  "$url" --output "$work/swift.tar.gz"
printf '%s  %s\n' "$sha256" "$work/swift.tar.gz" | sha256sum --check --strict
tar -xzf "$work/swift.tar.gz" -C "$work" --strip-components=1
rm "$work/swift.tar.gz"
export PATH="$work/usr/bin:$PATH"
swift_version=$(swift --version)
printf '%s\n' "$swift_version"
grep -Fxq "Swift version $version (swift-$version-RELEASE)" <<< "$swift_version"
grep -Fxq 'Target: x86_64-unknown-linux-gnu' <<< "$swift_version"

bash scripts/shared/python-env.sh create python3 "$work/yaml" PyYAML==6.0.3
PATH="$work/yaml/bin:$PATH" ios/CodexiaTransport/generate.sh --check
swift test --package-path ios/CodexiaTransport --force-resolved-versions --jobs 4
swift build --package-path ios/CodexiaEditor --force-resolved-versions --jobs 4
swift test --package-path ios/CodexiaEditor --force-resolved-versions --jobs 4
git diff --exit-code HEAD -- ios/CodexiaTransport/Package.resolved ios/CodexiaEditor/Package.resolved ios/CodexiaTransport/Sources/CodexiaAPI
