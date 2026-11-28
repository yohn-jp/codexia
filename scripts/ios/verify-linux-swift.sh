#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s):$(uname -m)" == Linux:x86_64 ]]
toolchain=scripts/ios/swift-linux-toolchain.json
version=$(jq -er .version "$toolchain")
url=$(jq -er .url "$toolchain")
sha256=$(jq -er .sha256 "$toolchain")
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/codexia-swift.XXXXXXXX")
trap 'wait; rm -rf -- "$work"' EXIT

# The Python generator environment and Swift archive are independent.
bash scripts/shared/python-env.sh create python3 "$work/yaml" PyYAML==6.0.3 &
yaml_pid=$!

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

# Editor's locked dependency graph can resolve before generated API sources exist.
# Keep each package's build plan, checkouts, and test binary in its own .build.
swift package --package-path ios/CodexiaEditor --force-resolved-versions resolve &
editor_resolve_pid=$!
wait "$yaml_pid"
PATH="$work/yaml/bin:$PATH" ios/CodexiaTransport/generate.sh --check
swift test --package-path ios/CodexiaTransport --force-resolved-versions --jobs 4
wait "$editor_resolve_pid"
# The Editor test target builds the package's sole library product.
swift test --package-path ios/CodexiaEditor --force-resolved-versions --jobs 4
git diff --exit-code HEAD -- ios/CodexiaTransport/Package.resolved ios/CodexiaEditor/Package.resolved
