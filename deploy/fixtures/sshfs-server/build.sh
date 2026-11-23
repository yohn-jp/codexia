#!/usr/bin/env bash
# Produce a same-run immutable OCI artifact before disposable lifecycle jobs start.
set -Eeuo pipefail
: "${CODEXIA_LIFECYCLE_SOURCE_SHA:?}"
[[ "$CODEXIA_LIFECYCLE_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]
: "${RUNNER_TEMP:?}"
: "${GITHUB_WORKSPACE:?}"
cd "$GITHUB_WORKSPACE"
work="$RUNNER_TEMP/lifecycle-sshfs"
mkdir -p "$work"
base='docker.io/library/debian:bookworm-slim'
docker pull "$base"
pinned_base="$(docker image inspect "$base" --format '{{json .RepoDigests}}' | node -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{
  const refs=JSON.parse(raw);
  const normalized=refs.map(x=>x.startsWith("debian@")?"docker.io/library/"+x:x);
  const hit=normalized.find(x=>x.startsWith("docker.io/library/debian@sha256:")&&
    /^[a-f0-9]{64}$/.test(x.split("@sha256:")[1]||""));
  if(!hit)process.exit(1);
  console.log(hit.startsWith("docker.io/")?hit:"docker.io/library/"+hit);
})')"
[[ "$pinned_base" =~ ^docker.io/library/debian@sha256:[0-9a-f]{64}$ ]]
image="codexia-sshfs-fixture:ci-$CODEXIA_LIFECYCLE_SOURCE_SHA"
context=deploy/fixtures/sshfs-server
docker build --platform linux/amd64 --build-arg "BASE_IMAGE=$pinned_base" \
  -t "$image" -f "$context/Dockerfile" "$context"
test "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
ssh-keygen -q -t ed25519 -N '' -f "$work/key"
cp "$work/key.pub" "$work/authorized_keys"
chmod 0600 "$work/authorized_keys" "$work/key"
# Rootful Docker bind mounts preserve host ownership; sshd StrictModes requires
# authorized_keys to be owned by the fixture user or root, not the runner UID.
backup_uid="$(docker run --rm --entrypoint id "$image" -u codexia-backup)"
sudo chown "$backup_uid:$backup_uid" "$work/authorized_keys"
cleanup() {
  if [[ ${SSHFS_SMOKE_PASSED:-false} != true ]]; then docker logs --tail 80 codexia-sshfs-smoke >&2 || true; fi
  docker rm -f codexia-sshfs-smoke >/dev/null 2>&1 || true
  rm -f "$work/key" "$work/key.pub" "$work/authorized_keys" "$work/known_hosts"
}
trap cleanup EXIT
docker run -d --name codexia-sshfs-smoke \
  --mount "type=bind,source=$work/authorized_keys,target=/home/codexia-backup/.ssh/authorized_keys,readonly" \
  -p 127.0.0.1:2223:22 "$image"
for attempt in $(seq 1 30); do
  if docker exec codexia-sshfs-smoke test -s /etc/ssh/ssh_host_ed25519_key.pub; then break; fi
  sleep 1
done
server_key="$(docker exec codexia-sshfs-smoke cat /etc/ssh/ssh_host_ed25519_key.pub)"
printf '[127.0.0.1]:2223 %s\n' "$server_key" >"$work/known_hosts"
ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$work/known_hosts" -o ConnectTimeout=10 \
  -i "$work/key" -p 2223 codexia-backup@127.0.0.1 true
SSHFS_SMOKE_PASSED=true
docker save -o "$work/sshfs-fixture.tar" "$image"
PINNED_BASE="$pinned_base" IMAGE="$image" python3 - <<'PY'
import hashlib, json, os, pathlib, subprocess
root = pathlib.Path(os.environ['GITHUB_WORKSPACE'])
folder = pathlib.Path(os.environ['RUNNER_TEMP']) / 'lifecycle-sshfs'
def sha(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()
archive = folder / 'sshfs-fixture.tar'
value = {
    'schemaVersion': 1,
    'sourceSha': os.environ['CODEXIA_LIFECYCLE_SOURCE_SHA'],
    'runId': int(os.environ['GITHUB_RUN_ID']),
    'runAttempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
    'platform': 'linux/amd64',
    'image': os.environ['IMAGE'],
    'imageId': subprocess.check_output(['docker', 'image', 'inspect', os.environ['IMAGE'], '--format', '{{.Id}}'], text=True).strip(),
    'baseImage': os.environ['PINNED_BASE'],
    'dockerfileSha256': sha(root / 'deploy/fixtures/sshfs-server/Dockerfile'),
    'entrypointSha256': sha(root / 'deploy/fixtures/sshfs-server/entrypoint.sh'),
    'archiveSha256': sha(archive),
    'archiveBytes': archive.stat().st_size
}
(folder / 'manifest.json').write_text(json.dumps(value, indent=2) + '\n')
PY
node scripts/verify-sshfs-fixture-artifact.mjs "$work"
echo "Prebuilt SSHFS fixture validated: $image"
