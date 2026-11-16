#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die() { printf 'runtime-contract integration: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing prerequisite: $1"; }
normalize_image_id() {
  local value="${1:-}"
  if [[ "$value" =~ ^[a-f0-9]{64}$ ]]; then value="sha256:$value"; fi
  printf '%s' "$value"
}
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly UID_VALUE="$(id -u)"
readonly CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
readonly RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$UID_VALUE}"
readonly QUADLET_DIR="$CONFIG_HOME/containers/systemd"
readonly USER_UNIT_DIR="$CONFIG_HOME/systemd/user"
readonly MARKER=/etc/codexia-iac-disposable-vm
readonly LOCK="$RUNTIME_DIR/codexia-runtime-contract-acceptance.lock"
readonly MODEL_CACHE_ROOT=/var/cache/codexia/models
readonly PROXY_FIXTURE_CONTAINER=codexia-runtime-contract-proxy-fixture
readonly PROXY_FIXTURE_UNIT=codexia-runtime-contract-proxy-fixture.service
WORK_DIR=
NONCE=
IMAGE_TAG=
IMAGE_ID=
MODEL_DIR=
MODEL_ALIAS=
MODEL_DIR_CREATED=0
MODEL_ALIAS_CREATED=0
CLEANUP_ARMED=0
LOCK_ACQUIRED=0
CREATED_QUADLET_DIR=0
CREATED_USER_UNIT_DIR=0
CREATED_CONTAINERS_DIR=0
CREATED_SYSTEMD_CONFIG_DIR=0
declare -a OWNED_FILES=()
declare -a OWNED_SECRETS=()
declare -a OWNED_UNITS=()

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if (( CLEANUP_ARMED )); then
    systemctl --user disable --now codexia-updater.timer >/dev/null 2>&1 || true
    systemctl --user reset-failed codexia-updater.service >/dev/null 2>&1 || true
    systemctl --user revert --runtime codexia-slot-blue.service codexia-slot-green.service >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    for unit in "${OWNED_UNITS[@]}"; do systemctl --user stop "$unit" >/dev/null 2>&1 || true; done
    for container in codexia-slot-blue codexia-slot-green codexia-api-proxy "$PROXY_FIXTURE_CONTAINER"; do
      if podman container exists "$container" >/dev/null 2>&1; then
        actual="$(normalize_image_id "$(podman inspect --type container --format '{{.Image}}' "$container" 2>/dev/null || true)")"
        [[ -n "$IMAGE_ID" && "$actual" == "$IMAGE_ID" ]] && podman rm --force "$container" >/dev/null 2>&1 || true
      fi
    done
    for volume in codexia-data codexia-history; do
      if podman volume exists "$volume" >/dev/null 2>&1; then
        label="$(podman volume inspect --format '{{ index .Labels "codexia-runtime-contract-test" }}' "$volume" 2>/dev/null || true)"
        [[ -n "$NONCE" && "$label" == "$NONCE" ]] && podman volume rm "$volume" >/dev/null 2>&1 || true
      fi
    done
    for network in codexia codexia-data; do
      if podman network exists "$network" >/dev/null 2>&1; then
        label="$(podman network inspect --format '{{ index .Labels "codexia-runtime-contract-test" }}' "$network" 2>/dev/null || true)"
        [[ -n "$NONCE" && "$label" == "$NONCE" ]] && podman network rm "$network" >/dev/null 2>&1 || true
      fi
    done
    for secret in "${OWNED_SECRETS[@]}"; do podman secret rm "$secret" >/dev/null 2>&1 || true; done
    [[ -z "$IMAGE_TAG" ]] || podman image rm "$IMAGE_TAG" >/dev/null 2>&1 || true
    for file in "${OWNED_FILES[@]}"; do
      [[ -f "$file" && ! -L "$file" ]] || continue
      case "$(basename -- "$file")" in
        codexia-slot-blue.container) grep -Fq "Image=$IMAGE_ID" "$file" && grep -Fq 'ContainerName=codexia-slot-blue' "$file" && rm -f -- "$file" || true ;;
        codexia-slot-green.container) grep -Fq "Image=$IMAGE_ID" "$file" && grep -Fq 'ContainerName=codexia-slot-green' "$file" && rm -f -- "$file" || true ;;
        codexia.network|codexia-data.network|codexia-data.volume|codexia-history.volume) grep -Fq "Label=codexia-runtime-contract-test=$NONCE" "$file" && rm -f -- "$file" || true ;;
        codexia-db.service) grep -Fq "Description=Codexia runtime acceptance dependency $NONCE" "$file" && rm -f -- "$file" || true ;;
        codexia-runtime-contract-proxy-fixture.container) grep -Fq "ContainerName=$PROXY_FIXTURE_CONTAINER" "$file" && grep -Fq "Label=codexia-runtime-contract-test=$NONCE" "$file" && rm -f -- "$file" || true ;;
        codexia-api-proxy.container) grep -Fq 'ContainerName=codexia-api-proxy' "$file" && grep -Eq '^Image=ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}$' "$file" && grep -Fq "Label=codexia-runtime-contract-test=$NONCE" "$file" && rm -f -- "$file" || true ;;
      esac
    done
    for unit in codexia-updater-boot.service codexia-updater.service codexia-updater.timer; do
      file="$USER_UNIT_DIR/$unit"
      [[ -f "$file" && ! -L "$file" && "$(stat -c '%u' "$file" 2>/dev/null)" == "$UID_VALUE" ]] || continue
      case "$unit" in
        codexia-updater-boot.service) grep -Fq 'ExecStart=/bin/sh /opt/codexia-updater/deploy/updater/codexia-updater boot ' "$file" && rm -f -- "$file" || true ;;
        codexia-updater.service) grep -Fq 'ExecStart=/bin/sh /opt/codexia-updater/deploy/updater/codexia-updater tick ' "$file" && rm -f -- "$file" || true ;;
        codexia-updater.timer) grep -Fq 'Unit=codexia-updater.service' "$file" && grep -Eq '^OnBootSec=(5min|24h)$' "$file" && rm -f -- "$file" || true ;;
      esac
    done
    if (( MODEL_ALIAS_CREATED )) && [[ "$MODEL_ALIAS" == "$MODEL_CACHE_ROOT/.runtime-contract-test.$UID_VALUE.$NONCE.alias" && -L "$MODEL_ALIAS" && "$(readlink -- "$MODEL_ALIAS")" == "$MODEL_DIR" ]]; then rm -f -- "$MODEL_ALIAS"; fi
    if (( MODEL_DIR_CREATED )) && [[ "$MODEL_DIR" == "$MODEL_CACHE_ROOT/.runtime-contract-test.$UID_VALUE.$NONCE" && -d "$MODEL_DIR" && ! -L "$MODEL_DIR" && "$(stat -c '%u' "$MODEL_DIR" 2>/dev/null)" == "$UID_VALUE" ]]; then
      if [[ -f "$MODEL_DIR/model.txt" && ! -L "$MODEL_DIR/model.txt" && "$(stat -c '%u' "$MODEL_DIR/model.txt" 2>/dev/null)" == "$UID_VALUE" ]]; then rm -f -- "$MODEL_DIR/model.txt"; fi
      rmdir -- "$MODEL_DIR" >/dev/null 2>&1 || true
    fi
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    (( CREATED_USER_UNIT_DIR == 0 )) || rmdir -- "$USER_UNIT_DIR" 2>/dev/null || true
    (( CREATED_QUADLET_DIR == 0 )) || rmdir -- "$QUADLET_DIR" 2>/dev/null || true
    (( CREATED_SYSTEMD_CONFIG_DIR == 0 )) || rmdir -- "$CONFIG_HOME/systemd" 2>/dev/null || true
    (( CREATED_CONTAINERS_DIR == 0 )) || rmdir -- "$CONFIG_HOME/containers" 2>/dev/null || true
  fi
  if [[ -n "$WORK_DIR" && "$WORK_DIR" == /var/tmp/codexia-runtime-contract-acceptance."$UID_VALUE".* && -d "$WORK_DIR" && ! -L "$WORK_DIR" ]]; then rm -rf -- "$WORK_DIR"; fi
  # Remove the runtime lock only after all shared Codexia resources are gone; a new run may then safely acquire a new inode.
  if (( LOCK_ACQUIRED )) && [[ -f "$LOCK" && ! -L "$LOCK" && "$(stat -c '%u' "$LOCK" 2>/dev/null)" == "$UID_VALUE" ]]; then rm -f -- "$LOCK"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$UID_VALUE" != 0 ]] || die 'must run as a non-root service user'
[[ "$(id -un)" != codexia && "$HOME" != /home/codexia ]] || die 'refusing the production Codexia service identity'
[[ "${CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE:-}" == yes ]] || die 'set CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE=yes only on a disposable VM'
[[ -f "$MARKER" && ! -L "$MARKER" ]] || die "missing root-owned disposable VM marker: $MARKER"
[[ "$(stat -c '%u:%a' "$MARKER")" == 0:444 ]] || die 'disposable VM marker must be root-owned mode 0444'
[[ "$(cat -- "$MARKER")" == codexia-iac-disposable-vm/v1 ]] || die 'disposable VM marker identity is invalid'
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 26.04 ]] || die 'requires Ubuntu 26.04'
[[ "$(uname -m)" == x86_64 ]] || die 'requires amd64/x86_64'
virt="$(systemd-detect-virt --vm 2>/dev/null || true)"
[[ -n "$virt" && "$virt" != none && "$virt" != container ]] || die 'requires a disposable VM'
for command in buildah flock node od podman sha256sum systemctl systemd-detect-virt; do need "$command"; done
(( $(node -p 'Number(process.versions.node.split(".")[0])') >= 22 )) || die 'requires Node.js >=22'
[[ "$HOME" == /* && "$HOME" != *[[:space:]]* && "$CONFIG_HOME" == /* && "$CONFIG_HOME" != *[[:space:]]* ]] || die 'HOME/XDG_CONFIG_HOME must be absolute paths without whitespace'
[[ -d "$CONFIG_HOME" && ! -L "$CONFIG_HOME" && "$(stat -c '%u' "$CONFIG_HOME")" == "$UID_VALUE" ]] || die 'XDG_CONFIG_HOME must be a real directory owned by the service user'
[[ ! -L "$CONFIG_HOME/containers" && ! -L "$CONFIG_HOME/systemd" ]] || die 'unit directory parents must not be symlinks'
[[ -d "$RUNTIME_DIR" && "$(stat -c '%u' "$RUNTIME_DIR")" == "$UID_VALUE" ]] || die 'rootless XDG_RUNTIME_DIR is unavailable'
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || die 'requires cgroup v2'
[[ -d "$MODEL_CACHE_ROOT" && ! -L "$MODEL_CACHE_ROOT" && "$(realpath -- "$MODEL_CACHE_ROOT")" == "$MODEL_CACHE_ROOT" && -w "$MODEL_CACHE_ROOT" && -x "$MODEL_CACHE_ROOT" ]] || die 'requires a writable real /var/cache/codexia/models artifact directory for the synthetic Full fixture'
systemctl --user is-active --quiet default.target || die 'requires an active systemd user manager'
systemctl --user show-environment >/dev/null || die 'systemd user manager is unreachable'
manager_config_home="$(systemctl --user show-environment | sed -n 's/^XDG_CONFIG_HOME=//p')"
[[ -n "$manager_config_home" || "$CONFIG_HOME" == "$HOME/.config" ]] || die 'XDG_CONFIG_HOME differs from the systemd user manager configuration path'
[[ -z "$manager_config_home" || "$manager_config_home" == "$CONFIG_HOME" ]] || die 'XDG_CONFIG_HOME differs from the systemd user manager environment'
while IFS= read -r variable; do
  case "$variable" in
    *TOKEN*|*PASSWORD*|*SECRET*|*PRIVATE_KEY*|DATABASE_URL) die "refusing credential-bearing environment variable: $variable" ;;
  esac
done < <(compgen -e)

podman info --format json | node -e '
const fs = require("node:fs"); const v = JSON.parse(fs.readFileSync(0, "utf8"));
const get = (o, k) => Object.entries(o ?? {}).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1];
const h = get(v, "host"), s = get(h, "security"), c = get(h, "cgroupControllers") ?? [];
if (get(s, "rootless") !== true || get(h, "cgroupManager") !== "systemd" || get(h, "cgroupVersion") !== "v2" || !c.includes("cpu") || !c.includes("memory")) throw new Error("rootless systemd Podman with delegated CPU/memory cgroups is required");
' || die 'Podman rootless/systemd/cgroup prerequisites are unavailable'
if ! { [[ -x /usr/lib/systemd/user-generators/podman-user-generator ]] || [[ -x /usr/lib/systemd/system-generators/podman-system-generator ]]; }; then die 'Quadlet systemd generator is unavailable'; fi

must_not_exist() {
  local kind="$1" identity="$2" result
  set +e; podman "$kind" exists "$identity" >/dev/null 2>&1; result=$?; set -e
  (( result == 1 )) || die "refusing or unable to verify existing Codexia $kind identity: $identity"
}
for identity in codexia-api codexia-db codexia-api-proxy codexia-slot-blue codexia-slot-green "$PROXY_FIXTURE_CONTAINER"; do must_not_exist container "$identity"; done
for identity in codexia codexia-data; do must_not_exist network "$identity"; done
for identity in codexia-data codexia-history codexia-postgres; do must_not_exist volume "$identity"; done
for identity in codexia-postgres-app-password codexia-auth-token codexia-postgres-preflight-password; do must_not_exist secret "$identity"; done
quadlet_names=(codexia-slot-blue.container codexia-slot-green.container codexia-runtime-contract-proxy-fixture.container codexia-api-proxy.container codexia.network codexia-data.network codexia-data.volume codexia-history.volume codexia-db.container)
quadlet_roots=("$QUADLET_DIR" "$RUNTIME_DIR/containers/systemd" "/etc/containers/systemd/users/$UID_VALUE" /etc/containers/systemd/users)
for root in "${quadlet_roots[@]}"; do
  for filename in "${quadlet_names[@]}"; do
    [[ ! -e "$root/$filename" && ! -L "$root/$filename" ]] || die "refusing existing Quadlet identity: $root/$filename"
  done
done
for root in "$USER_UNIT_DIR" /etc/systemd/user /usr/lib/systemd/user "$RUNTIME_DIR/systemd/user" "$RUNTIME_DIR/systemd/generator"; do
  for unit in codexia-db.service codexia-slot-blue.service codexia-slot-green.service codexia-api-proxy.service "$PROXY_FIXTURE_UNIT" codexia-updater-boot.service codexia-updater.service codexia-updater.timer; do
    [[ ! -e "$root/$unit" && ! -L "$root/$unit" ]] || die "refusing existing systemd unit identity: $root/$unit"
    [[ ! -e "$root/$unit.d" && ! -L "$root/$unit.d" ]] || die "refusing existing systemd override identity: $root/$unit.d"
  done
done
for unit in codexia-slot-blue.service codexia-slot-green.service codexia-db.service codexia-api-proxy.service "$PROXY_FIXTURE_UNIT" codexia-updater-boot.service codexia-updater.service codexia-updater.timer; do
  load_state="$(systemctl --user show --property=LoadState --value "$unit" 2>/dev/null || true)"
  [[ -z "$load_state" || "$load_state" == not-found ]] || die "refusing loaded unit identity: $unit"
done

if [[ -e "$LOCK" || -L "$LOCK" ]]; then
  [[ -f "$LOCK" && ! -L "$LOCK" && "$(stat -c '%u' "$LOCK")" == "$UID_VALUE" ]] || die 'acceptance lock path is not a private user-owned file'
fi
exec 9>>"$LOCK"
chmod 0600 "$LOCK"
flock -n 9 || die 'another acceptance run is active'
LOCK_ACQUIRED=1
NONCE="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
WORK_DIR="$(mktemp -d "/var/tmp/codexia-runtime-contract-acceptance.$UID_VALUE.XXXXXX")"
readonly WORK_DIR
MODEL_DIR="$MODEL_CACHE_ROOT/.runtime-contract-test.$UID_VALUE.$NONCE"
readonly MODEL_DIR
[[ ! -e "$MODEL_DIR" && ! -L "$MODEL_DIR" ]] || die 'refusing an existing synthetic model artifact identity'
MODEL_ALIAS="$MODEL_CACHE_ROOT/.runtime-contract-test.$UID_VALUE.$NONCE.alias"
readonly MODEL_ALIAS
[[ ! -e "$MODEL_ALIAS" && ! -L "$MODEL_ALIAS" ]] || die 'refusing an existing synthetic model alias identity'
CLEANUP_ARMED=1
mkdir -m 0700 -- "$MODEL_DIR"
MODEL_DIR_CREATED=1
ln -s -- "$MODEL_DIR" "$MODEL_ALIAS"
MODEL_ALIAS_CREATED=1
mkdir -m 0700 -- "$WORK_DIR/image"
printf 'synthetic model artifact\n' > "$MODEL_DIR/model.txt"
chmod 0644 "$MODEL_DIR/model.txt"
if [[ ! -d "$CONFIG_HOME/containers" ]]; then mkdir -m 0700 -- "$CONFIG_HOME/containers"; CREATED_CONTAINERS_DIR=1; fi
if [[ ! -d "$QUADLET_DIR" ]]; then mkdir -m 0700 -- "$QUADLET_DIR"; CREATED_QUADLET_DIR=1; fi
if [[ ! -d "$CONFIG_HOME/systemd" ]]; then mkdir -m 0700 -- "$CONFIG_HOME/systemd"; CREATED_SYSTEMD_CONFIG_DIR=1; fi
if [[ ! -d "$USER_UNIT_DIR" ]]; then mkdir -m 0700 -- "$USER_UNIT_DIR"; CREATED_USER_UNIT_DIR=1; fi
[[ ! -L "$QUADLET_DIR" && ! -L "$USER_UNIT_DIR" ]] || die 'unit directories must not be symlinks'

write_owned_file() {
  local path="$1" mode="$2" temporary="${1}.tmp.${NONCE}"
  [[ ! -e "$path" && ! -L "$path" ]] || die "refusing to overwrite $path"
  OWNED_FILES+=("$path")
  cat > "$temporary"
  chmod "$mode" "$temporary"
  ln -- "$temporary" "$path" || die "failed to install owned fixture $path"
  rm -f -- "$temporary"
}

write_owned_file "$QUADLET_DIR/codexia.network" 0600 <<EOF
[Network]
NetworkName=codexia
Driver=bridge
Label=codexia-runtime-contract-test=$NONCE
EOF
write_owned_file "$QUADLET_DIR/codexia-data.network" 0600 <<EOF
[Network]
NetworkName=codexia-data
Driver=bridge
Internal=true
Label=codexia-runtime-contract-test=$NONCE
EOF
write_owned_file "$QUADLET_DIR/codexia-data.volume" 0600 <<EOF
[Volume]
VolumeName=codexia-data
Label=codexia-runtime-contract-test=$NONCE
EOF
write_owned_file "$QUADLET_DIR/codexia-history.volume" 0600 <<EOF
[Volume]
VolumeName=codexia-history
Label=codexia-runtime-contract-test=$NONCE
EOF
write_owned_file "$USER_UNIT_DIR/codexia-db.service" 0600 <<EOF
[Unit]
Description=Codexia runtime acceptance dependency $NONCE
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/true
ExecStop=/usr/bin/true
EOF
OWNED_UNITS=(
  codexia-slot-blue.service codexia-slot-green.service codexia-db.service
  codexia-api-proxy.service codexia-updater-boot.service codexia-updater.service codexia-updater.timer
  "$PROXY_FIXTURE_UNIT"
  codexia-network.service codexia-data-network.service
  codexia-data-volume.service codexia-history-volume.service
)

cat > "$WORK_DIR/image/health.mjs" <<'EOF'
import http from 'node:http';
const version={name:'codexia',version:'0.1.0',profile:process.env.CODEXIA_PROFILE,hosted:false,apiEpoch:1,browserAuth:'token'};
http.createServer((request,response)=>{
  const route=new URL(request.url,'http://localhost').pathname;
  if(route==='/health/ready'){response.writeHead(200,{'Content-Type':'text/plain'});response.end('ready');return;}
  if(route==='/api/version'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(version));return;}
  response.writeHead(404);response.end();
}).listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0');
EOF
cat > "$WORK_DIR/image/Containerfile" <<'EOF'
FROM docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ARG CODEXIA_RUNTIME_TEST_NONCE
LABEL codexia.runtime-contract-test=${CODEXIA_RUNTIME_TEST_NONCE}
COPY health.mjs /opt/codexia-runtime-contract-health.mjs
CMD ["node", "/opt/codexia-runtime-contract-health.mjs"]
EOF
IMAGE_TAG="localhost/codexia-runtime-contract-test:$NONCE"
podman build --pull=always --build-arg "CODEXIA_RUNTIME_TEST_NONCE=$NONCE" --tag "$IMAGE_TAG" "$WORK_DIR/image"
IMAGE_ID="$(normalize_image_id "$(podman image inspect --format '{{.Id}}' "$IMAGE_TAG")")"
[[ "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'synthetic fixture image is not content-addressed'
image_label="$(podman image inspect --format '{{ index .Labels "codexia.runtime-contract-test" }}' "$IMAGE_TAG")"
[[ "$image_label" == "$NONCE" ]] || die 'synthetic fixture image ownership label mismatch'

printf '%s\n' 'synthetic secret fixture' > "$WORK_DIR/secret"
podman secret create codexia-auth-token "$WORK_DIR/secret" >/dev/null
OWNED_SECRETS+=(codexia-auth-token)
podman secret create codexia-postgres-app-password "$WORK_DIR/secret" >/dev/null
OWNED_SECRETS+=(codexia-postgres-app-password)

OWNED_FILES+=("$QUADLET_DIR/codexia-slot-blue.container" "$QUADLET_DIR/codexia-slot-green.container")
node --input-type=module - "$REPO_ROOT" "$QUADLET_DIR" "$WORK_DIR" "$IMAGE_ID" "$MODEL_DIR" <<'NODE'
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repoRoot, quadletDir, workDir, image, modelCachePath] = process.argv.slice(2);
const host = await import(pathToFileURL(path.join(repoRoot, 'deploy/updater/standalone-host.mjs')).href);
const auth = host.browserAuthEnvironment({ browserAuth: { mode: 'token' } }, 'https://codexia.invalid');
const runtimes = {
  blue: host.validateRuntimeContract({
    format: 'codexia-runtime/v1', profile: 'core', modelCachePath: null,
    tmpfs: { tempSize: '64m', moduleCacheSize: '128m' },
    resources: { memoryMaxBytes: 2 * 1024 ** 3, cpuQuotaPercent: 100 },
  }),
  green: host.validateRuntimeContract({
    format: 'codexia-runtime/v1', profile: 'full', modelCachePath,
    tmpfs: { tempSize: '64m', moduleCacheSize: '512m' },
    resources: { memoryMaxBytes: 3 * 1024 ** 3, cpuQuotaPercent: 200 },
  }),
};
for (const slot of ['blue', 'green']) {
  const runtime = runtimes[slot];
  const release = { image, profile: runtime.profile };
  const unit = host.imageConfig(release, auth, runtime).replace('PLACEHOLDER', `codexia-slot-${slot}`);
  await writeFile(path.join(quadletDir, `codexia-slot-${slot}.container`), unit, { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(workDir, `codexia-runtime-${slot}.json`), JSON.stringify(runtime) + '\n', { mode: 0o600, flag: 'wx' });
}
NODE

cat > "$WORK_DIR/proxy-fixture.mjs" <<'EOF'
import http from 'node:http';
const revision='revision-1';
http.createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/plain'});response.end(revision);}).listen(3000,'0.0.0.0');
EOF
chmod 0600 "$WORK_DIR/proxy-fixture.mjs"
write_owned_file "$QUADLET_DIR/codexia-runtime-contract-proxy-fixture.container" 0600 <<EOF
[Unit]
Description=Codexia runtime contract proxy reload fixture $NONCE
[Container]
Image=$IMAGE_ID
ContainerName=$PROXY_FIXTURE_CONTAINER
Network=codexia.network
Volume=$WORK_DIR/proxy-fixture.mjs:/config/proxy.mjs:ro,Z
User=0
Entrypoint=node
Exec=/config/proxy.mjs
ReadOnly=true
NoNewPrivileges=true
DropCapability=all
Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m
Label=codexia-runtime-contract-test=$NONCE
[Service]
Restart=on-failure
RestartSec=1
[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
diagnose_missing_generated_unit() {
  local unit="$1" path generator log
  printf 'Quadlet generation diagnostics for %s:\n' "$unit" >&2
  printf '%s\n' '--- systemd user manager environment and unit search paths ---' >&2
  systemctl --user show-environment | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=' >&2 || true
  systemctl --user show --property=UnitPath >&2 || true
  systemd-analyze --user unit-paths >&2 || true
  systemctl --user show --property=LoadState --property=FragmentPath --property=SourcePath "$unit" >&2 || true
  systemctl --user list-unit-files --no-pager >&2 || true
  printf '%s\n' '--- Quadlet source and generated directories ---' >&2
  for path in \
    "$QUADLET_DIR" \
    "$USER_UNIT_DIR" \
    "$RUNTIME_DIR/systemd/generator.early" \
    "$RUNTIME_DIR/systemd/generator" \
    "$RUNTIME_DIR/systemd/generator.late"; do
    if [[ -d "$path" ]]; then find "$path" -maxdepth 4 -printf '%M %u:%g %p\n' >&2 || true
    else printf 'Missing path: %s\n' "$path" >&2; fi
  done
  printf '%s\n' '--- user journal for Podman/Quadlet generation ---' >&2
  journalctl --user -b -n 100 --no-pager -o short-iso --grep='(?i)(podman|quadlet|codexia|generator|failed|error|warn)' >&2 || true
  printf '%s\n' '--- system journal for the fixture UID ---' >&2
  journalctl -b -n 100 --no-pager -o short-iso --grep='(?i)(podman|quadlet|codexia|generator|failed|error|warn)' "_UID=$UID_VALUE" >&2 || true
  printf '%s\n' '--- installed generators ---' >&2
  for generator in /usr/lib/systemd/user-generators/podman-user-generator /usr/lib/systemd/system-generators/podman-system-generator; do
    if [[ -x "$generator" ]]; then
      printf 'Selected candidate: %s -> %s\n' "$generator" "$(realpath -- "$generator")" >&2
      log="$WORK_DIR/$(basename -- "$generator").diagnostic.log"
      if SYSTEMD_LOG_LEVEL=debug "$generator" -dryrun -v >"$log" 2>&1; then cat -- "$log" >&2
      else printf 'Generator returned %s; output follows:\n' "$?" >&2; cat -- "$log" >&2; fi
    else printf 'Unavailable generator: %s\n' "$generator" >&2; fi
  done
}
for unit in codexia-slot-blue.service codexia-slot-green.service "$PROXY_FIXTURE_UNIT" codexia-network.service codexia-data-network.service codexia-data-volume.service codexia-history-volume.service; do
  if ! systemctl --user cat "$unit" >/dev/null; then
    diagnose_missing_generated_unit "$unit"
    die "Quadlet did not generate $unit"
  fi
done

wait_for_unit() {
  local unit="$1" expected="$2" attempt
  for attempt in {1..60}; do
    if [[ "$(systemctl --user show --property=ActiveState --value "$unit" 2>/dev/null || true)" == "$expected" ]]; then return 0; fi
    sleep 1
  done
  die "systemd unit $unit did not reach $expected"
}

stop_slot_writer() {
  local slot="$1"
  node --input-type=module - "$REPO_ROOT" "$WORK_DIR" "$slot" <<'NODE'
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repoRoot, workDir, slot] = process.argv.slice(2);
const { PodmanStandaloneHost } = await import(pathToFileURL(path.join(repoRoot, 'deploy/updater/standalone-host.mjs')).href);
const host = new PodmanStandaloneHost({
  browserAuth: { mode: 'token' },
  frontendIdentityUrl: 'https://codexia.example.invalid/desktop/update-identity.json',
  routeFile: path.join(workDir, 'route'),
  quadletDirectory: path.join(workDir, 'quadlets'),
  githubTokenFile: path.join(workDir, 'github-token'),
});
await host.stopWriter(slot);
NODE
}

write_proxy_fixture_revision() {
  local revision="$1"
  cat > "$WORK_DIR/proxy-fixture.mjs" <<EOF
import http from 'node:http';
const revision='$revision';
http.createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/plain'});response.end(revision);}).listen(3000,'0.0.0.0');
EOF
  chmod 0600 "$WORK_DIR/proxy-fixture.mjs"
}

exercise_proxy_fixture_revision() {
  local expected="$1" expect_failure="${2:-no}"
  node --input-type=module - "$REPO_ROOT" "$PROXY_FIXTURE_UNIT" "$PROXY_FIXTURE_CONTAINER" "$expected" "$expect_failure" <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repoRoot,unit,container,expected,expectFailure]=process.argv.slice(2);
const {activateProxyRevision}=await import(pathToFileURL(path.join(repoRoot,'deploy/updater/standalone-maintenance.mjs')).href);
const restart=()=>execFileSync('systemctl',['--user','restart',unit],{stdio:'ignore'});
const verify=async()=>{
  const deadline=Date.now()+15000;
  for(;;){
    let actual=null;
    try{actual=execFileSync('podman',['exec',container,'node','--input-type=module','-e','const response=await fetch("http://127.0.0.1:3000/revision");process.stdout.write(await response.text())'],{encoding:'utf8',timeout:3000}).trim();}catch{}
    if(actual!==null){assert.equal(actual,expected,'Proxy source revision did not become active');return;}
    if(Date.now()>=deadline)throw new Error('Proxy fixture did not become ready after restart');
    await delay(100);
  }
};
if(expectFailure==='yes')await assert.rejects(activateProxyRevision({changed:true,restart,verify}),/Proxy source revision did not become active/u);
else assert.equal(await activateProxyRevision({changed:true,restart,verify}),true);
NODE
}

systemctl --user start "$PROXY_FIXTURE_UNIT"
wait_for_unit "$PROXY_FIXTURE_UNIT" active
exercise_proxy_fixture_revision revision-1
write_proxy_fixture_revision revision-2
exercise_proxy_fixture_revision revision-2
cp -- "$WORK_DIR/proxy-fixture.mjs" "$WORK_DIR/proxy-fixture.rollback.mjs"
write_proxy_fixture_revision revision-3
exercise_proxy_fixture_revision revision-2 yes
cp -- "$WORK_DIR/proxy-fixture.rollback.mjs" "$WORK_DIR/proxy-fixture.mjs"
exercise_proxy_fixture_revision revision-2
write_proxy_fixture_revision revision-4
systemctl --user restart "$PROXY_FIXTURE_UNIT"
wait_for_unit "$PROXY_FIXTURE_UNIT" active
cp -- "$WORK_DIR/proxy-fixture.rollback.mjs" "$WORK_DIR/proxy-fixture.mjs"
exercise_proxy_fixture_revision revision-2

run_node_check() {
  local slot="$1" image="$2"
  node --input-type=module - "$slot" "$image" "$REPO_ROOT" "$QUADLET_DIR" "$WORK_DIR" "$MODEL_ALIAS" <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [slot, image, repoRoot, quadletDir, workDir, modelAlias] = process.argv.slice(2);
const name = `codexia-slot-${slot}`;
const service = `${name}.service`;
const host = await import(pathToFileURL(path.join(repoRoot, 'deploy/updater/standalone-host.mjs')).href);
const runtime = JSON.parse(await readFile(path.join(workDir, `codexia-runtime-${slot}.json`), 'utf8'));
const inspect = JSON.parse(execFileSync('podman', ['inspect', '--type', 'container', name], { encoding: 'utf8' }))[0];
const imageInfo = JSON.parse(execFileSync('podman', ['image', 'inspect', image], { encoding: 'utf8' }))[0];
const quadletText = await readFile(path.join(quadletDir, `${name}.container`), 'utf8');
const sourceHost = new host.PodmanStandaloneHost({
  browserAuth: { mode: 'token' }, frontendIdentityUrl: 'https://codexia.invalid/desktop/update-identity.json',
  routeFile: path.join(workDir, 'route'), quadletDirectory: quadletDir, githubTokenFile: path.join(workDir, 'token'), runtime,
});
await sourceHost.assertRuntimeSources();
if (runtime.modelCachePath) {
  const aliasHost = new host.PodmanStandaloneHost({
    browserAuth: { mode: 'token' }, frontendIdentityUrl: 'https://codexia.invalid/desktop/update-identity.json',
    routeFile: path.join(workDir, 'route'), quadletDirectory: quadletDir, githubTokenFile: path.join(workDir, 'token'),
    runtime: { ...runtime, modelCachePath: modelAlias },
  });
  await assert.rejects(aliasHost.assertRuntimeSources(), /real directory/u);
}
assert.equal(inspect.State?.Running, true, `${name} is not running`);
const observedImage = typeof inspect.Image === 'string' && inspect.Image.startsWith('sha256:') ? inspect.Image : `sha256:${inspect.Image}`;
assert.equal(observedImage, image, `${name} image identity is not pinned to the local fixture digest`);
const capabilityStatus = await host.readRuntimeCapabilityStatus(inspect, name);
host.assertRuntimeObservation(inspect, runtime, imageInfo.Config?.Env, quadletText, capabilityStatus);
host.assertRuntimeUnit(execFileSync('systemctl', ['--user', 'cat', service], { encoding: 'utf8' }), runtime);
await host.assertRuntimeSystemdCpuQuota(service, runtime);
const cgroupPath = await host.assertRuntimeProcessInSystemdUnit(service, inspect, name);
const pid = inspect.State.Pid;
const memoryMax = await readFile(path.join(cgroupPath, 'memory.max'), 'utf8');
assert.equal(memoryMax.trim(), String(runtime.resources.memoryMaxBytes), `${name} effective memory.max drift`);

const mountinfo = await readFile(`/proc/${pid}/mountinfo`, 'utf8');
const mounts = new Map(mountinfo.split('\n').filter(Boolean).map(line => {
  const [before, after] = line.split(' - ');
  const fields = before.split(' ');
  const right = after.split(' ');
  const unescape = value => value.replace(/\\040/gu, ' ').replace(/\\011/gu, '\t').replace(/\\134/gu, '\\');
  return [unescape(fields[4]), { type: right[0], options: new Set([...fields[5].split(','), ...right.slice(2).join(' ').split(',')]) }];
}));
const bytesFor = value => {
  const [, amount, unit] = /^(\d+)(m|g)$/iu.exec(value) ?? [];
  return BigInt(amount) * (unit.toLowerCase() === 'g' ? 1024n ** 3n : 1024n ** 2n);
};
const bytesFromOption = value => {
  const match = /^(\d+)([kmgt]?)$/iu.exec(value);
  assert.ok(match, `tmpfs size is not parseable: ${value}`);
  const factors = { '': 1n, k: 1024n, m: 1024n ** 2n, g: 1024n ** 3n, t: 1024n ** 4n };
  return BigInt(match[1]) * factors[match[2].toLowerCase()];
};
for (const [mountpoint, size] of [['/tmp', runtime.tmpfs.tempSize], ['/cache', runtime.tmpfs.moduleCacheSize]]) {
  const mount = mounts.get(mountpoint);
  assert.ok(mount, `${mountpoint} is not mounted in ${name}`);
  assert.equal(mount.type, 'tmpfs', `${mountpoint} is not tmpfs`);
  assert.ok(mount.options.has('rw'), `${mountpoint} is not writable`);
  const sizeOption = [...mount.options].find(option => option.startsWith('size='));
  assert.ok(sizeOption, `${mountpoint} tmpfs size is unobservable`);
  assert.equal(bytesFromOption(sizeOption.slice(5)), bytesFor(size), `${mountpoint} effective tmpfs size drift`);
}
const modelMount = inspect.Mounts.find(mount => mount.Destination === '/models');
if (runtime.profile === 'full') {
  assert.ok(modelMount, 'Full model mount is absent');
  assert.equal(modelMount.Type, 'bind');
  assert.equal(modelMount.RW, false, 'Full model mount is writable');
  assert.ok(mounts.get('/models')?.options.has('ro'), 'Full model mount is not read-only in mountinfo');
} else {
  assert.equal(modelMount, undefined, 'Core profile unexpectedly mounts models');
}
NODE
}

write_and_check_markers() {
  local container="$1" mode="$2"
  podman exec "$container" node --input-type=module -e '
    import { writeFileSync, readFileSync } from "node:fs";
    const files = [["/data/runtime-contract-marker", "data-marker-v1"], ["/history/runtime-contract-marker", "history-marker-v1"]];
    if (process.argv[1] === "write") for (const [file, value] of files) writeFileSync(file, value + "\n", { flag: "w" });
    for (const [file, value] of files) if (readFileSync(file, "utf8") !== value + "\n") throw new Error(`persistent marker mismatch: ${file}`);
  ' "$mode"
}

assert_exclusive_writer() {
  local expected="$1" slot container running status
  for slot in blue green; do
    container="codexia-slot-$slot"
    running=false
    set +e
    podman container exists "$container" >/dev/null 2>&1
    status=$?
    set -e
    if (( status == 0 )); then
      running="$(podman inspect --type container --format '{{.State.Running}}' "$container")"
    elif (( status != 1 )); then
      die "cannot observe slot container state: $container"
    fi
    if [[ "$slot" == "$expected" ]]; then
      [[ "$running" == true ]] || die "expected writer is not running: $container"
    else
      [[ "$running" != true ]] || die "overlapping writer detected: $container"
    fi
  done
}

read_only_model_write_rejected() {
  local container="$1"
  node --input-type=module - "$container" <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const [container] = process.argv.slice(2);
try {
  execFileSync('podman', ['exec', '--user', '0', container, 'node', '--input-type=module', '-e', 'import fs from "node:fs"; fs.writeFileSync("/models/forbidden-write", "x")'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  assert.match(`${error.stdout ?? ''}${error.stderr ?? ''}`, /EROFS/u, 'model write did not fail because the mount is read-only');
  process.exit(0);
}
throw new Error('Full model mount accepted a write from container root');
NODE
  [[ ! -e "$MODEL_DIR/forbidden-write" ]] || die 'Full model mount wrote into its host source'
}

systemd_override_rejected() {
  local unit="$1" runtime_file="$2" source_file="$3" source_sha="$4"
  node --input-type=module - "$REPO_ROOT" "$unit" "$runtime_file" "$source_file" "$source_sha" <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repoRoot, unit, runtimeFile, sourceFile, expectedSha] = process.argv.slice(2);
const host = await import(pathToFileURL(path.join(repoRoot, 'deploy/updater/standalone-host.mjs')).href);
const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
host.assertRuntimeUnit(await readFile(sourceFile, 'utf8'), runtime);
host.assertRuntimeUnit(execFileSync('systemctl', ['--user', 'cat', unit], { encoding: 'utf8' }), runtime);
assert.equal(execFileSync('sha256sum', [sourceFile], { encoding: 'utf8' }).split(' ')[0], expectedSha, 'Quadlet source drifted during cgroup override');
try {
  await host.assertRuntimeSystemdCpuQuota(unit, runtime);
} catch (error) {
  if (/Effective CPU quota drift/u.test(String(error?.message))) process.exit(0);
  throw error;
}

throw new Error('effective CPU cgroup override was not rejected');
NODE
}

remove_effective_override_text() {
  local unit="$1" expected_quota="$2" before_dropins="$3" dropins file was_new in_unit_dir file_state owner quota_lines
  local -a candidates=()
  dropins="$(systemctl --user show --property=DropInPaths --value "$unit")"
  printf 'Runtime override diagnostic for %s: baseline DropInPaths=%s\n' "$unit" "${before_dropins:-<empty>}" >&2
  printf 'Runtime override diagnostic for %s: current DropInPaths=%s\n' "$unit" "${dropins:-<empty>}" >&2
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    was_new=yes
    case " $before_dropins " in *" $file "*) was_new=no ;; esac
    in_unit_dir=no
    [[ "$file" == *"/$unit.d/"* ]] && in_unit_dir=yes
    file_state=missing owner=unknown quota_lines=0
    if [[ -f "$file" && ! -L "$file" ]]; then
      file_state=regular
      owner="$(stat -c '%u' "$file" 2>/dev/null || printf unknown)"
      quota_lines="$(grep -Fxc "CPUQuota=$expected_quota" "$file" || true)"
    elif [[ -L "$file" ]]; then file_state=symlink
    elif [[ -e "$file" ]]; then file_state=non-regular
    fi
    printf 'Runtime override diagnostic for %s: path=%s new=%s unit-drop-in=%s type=%s owner=%s expected-quota-line-count=%s\n' \
      "$unit" "$file" "$was_new" "$in_unit_dir" "$file_state" "$owner" "$quota_lines" >&2
    [[ "$was_new" == yes && "$in_unit_dir" == yes && "$file_state" == regular && "$owner" == "$UID_VALUE" && "$quota_lines" == 1 ]] && candidates+=("$file")
  done < <(tr ' ' '\n' <<< "$dropins")
  (( ${#candidates[@]} == 1 )) || die 'could not identify the unique newly created systemd CPUQuota override file'
  rm -- "${candidates[0]}"
}

systemctl --user start codexia-slot-blue.service
wait_for_unit codexia-slot-blue.service active
assert_exclusive_writer blue
run_node_check blue "$IMAGE_ID"
write_and_check_markers codexia-slot-blue write

stop_slot_writer blue
wait_for_unit codexia-slot-blue.service inactive
assert_exclusive_writer none
systemctl --user start codexia-slot-green.service
wait_for_unit codexia-slot-green.service active
assert_exclusive_writer green
run_node_check green "$IMAGE_ID"
write_and_check_markers codexia-slot-green verify
read_only_model_write_rejected codexia-slot-green

VOLUME_DATA_MOUNT="$(podman volume inspect --format '{{.Mountpoint}}' codexia-data)"
VOLUME_HISTORY_MOUNT="$(podman volume inspect --format '{{.Mountpoint}}' codexia-history)"
node --input-type=module - "$REPO_ROOT" "$MODEL_DIR" "$VOLUME_DATA_MOUNT" "$VOLUME_HISTORY_MOUNT" <<'NODE'
import { pathToFileURL } from 'node:url';
const [repoRoot, modelPath, ...volumeMounts] = process.argv.slice(2);
const host = await import(pathToFileURL(`${repoRoot}/deploy/updater/standalone-host.mjs`).href);
host.assertModelCacheOutsideVolumes(modelPath, volumeMounts);
NODE

FULL_RUNTIME_FILE="$WORK_DIR/codexia-runtime-green.json"
FULL_SOURCE_FILE="$QUADLET_DIR/codexia-slot-green.container"
FULL_SOURCE_SHA="$(sha256sum "$FULL_SOURCE_FILE" | awk '{print $1}')"
FULL_DROPINS_BEFORE="$(systemctl --user show --property=DropInPaths --value codexia-slot-green.service)"
systemctl --user set-property --runtime codexia-slot-green.service CPUQuota=100%
remove_effective_override_text codexia-slot-green.service 100% "$FULL_DROPINS_BEFORE"
systemd_override_rejected codexia-slot-green.service "$FULL_RUNTIME_FILE" "$FULL_SOURCE_FILE" "$FULL_SOURCE_SHA"
systemctl --user set-property --runtime codexia-slot-green.service CPUQuota=200%
node --input-type=module - "$REPO_ROOT" codexia-slot-green.service "$FULL_RUNTIME_FILE" <<'NODE'
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repoRoot, unit, runtimeFile] = process.argv.slice(2);
const host = await import(pathToFileURL(path.join(repoRoot, 'deploy/updater/standalone-host.mjs')).href);
await host.assertRuntimeSystemdCpuQuota(unit, JSON.parse(await readFile(runtimeFile, 'utf8')));
NODE
systemctl --user revert --runtime codexia-slot-green.service
systemctl --user daemon-reload
systemctl --user restart codexia-slot-green.service
wait_for_unit codexia-slot-green.service active
assert_exclusive_writer green
run_node_check green "$IMAGE_ID"
write_and_check_markers codexia-slot-green verify

stop_slot_writer green
wait_for_unit codexia-slot-green.service inactive
assert_exclusive_writer none
systemctl --user start codexia-slot-blue.service
wait_for_unit codexia-slot-blue.service active
assert_exclusive_writer blue
run_node_check blue "$IMAGE_ID"
write_and_check_markers codexia-slot-blue verify
systemctl --user restart codexia-slot-blue.service
wait_for_unit codexia-slot-blue.service active
assert_exclusive_writer blue
run_node_check blue "$IMAGE_ID"
write_and_check_markers codexia-slot-blue verify

OWNED_FILES+=("$QUADLET_DIR/codexia-api-proxy.container")
CODEXIA_RUNTIME_MAINTENANCE_REPO_ROOT="$REPO_ROOT" \
CODEXIA_RUNTIME_MAINTENANCE_IMAGE="$IMAGE_ID" \
CODEXIA_RUNTIME_MAINTENANCE_NONCE="$NONCE" \
  node "$SCRIPT_DIR/test-standalone-maintenance-integration.mjs" --run "$REPO_ROOT" "$QUADLET_DIR" "$USER_UNIT_DIR" "$WORK_DIR"

printf 'PASS: pinned synthetic Core/Full Quadlets, rootless Podman/systemd, effective resource limits, read-only models, blue/green persistence, fail-closed locked boot recovery after process kill, real timer verification and post-update restart\n'
