#!/usr/bin/env bash
set -euo pipefail
# Run directly rather than interpolating a quoted shell program into a
# composite action. The only host directory is the two-file build context.
dagger query <<'GRAPHQL' | jq -e '.. | objects | select(has("stdout")) | .stdout | select(. == "PASS\n" or . == "PASS")'
query {
  host {
    directory(path: ".") {
      dockerBuild(dockerfile: ".github/docker/strictdoc-ci.Dockerfile") {
        withExec(args: ["sh", "-ec", "test \"$(id -u)\" -ne 0; test \"$(/opt/strictdoc/bin/strictdoc --version)\" = 0.32.1; test \"$(node --version)\" = v24.22.3; test -d /ms-playwright; echo PASS"]) {
          stdout
        }
      }
    }
  }
}
GRAPHQL
