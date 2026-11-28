#!/usr/bin/env bash
# The caller holds the deployment lock and supplies the admitted digest and an empty private stage.
set -euo pipefail
umask 077
image=$1
target=$2
[[ "$image" =~ @sha256:[a-f0-9]{64}$ && -d "$target" && ! -L "$target" ]]

status=0
podman unshare bash -s -- "$image" "$target" <<'MOUNTED' || status=$?
set -euo pipefail
umask 077
export LC_ALL=C
image=$1
target=$2
# Only a mount capability error may select the original extraction method.
if ! mounted=$(podman image mount "$image" 2>&1); then
  case "$mounted" in
    *': operation not supported'|*': function not implemented') exit 77 ;;
    *) echo 'Cannot mount the admitted backup image' >&2; exit 1 ;;
  esac
fi
trap 'rc=$?; podman image unmount "$image" >/dev/null || rc=1; exit "$rc"' EXIT
# An absolute or intermediate symlink is interpreted in the host namespace.
# Validate each directory passed to tar. Archive links inside app verbatim.
[[ "$mounted" == /* && "$mounted" != / && -d "$mounted" &&
   "$(realpath -e -- "$mounted")" == "$mounted" &&
   -d "$mounted/app" && ! -L "$mounted/app" &&
   "$(realpath -e -- "$mounted/usr/local/bin")" == "$mounted/usr/local/bin" &&
   -f "$mounted/usr/local/bin/node" && ! -L "$mounted/usr/local/bin/node" ]]
tar -cf - -C "$mounted" app -C "$mounted/usr/local" bin/node |
  tar --no-same-owner --no-same-permissions -xf - -C "$target"
MOUNTED

case "$status" in
  0) echo mounted_tar ;;
  77)
    podman run --rm --pull=never --network=none --read-only --cap-drop=all --security-opt=no-new-privileges \
      --image-volume=ignore --entrypoint=tar "$image" -cf - -C / app -C /usr/local bin/node |
      tar --no-same-owner -xf - -C "$target"
    echo container_tar
    ;;
  *) exit "$status" ;;
esac
