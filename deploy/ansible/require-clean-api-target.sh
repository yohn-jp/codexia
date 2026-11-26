#!/usr/bin/env bash
# The caller holds the deployment host lock for this check and the guarded operation.
set -Eeuo pipefail
state_dir="$HOME/.local/state/codexia-deploy"
unit_dir="$HOME/.config/containers/systemd"
for marker in "$unit_dir/codexia-api.container" "$unit_dir/default.target.wants/codexia-api.service" \
              "$state_dir"/{deploy-transaction.json,deployed-release.json}{,.tmp} \
              "$state_dir"/{rollback-api.container,rollback-release.json,backup-transaction}; do
  if [[ -e "$marker" || -L "$marker" ]]; then
    echo "Initial setup requires a clean API target; installation state exists at $marker" >&2
    exit 1
  fi
done
if podman container exists codexia-api; then
  echo 'Initial setup requires a clean API target; the API container already exists' >&2
  exit 1
elif [[ $? != 1 ]]; then
  echo 'Could not verify that the API container is absent' >&2
  exit 1
fi
status=0
unit_state=$(systemctl --user show --property=LoadState,ActiveState codexia-api.service) || status=$?
if [[ "$status" != 0 && "$status" != 4 ]] ||
   ! grep -Fxq 'LoadState=not-found' <<< "$unit_state" ||
   ! grep -Fxq 'ActiveState=inactive' <<< "$unit_state"; then
  echo 'Initial setup requires a reachable user manager with no API service' >&2
  exit 1
fi
