#!/usr/bin/env bash
# Rootless host portion of the separately admitted pair cutover.
set -Eeuo pipefail
umask 077

state_dir="${CODEXIA_PUSH_STATE_DIR:?Cutover state directory is required}"
[[ "$state_dir" == /* && -d "$state_dir" && ! -L "$state_dir" && -O "$state_dir" ]] ||
  { echo 'Cutover requires the existing rootless deployment state directory' >&2; exit 1; }
lock_file="$state_dir/host.lock"
[[ -f "$lock_file" && ! -L "$lock_file" && -O "$lock_file" ]] ||
  { echo 'Cutover requires the existing canonical regular host lock' >&2; exit 1; }
exec 9<"$lock_file"
lock_mode=--exclusive
[[ "${1:-}" != observe ]] || lock_mode=--shared
flock "$lock_mode" --nonblock 9 ||
  { echo 'Another Codexia operation holds the deployment host lock' >&2; exit 75; }

exec python3 - "$@" <<'PY'
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from time import monotonic, sleep

STATE = Path(os.environ["CODEXIA_PUSH_STATE_DIR"])
QUADLETS = Path(os.environ["CODEXIA_PUSH_QUADLET_DIR"])
HOME_DIR = Path.home()
SYSTEMD = Path(os.environ.get("XDG_CONFIG_HOME", HOME_DIR / ".config")) / "systemd/user"
LOCK = STATE / "host.lock"
JOURNAL = STATE / "cutover-transaction.json"
TERMINAL = STATE / "cutover-last-completed.json"
RELEASE = STATE / "deployed-release.json"
PRIOR_RELEASE = STATE / "cutover-prior-release.json"
API = "codexia-api"
TUNNEL = "codexia-tunnel"
DATABASE = "codexia-db"
MAINTENANCE = "codexia-cutover-maintenance"
ACTIVE_UNIT = QUADLETS / f"{API}.container"
PRIOR_UNIT = STATE / "cutover-prior-api.container"
API_WANTS = QUADLETS / "default.target.wants/codexia-api.service"
TUNNEL_WANTS = QUADLETS / "default.target.wants/codexia-tunnel.service"
PODMAN = ("podman",)
SYSTEMCTL = ("systemctl", "--user")
API_DIST = "/app/node_modules/@codexia/api/dist"
IMMUTABLE_IMAGE = r"ghcr\.io/yohn-jp/codexia-backend@sha256:[0-9a-f]{64}"
HASH = r"[0-9a-f]{64}"
PLAN_FIELDS = (
    "planSha256", "sourceHostId", "databaseSystemIdentifier", "priorImage",
    "candidateImage", "priorIdentity", "candidateIdentity", "priorContainerId",
    "priorUnitSha256", "candidateUnit", "candidateUnitSha256", "notAfter",
    "migration", "settingsSha256", "ownerBindingSha256",
)
BACKUP_FIELDS = ("checksumManifestSha256", "databaseFingerprint", "historyFingerprint")
BLOCK_DROPIN = b"[Unit]\nConditionPathExists=/dev/null/codexia-cutover-blocked\n"


class CutoverError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CutoverError(message)


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def present(path):
    return path.exists() or path.is_symlink()


def regular(path, private=False):
    info = path.lstat()
    mode = stat.S_IMODE(info.st_mode)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or (private and mode != 0o600):
        label = path.name
        if not matches(r"[a-zA-Z0-9_.-]{1,128}", label):
            label = "input"
        raise CutoverError(f"Cutover {label} requires a rootless-owned regular file with the required permissions "
                           f"(mode {mode:04o}, owner matches: {info.st_uid == os.getuid()})")
    return path


def data(path, private=False):
    document = json.loads(regular(path, private).read_text())
    require(isinstance(document, dict), "Cutover input or state must be a JSON object")
    return document


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_write(path, content, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), mode)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fsync_dir(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def save(path, value):
    durable_write(path, (json.dumps(value, sort_keys=True) + "\n").encode())


def emit(value):
    print(json.dumps(value, sort_keys=True))


def command(args, error, allowed=(0,)):
    # Keep subprocess stdout/stderr out of the deployment log. The inherited
    # lock also covers a child command if this coordinator is interrupted.
    process = subprocess.run(args, capture_output=True, text=True, pass_fds=(9,))
    require(process.returncode in allowed, error)
    return process.returncode, process.stdout.strip()


def output(args, error):
    return command(args, error)[1]


def json_output(args, error, expected_type):
    try:
        document = json.loads(output(args, error))
    except (ValueError, TypeError):
        raise CutoverError(error) from None
    require(isinstance(document, expected_type), error)
    return document


def service(action, name):
    output((*SYSTEMCTL, action, f"{name}.service"), f"Could not {action} canonical {name} service")


def property_of(name, prop):
    return output((*SYSTEMCTL, "show", f"--property={prop}", "--value", f"{name}.service"),
                  f"Could not inspect canonical {name} service")


def inspect(name, field):
    return output((*PODMAN, "inspect", "--format", "{{." + field + "}}", name),
                  f"Could not inspect canonical {name} container")


def container_exists(name):
    return command((*PODMAN, "container", "exists", name), "Could not enumerate rootless containers",
                   allowed=(0, 1))[0] == 0


def running(name):
    if not container_exists(name):
        return False
    state = inspect(name, "State.Running")
    require(state in ("true", "false"), "Podman did not report a definitive container state")
    return state == "true"


def service_origin(name):
    require(property_of(name, "SourcePath") == str(QUADLETS / f"{name}.container"),
            f"The {name} service does not originate from its canonical Quadlet")


def require_mount(container, volume, destination):
    mounts = json_output((*PODMAN, "inspect", "--format", "{{json .Mounts}}", container),
                         "Could not inspect canonical storage mounts", list)
    relevant = [mount for mount in mounts if isinstance(mount, dict) and
                (mount.get("Destination") == destination or
                 str(mount.get("Destination", "")).startswith(destination + "/"))]
    require(len(relevant) == 1 and relevant[0].get("Type") == "volume" and
            relevant[0].get("Name") == volume and relevant[0].get("Destination") == destination and
            relevant[0].get("RW") is True, "The canonical storage volume or mount changed")


def postgres_read(sql):
    return output((*PODMAN, "exec", DATABASE, "sh", "-ec", '''
        export PGPASSWORD="$(cat /run/secrets/admin-password)"
        export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000"
        exec psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "$1"
    ''', "sh", sql), "Could not verify local PostgreSQL state")


def cluster_identity():
    require(property_of(DATABASE, "ActiveState") == "active" and running(DATABASE) and
            inspect(DATABASE, "State.Health.Status") == "healthy", "PostgreSQL is not healthy")
    service_origin(DATABASE)
    require_mount(DATABASE, "codexia-postgres", "/var/lib/postgresql/data")
    result = postgres_read("SELECT system_identifier FROM pg_control_system()")
    require(matches(r"[1-9][0-9]{0,19}", result), "PostgreSQL returned an invalid cluster identity")
    return result


def host_identity():
    machine_id = Path("/etc/machine-id").read_text().strip()
    require(matches(r"[0-9a-f]{32}", machine_id), "The rootless host has no valid machine identity")
    return sha256(machine_id.encode())


def backend_identity(value):
    require(isinstance(value, dict) and value.get("format") == "codexia-backend-identity/v1" and
            value.get("profile") == "full" and value.get("platform") == "linux/amd64" and
            type(value.get("apiEpoch")) is int and value["apiEpoch"] > 0 and
            type(value.get("persistenceFormat")) is int and value["persistenceFormat"] > 0 and
            matches(r"[0-9a-f]{40}", value.get("sourceSha")) and matches(r"(0|[1-9]\d*)(\.(0|[1-9]\d*)){2}", value.get("version")) and
            matches(r"sha256:[0-9a-f]{64}", value.get("migrationFingerprint")),
            "Invalid pinned Full image identity")


def approved_deadline(plan):
    value = plan["notAfter"]
    require(matches(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value),
            "Invalid approved maintenance deadline")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def require_current_window(plan):
    require(datetime.now(timezone.utc) <= approved_deadline(plan), "Approved maintenance window has ended")


def changes_backend(plan):
    return plan["priorImage"] != plan["candidateImage"]


def validate_plan(request):
    require(all(key in request for key in PLAN_FIELDS), "Cutover plan is incomplete")
    approved_deadline(request)
    for key in ("planSha256", "sourceHostId", "candidateUnitSha256", "settingsSha256"):
        require(matches(HASH, request[key]), f"Invalid cutover plan field {key}")
    require(matches(r"sha256:" + HASH, request["ownerBindingSha256"]), "Invalid cutover owner binding")
    require(matches(IMMUTABLE_IMAGE, request["candidateImage"]), "Invalid candidate immutable Full image")
    backend_identity(request["candidateIdentity"])
    candidate = Path(request["candidateUnit"])
    if changes_backend(request):
        require(candidate.is_absolute() and candidate.parent == STATE and candidate.name.startswith("candidate-") and
                candidate.suffix == ".container", "The candidate Quadlet must be staged in the private deployment state")
    else:
        require(candidate == ACTIVE_UNIT and request["candidateIdentity"] == request["priorIdentity"] and
                request["candidateUnitSha256"] == request["priorUnitSha256"], "Retained API identity must match the prior release")
    prior = request["priorIdentity"]
    target = request["candidateIdentity"]
    require(request["migration"] is None, "No data conversion is certified")
    if request["priorImage"] is None:
        require(all(request[key] is None for key in ("priorIdentity", "priorUnitSha256", "priorContainerId")),
                "A first activation must have no prior API")
    else:
        require(matches(IMMUTABLE_IMAGE, request["priorImage"]) and matches(HASH, request["priorUnitSha256"]) and
                matches(HASH, request["priorContainerId"]), "Invalid prior immutable Full release")
        backend_identity(prior)
        require(prior["persistenceFormat"] == target["persistenceFormat"] and
                prior["migrationFingerprint"] == target["migrationFingerprint"],
                "No migration is certified for the changed persistence format or PostgreSQL schema ledger")
    return {key: request[key] for key in PLAN_FIELDS}


def validate_host(plan):
    require(plan["sourceHostId"] == host_identity() and plan["databaseSystemIdentifier"] == cluster_identity(),
            "Cutover plan does not match this host or PostgreSQL cluster")
    service_origin(TUNNEL)


def stage(request):
    require(not present(JOURNAL), "Cutover staging cannot change assets for a pending transaction")
    require(matches(IMMUTABLE_IMAGE, request["candidateImage"]) and
            matches(HASH, request["settingsSha256"]) and
            matches(r"sha256:" + HASH, request["ownerBindingSha256"]), "Invalid candidate staging evidence")
    backend_identity(request["candidateIdentity"])
    validate_host(request)
    validate_activation_links()
    settings_dir = HOME_DIR / ".config/codexia-auth"
    settings_path = settings_dir / f"runtime-{request['settingsSha256']}.env"
    if request["priorImage"] is None:
        require_first_activation(request)
        source = settings_dir / "runtime.env"
    else:
        current = active_api(request["priorImage"], request["priorIdentity"])
        require(current["containerId"] == request["priorContainerId"], "Admitted prior API container changed before staging")
        source, prior_settings = setting_path(ACTIVE_UNIT, request["priorImage"], request["priorUnitSha256"])
        require(prior_settings == request["settingsSha256"], "Staging may not change the installed auth settings")
    contents = regular(source, private=True).read_bytes()
    require(sha256(contents) == request["settingsSha256"], "Staging auth settings differ from the admitted settings")
    require_owner(request, source)
    template = regular(Path(request["stageUnit"]), private=True).read_text()
    unit = template.replace("CODEXIA_BACKEND_IMAGE", request["candidateImage"]).replace("CODEXIA_BACKEND_PROFILE", "full")
    unit = unit.replace("/home/codexia/.config/codexia-auth/runtime-", str(settings_dir / "runtime-"))
    unit = unit.replace("AUTH_SETTINGS_DIGEST_PLACEHOLDER", request["settingsSha256"])
    if not any(line.startswith("CODEXIA_OIDC_ISSUER=") for line in contents.decode().splitlines()):
        unit = unit.replace("Secret=codexia-oidc-client-secret,type=env,target=CODEXIA_OIDC_CLIENT_SECRET\n", "")
    _, auth_hash = parse_unit_settings(unit, request["candidateImage"])
    require(auth_hash == request["settingsSha256"], "Staged Quadlet does not reference the admitted settings")
    candidate = STATE / f"candidate-cutover-{request['candidateImage'].split('@sha256:')[1]}.container"
    rendered = unit.encode()
    unit_hash = sha256(rendered)
    validate_plan({**request, "candidateUnit": str(candidate), "candidateUnitSha256": unit_hash})
    require_current_window(request)
    output((*PODMAN, "pull", request["candidateImage"]), "Could not stage the certified Full image")
    require(image_identity(request["candidateImage"]) == request["candidateIdentity"],
            "Pinned OCI identity differs from the admitted image")
    if request["priorImage"] is None:
        if present(settings_path):
            require(regular(settings_path, private=True).read_bytes() == contents, "Existing auth settings snapshot changed")
        else:
            durable_write(settings_path, contents)
    durable_write(candidate, rendered)
    emit({"candidateUnitSha256": unit_hash})


def image_identity(image):
    digests = json_output((*PODMAN, "image", "inspect", "--format", "{{json .RepoDigests}}", image),
                          "Pinned OCI image is unavailable", list)
    require(image in digests, "Local OCI image does not retain its pinned digest")
    return json_output((*PODMAN, "run", "--rm", "--pull=never", "--network=none", "--read-only",
                        "--cap-drop=all", "--security-opt=no-new-privileges", "--entrypoint=/bin/cat",
                        image, "/app/update-identity.json"), "Could not read the pinned OCI image identity", dict)


def setting_path(unit, expected_image, expected_sha):
    contents = regular(unit).read_bytes()
    require(sha256(contents) == expected_sha, "The admitted API Quadlet changed")
    auth_file, settings_hash = parse_unit_settings(contents.decode(), expected_image)
    require(sha256(regular(auth_file, private=True).read_bytes()) == settings_hash,
            "The retained auth settings no longer match the API Quadlet")
    return auth_file, settings_hash


def parse_unit_settings(contents, expected_image):
    lines = contents.splitlines()
    for key, expected in (("Image=", expected_image),
                          ("Environment=CODEXIA_AUTH_MODE=", "better-auth"),
                          ("Environment=CODEXIA_DATABASE_MIGRATE_ON_START=", "0")):
        require([line[len(key):] for line in lines if line.startswith(key)] == [expected],
                "API Quadlet has an unexpected immutable image or runtime policy")
    setting_hashes = [line.partition("SHA256=")[2] for line in lines
                      if line.startswith("Environment=CODEXIA_AUTH_SETTINGS_SHA256=")]
    require(len(setting_hashes) == 1 and matches(HASH, setting_hashes[0]), "API Quadlet has no pinned auth settings")
    auth_file = HOME_DIR / ".config/codexia-auth" / f"runtime-{setting_hashes[0]}.env"
    require([line for line in lines if line.startswith("EnvironmentFile=")] == [f"EnvironmentFile={auth_file}"],
            "The retained auth settings no longer match the API Quadlet")
    return auth_file, setting_hashes[0]


def require_owner(plan, auth_file):
    subjects = [line.partition("=")[2] for line in regular(auth_file, private=True).read_text().splitlines()
                if line.startswith("CODEXIA_OAUTH_OWNER_SUBJECT=")]
    require(len(subjects) == 1 and "sha256:" + sha256(subjects[0].encode()) == plan["ownerBindingSha256"],
            "Better Auth settings no longer identify the admitted owner")
    owner = plan["ownerBindingSha256"].removeprefix("sha256:")
    require(postgres_read(f'''SELECT EXISTS (SELECT FROM codexia_auth."user"
          WHERE encode(sha256(convert_to(id::text, 'UTF8')), 'hex') = '{owner}')''') == "t",
            "The admitted Better Auth owner is missing from the database")


def require_first_activation(plan):
    clean = HOME_DIR / ".local/bin/codexia-require-clean-api-target"
    require(os.access(regular(clean), os.X_OK), "Canonical clean API slot verifier is unavailable")
    output((str(clean),), "First activation requires a verified clean API slot")
    marker = regular(STATE / "owner-setup.installation", private=True)
    regular(STATE / "owner-setup.promoted", private=True)
    require(marker.read_text().strip() == plan["databaseSystemIdentifier"],
            "Owner setup was not prepared for the approved database cluster")


def validate_activation_links(install=False):
    for link, service_name in ((API_WANTS, API), (TUNNEL_WANTS, TUNNEL)):
        target = f"../{service_name}.service"
        if present(link):
            require(link.is_symlink() and os.readlink(link) == target, "Unexpected systemd activation link")
        elif install:
            link.parent.mkdir(mode=0o755, exist_ok=True)
            link.symlink_to(target)
            fsync_dir(link.parent)
            fsync_dir(QUADLETS)


def require_release(path, image, identity, auth_hash):
    record = data(path, private=True)
    require(record.get("format") == "codexia-push-deployment/v1" and record.get("image") == image and
            record.get("identity") == identity and record.get("authMode") == "better-auth" and
            record.get("authSettingsSha256") == auth_hash, "The prior release record or auth settings changed")


def guard_path(name):
    return SYSTEMD / f"{name}.service.d/95-codexia-cutover.conf"


def guard_installed(name):
    path = guard_path(name)
    return present(path) and regular(path, private=True).read_bytes() == BLOCK_DROPIN


def save_guard(name):
    path = guard_path(name)
    if not present(path):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        durable_write(path, BLOCK_DROPIN)
        # Persist the directory entry even when the drop-in directory is new.
        for parent in (path.parent.parent, SYSTEMD.parent, SYSTEMD.parent.parent):
            fsync_dir(parent)
    require(guard_installed(name), "The persistent cutover service guard has unexpected content")


def change_guard(name, enabled):
    path = guard_path(name)
    if enabled:
        save_guard(name)
    elif present(path):
        require(guard_installed(name), "The persistent cutover service guard has unexpected content")
        path.unlink()
        fsync_dir(path.parent)
    output((*SYSTEMCTL, "daemon-reload"), "Could not reload persistent cutover service guards")
    guarded = str(path) in property_of(name, "DropInPaths").split()
    require(guarded == enabled, "systemd did not load the intended cutover service guard")


def require_inactive(name):
    require(property_of(name, "ActiveState") in ("inactive", "failed") and not running(name),
            f"Canonical {name} did not remain stopped")


def history_containers():
    return output((*PODMAN, "ps", "--filter", "volume=codexia-history", "--format", "{{.Names}}"),
                  "Could not enumerate containers attached to the manuscript history volume").splitlines()


def close_service(name):
    if name == API and not present(ACTIVE_UNIT):
        require_inactive(API)
        return
    try:
        change_guard(name, True)
    finally:
        # A failed persistent guard still calls for stopping the live process.
        service("stop", name)
        require_inactive(name)


def stop_interrupted_maintenance():
    if running(MAINTENANCE):
        output((*PODMAN, "stop", MAINTENANCE), "Could not stop interrupted cutover maintenance")
    require(not running(MAINTENANCE), "Interrupted maintenance can still write to the deployment")


def quiesce():
    try:
        close_service(TUNNEL)
    finally:
        try:
            close_service(API)
        finally:
            stop_interrupted_maintenance()
    require(not history_containers(), "The manuscript history volume still has a running container")
    require(postgres_read("""
        SELECT NOT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database()
          AND usename IN ('codexia', 'codexia_auth_runtime') AND backend_type = 'client backend')
    """) == "t", "Application or auth PostgreSQL sessions remain after the writer stopped")


def best_effort_quiesce():
    try:
        quiesce()
    except (CutoverError, OSError):
        print("Cutover service shutdown needs operator verification", file=sys.stderr)


def active_api(expected_image=None, expected_identity=None):
    service_origin(API)
    require(property_of(API, "ActiveState") == "active" and running(API) and
            inspect(API, "State.Health.Status") == "healthy", "API is not running and healthy")
    image = inspect(API, "ImageName")
    require(matches(IMMUTABLE_IMAGE, image) and (expected_image is None or image == expected_image),
            "Running API image does not match the admitted immutable digest")
    require(history_containers() == [API], "The deployment does not have exactly one canonical history writer")
    require_mount(API, "codexia-data", "/data")
    require_mount(API, "codexia-history", "/history")
    identity = json_output((*PODMAN, "exec", API, "cat", "/app/update-identity.json"),
                           "Could not read the running API image identity", dict)
    require(expected_identity is None or identity == expected_identity, "The running API identity changed")
    version = json_output((*PODMAN, "exec", API, "node", "-e", '''
        Promise.all(["/health/ready", "/api/version"].map(async path => {
          const response = await fetch("http://127.0.0.1:3000" + path, {signal: AbortSignal.timeout(5000)});
          if (!response.ok) throw Error("API probe failed");
          return await response.json();
        })).then(([ready, version]) => {
          if (ready.ok !== true || ready.persistenceReady !== true) process.exit(1);
          console.log(JSON.stringify({apiEpoch: version.apiEpoch, profile: version.profile, version: version.version}));
        }).catch(() => process.exit(1));
    '''), "Could not verify local API readiness and version", dict)
    require(all(version.get(key) == identity.get(key) for key in ("apiEpoch", "profile", "version")),
            "Live API version disagrees with the running image")
    actual_image = inspect(API, "Image")
    digests = json_output((*PODMAN, "image", "inspect", "--format", "{{json .RepoDigests}}", actual_image),
                          "Could not prove the running OCI image digest", list)
    require(image in digests, "Running API's actual OCI image lacks the pinned digest")
    return {"image": image, "identity": identity, "apiVersion": version, "containerId": inspect(API, "Id")}


def backup_command(*args):
    executable = Path(os.environ["CODEXIA_BACKUP_PROGRAM"])
    require(executable.is_absolute() and os.access(regular(executable), os.X_OK), "Canonical backup program is unavailable")
    return output((str(executable), *args), "Canonical encrypted backup or fingerprint validation failed")


def fingerprint():
    hashes = json.loads(backup_command("fingerprint-locked", "--approved", "--lock-file", str(LOCK), "--lock-fd", "9"))
    require(all(matches(HASH, hashes.get(key)) for key in BACKUP_FIELDS[1:]), "Invalid canonical logical fingerprints")
    return hashes


def checkpoint_status(journal):
    return {**phase_status(journal), **{key: journal[key] for key in (*BACKUP_FIELDS, "backupDirectory")}}


def verify_backup(journal):
    require(backup_command("validate-artifact", journal["backupDirectory"]) == journal["checksumManifestSha256"],
            "The checkpoint backup changed or is unavailable")


def verified_fingerprints(journal):
    current = fingerprint()
    require(all(current[key] == journal[key] for key in BACKUP_FIELDS[1:]),
            "Live database or history fingerprints disagree with the retained pre-change backup")


def auth_cli(image, auth_file):
    args = [
        "--network=codexia-data",
        "--secret=codexia-auth-database-url,type=env,target=CODEXIA_AUTH_DATABASE_URL",
        "--secret=codexia-auth-secret,type=env,target=CODEXIA_AUTH_SECRET",
        "--secret=codexia-oauth-introspection-client-secret,type=env,target=CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET",
    ]
    if any(line.startswith("CODEXIA_OIDC_ISSUER=") for line in auth_file.read_text().splitlines()):
        args.append("--secret=codexia-oidc-client-secret,type=env,target=CODEXIA_OIDC_CLIENT_SECRET")
    output((*maintenance_container(), *args, "--env-file", str(auth_file), "--entrypoint=node", image,
            f"{API_DIST}/verify-auth-clients.js"), "Better Auth owner, schema, or registered clients did not verify")


def maintenance_container():
    return (*PODMAN, "run", "--rm", "--name", MAINTENANCE, "--pull=never", "--read-only", "--cap-drop=all",
            "--security-opt=no-new-privileges")


def verify_database_ledger(image):
    # Do not publish the connection URL or put it in Podman arguments. The
    # normal app secret is mounted in the isolated client and consumed there.
    args = (*maintenance_container(), "--network=codexia-data",
            "--secret=codexia-postgres-app-password,type=mount,target=/run/secrets/app-password",
            "--entrypoint=/bin/sh", image, "-ec", '''
        password="$(cat /run/secrets/app-password)"
        case "$password" in *[!0-9a-fA-F]*) exit 1;; esac
        [ "${#password}" -eq 64 ]
        export CODEXIA_DATABASE_URL="postgres://codexia:$password@codexia-db:5432/codexia?options=-c%20default_transaction_read_only%3Don"
        exec node "$@"
    ''', "codexia-maintenance")
    return output((*args, "--input-type=module", "-e", '''
            import {verifyPostgresSchema} from "@codexia/persistence-postgres";
            console.log(await verifyPostgresSchema(process.env.CODEXIA_DATABASE_URL));
        '''), "The retained PostgreSQL migration ledger failed verification")


def wait_for_healthy_api():
    # Prior releases may use a Quadlet that predates Notify=healthy.
    deadline = monotonic() + 120
    while monotonic() < deadline:
        if running(API):
            health = inspect(API, "State.Health.Status")
            if health == "healthy":
                return
            require(health == "starting", "The activated API did not pass its container health check")
        require(property_of(API, "ActiveState") in ("activating", "active"), "The activated API service stopped")
        sleep(2)
    raise CutoverError("The activated API did not become healthy before its startup deadline")


def activate(unit, image, identity):
    save_guard(API)
    durable_write(ACTIVE_UNIT, regular(unit).read_bytes(), mode=0o644)
    change_guard(API, False)
    service("reset-failed", API)
    service("start", API)
    wait_for_healthy_api()
    active_api(image, identity)


def transition(journal, phase, **fields):
    if journal.get("phase") != phase:
        journal["phaseChangedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if phase == "recovering" and "recoveryStartedAt" not in journal:
        journal["recoveryStartedAt"] = journal["phaseChangedAt"]
    journal.update(phase=phase, **fields)
    save(JOURNAL, journal)


def phase_status(journal):
    return {"status": journal["phase"], "phaseChangedAt": journal["phaseChangedAt"],
            **{key: journal[key] for key in ("tunnelOpenedAt",) if key in journal}}


def validate_admission(plan, reactivation=False):
    if reactivation:
        require(plan["priorImage"] is None and guard_installed(TUNNEL) and
                (not present(guard_path(API)) or guard_installed(API)),
                "Reactivation requires the guarded first activation slot")
        require_inactive(API)
        require_inactive(TUNNEL)
    else:
        for name in (API, TUNNEL):
            require(not present(guard_path(name)), "Unexpected persistent cutover service guard")
    validate_activation_links()
    candidate = Path(plan["candidateUnit"])
    candidate_settings, candidate_auth_hash = setting_path(candidate, plan["candidateImage"], plan["candidateUnitSha256"])
    require(candidate_auth_hash == plan["settingsSha256"], "Cutover candidate must retain the admitted auth settings")
    require_owner(plan, candidate_settings)
    require(image_identity(plan["candidateImage"]) == plan["candidateIdentity"], "Pinned candidate OCI identity changed")
    if plan["priorImage"] is None:
        require_first_activation(plan)
        require(sha256(regular(HOME_DIR / ".config/codexia-auth/runtime.env", private=True).read_bytes()) == candidate_auth_hash,
                "Prepared owner handoff settings changed")
        require_inactive(TUNNEL)
        read_only_database_check(plan["candidateImage"], plan["candidateIdentity"], candidate_settings)
    else:
        live = active_api(plan["priorImage"], plan["priorIdentity"])
        require(live["containerId"] == plan["priorContainerId"], "The admitted prior API container changed")
        require(property_of(TUNNEL, "ActiveState") == "active" and running(TUNNEL), "Prior Tunnel is not running")
        prior_settings, prior_auth_hash = setting_path(ACTIVE_UNIT, plan["priorImage"], plan["priorUnitSha256"])
        require_release(RELEASE, plan["priorImage"], plan["priorIdentity"], prior_auth_hash)
        require(candidate_auth_hash == prior_auth_hash, "The cutover must retain the installed auth settings")
        read_only_database_check(plan["priorImage"], plan["priorIdentity"], prior_settings)
    if changes_backend(plan):
        backup_command("validate-destination", os.environ["CODEXIA_BACKUP_DESTINATION"])
    require_current_window(plan)


def admit(plan, journal):
    require_current_window(plan)
    if journal is not None:
        require(journal["phase"] in ("intent", "quiescing", "checkpointed"), "Cutover already passed admission")
        if journal["phase"] == "intent":
            validate_admission(plan)
        return journal
    if present(TERMINAL):
        require(data(TERMINAL, private=True)["planSha256"] != plan["planSha256"], "Cutover plan already completed")
    validate_admission(plan)
    if plan["priorImage"] is not None and changes_backend(plan):
        durable_write(PRIOR_UNIT, ACTIVE_UNIT.read_bytes())
        durable_write(PRIOR_RELEASE, RELEASE.read_bytes())
    journal = {"format": "codexia-cutover-host/v1", "plan": plan, "requiresRestore": False}
    transition(journal, "intent")
    return journal


def read_only_database_check(image, identity, settings):
    require(verify_database_ledger(image) == identity["migrationFingerprint"],
            "Live PostgreSQL ledger does not match the exact release identity")
    auth_cli(image, settings)


def require_retained_pair(plan):
    live = active_api(plan["priorImage"], plan["priorIdentity"])
    require(live["containerId"] == plan["priorContainerId"], "Retained API container changed during cutover")
    settings, settings_sha = setting_path(ACTIVE_UNIT, plan["priorImage"], plan["priorUnitSha256"])
    require(settings_sha == plan["settingsSha256"], "Retained API auth settings changed during cutover")
    require_release(RELEASE, plan["priorImage"], plan["priorIdentity"], settings_sha)
    require_owner(plan, settings)
    read_only_database_check(plan["priorImage"], plan["priorIdentity"], settings)
    require(property_of(TUNNEL, "ActiveState") == "active" and running(TUNNEL), "Retained Tunnel is not running")


def checkpoint(plan, journal, request):
    restarting = journal is not None and journal["phase"] == "safe-stopped"
    if restarting:
        validate_admission(plan, reactivation=True)
        if "backupDirectory" in journal:
            verify_backup(journal)
    else:
        journal = admit(plan, journal)
    if not changes_backend(plan):
        require_retained_pair(plan)
        renewal = request.get("reactivationWindow")
        if renewal is not None and renewal != journal.get("reactivationWindow"):
            require(journal["phase"] == "checkpointed" and
                    type(journal.get("retainedCandidateWorker")) is bool and not journal["requiresRestore"],
                    "Only a recovered Frontend checkpoint can renew its window")
            require_current_window(plan)
            transition(journal, "checkpointed", reactivationWindow=renewal,
                       reactivationStartedAt=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        else:
            transition(journal, "checkpointed")
        emit(phase_status(journal))
        return
    try:
        if journal["phase"] == "intent":
            transition(journal, "quiescing")
        quiesce()
        if journal["phase"] == "quiescing" or restarting:
            destination = Path(os.environ["CODEXIA_BACKUP_DESTINATION"])
            report = backup_command("backup-locked", str(destination), os.environ["CODEXIA_BACKUP_RECIPIENT"],
                                    "--approved", "--lock-file", str(LOCK), "--lock-fd", "9")
            lines = report.splitlines()
            require(len(lines) == 2 and lines[0].startswith("Encrypted backup committed: ") and
                    lines[1].startswith("Published checksum manifest sha256: "), "Backup output did not identify a checkpoint")
            artifact = Path(lines[0].removeprefix("Encrypted backup committed: "))
            manifest = lines[1].removeprefix("Published checksum manifest sha256: ")
            require(artifact.parent == destination and artifact.name.startswith("codexia-") and matches(HASH, manifest),
                    "Canonical backup did not publish an immutable checkpoint")
            result = {"backupDirectory": str(artifact), "checksumManifestSha256": manifest, **fingerprint()}
            verify_backup(result)
            if restarting:
                require_current_window(plan)
                journal.pop("recoveryStartedAt", None)
                journal.pop("recoveryReceiptSha256", None)
                result.update(reactivationWindow=request.get("reactivationWindow"),
                              retainedCandidateWorker=request.get("retainedCandidateWorker") is True,
                              reactivationStartedAt=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                              requiresRestore=False)
            transition(journal, "checkpointed", **result)
        verify_backup(journal)
        verified_fingerprints(journal)
    except (CutoverError, OSError):
        best_effort_quiesce()
        raise
    emit(checkpoint_status(journal))


def match_backup(request, journal):
    require(all(matches(HASH, request.get(key)) and request[key] == journal.get(key) for key in BACKUP_FIELDS),
            "Recovery evidence does not match the exact checkpoint backup")


def apply(request, plan, journal):
    require_current_window(plan)
    if not changes_backend(plan):
        require(journal["phase"] in ("checkpointed", "candidate-ready", "candidate-tunnel"),
                "Retained API is outside the approved checkpoint")
        require_retained_pair(plan)
        if journal["phase"] == "checkpointed":
            transition(journal, "candidate-ready")
        emit(phase_status(journal))
        return
    match_backup(request, journal)
    receipt = request.get("recoveryReceiptSha256")
    require(matches(HASH, receipt), "An independently approved recovery receipt is required")
    if journal["phase"] in ("candidate-ready", "candidate-tunnel"):
        require(journal.get("recoveryReceiptSha256") == receipt, "Independent recovery receipt changed")
        active_api(plan["candidateImage"], plan["candidateIdentity"])
        emit(phase_status(journal))
        return
    require(journal["phase"] == "checkpointed", "Interrupted cutover requires explicit recovery")
    candidate = Path(plan["candidateUnit"])
    image, identity = plan["candidateImage"], plan["candidateIdentity"]
    try:
        quiesce()
        verify_backup(journal)
        verified_fingerprints(journal)
        auth_file, _ = setting_path(candidate, image, plan["candidateUnitSha256"])
        require(image_identity(image) == identity, "Staged OCI identity changed after recovery verification")
        require_owner(plan, auth_file)
        read_only_database_check(image, identity, auth_file)
        # The candidate can change persisted state even if startup fails.
        require_current_window(plan)
        transition(journal, "activating", requiresRestore=True, recoveryReceiptSha256=receipt)
        require_inactive(TUNNEL)
        require_inactive(API)
        validate_host(plan)
        activate(candidate, image, identity)
        require_inactive(TUNNEL)
        transition(journal, "candidate-ready")
    except (CutoverError, OSError):
        best_effort_quiesce()
        raise
    emit(phase_status(journal))


def recover_quiesce(plan, journal):
    require(journal["phase"] in ("intent", "quiescing", "checkpointed", "activating",
                                "candidate-ready", "candidate-tunnel", "prior-ready", "prior-tunnel", "recovering", "safe-stopped"),
            "This checkpoint does not permit rollback after possible publication")
    if journal["phase"] == "safe-stopped":
        require_inactive(TUNNEL)
        require_inactive(API)
        emit(phase_status(journal))
        return
    if journal["phase"] in ("prior-ready", "prior-tunnel"):
        journal.pop("recoveryStartedAt", None)
    transition(journal, "recovering")
    if changes_backend(plan):
        quiesce()
    else:
        require_retained_pair(plan)
    emit({**phase_status(journal), "requiresRestore": journal["requiresRestore"], "recoveryStartedAt": journal["recoveryStartedAt"],
          **{key: journal.get(key) for key in BACKUP_FIELDS}})


def recover(request, plan, journal):
    if request.get("frontendRetry") is True:
        require(plan["priorImage"] is not None and not changes_backend(plan),
                "Frontend retry recovery requires a retained Backend")
        retained_candidate_worker = request.get("retainedCandidateWorker")
        require(type(retained_candidate_worker) is bool,
                "Frontend retry requires an observed Worker state")
        require(journal["phase"] in ("intent", "checkpointed", "candidate-ready",
                                     "candidate-tunnel", "recovering", "prior-ready"),
                "This checkpoint does not permit a frontend retry")
        require(not journal["requiresRestore"], "Frontend retry cannot skip a required restoration")
        if "retainedCandidateWorker" in journal:
            require(journal["retainedCandidateWorker"] is not True or retained_candidate_worker is True,
                    "A retained candidate Worker cannot be discarded during frontend retry")
            require(journal["phase"] == "candidate-tunnel" or
                    journal["retainedCandidateWorker"] is retained_candidate_worker,
                    "Retained Worker state changed during frontend retry")
        require_retained_pair(plan)
        journal.pop("recoveryStartedAt", None)
        journal.pop("recoveryReceiptSha256", None)
        journal.pop("restoreReceiptSha256", None)
        journal.pop("tunnelOpenedAt", None)
        transition(journal, "checkpointed", requiresRestore=False,
                   retainedCandidateWorker=retained_candidate_worker)
        emit({**phase_status(journal), "nextOperation": "advance"})
        return
    if plan["priorImage"] is None:
        require(journal["phase"] in ("recovering", "safe-stopped"), "Quiesce the first activation before safe stop")
        quiesce()
        require(not present(RELEASE) and not present(API_WANTS), "First activation acquired unexpected installed state")
        if present(ACTIVE_UNIT):
            setting_path(ACTIVE_UNIT, plan["candidateImage"], plan["candidateUnitSha256"])
        if container_exists(API):
            container_id = inspect(API, "Id")
            require(journal["requiresRestore"] and matches(HASH, container_id) and
                    inspect(container_id, "State.Running") == "false" and
                    inspect(container_id, "ImageName") == plan["candidateImage"],
                    "Stopped API container does not match the admitted first activation")
            require_mount(container_id, "codexia-data", "/data")
            require_mount(container_id, "codexia-history", "/history")
            output((*PODMAN, "rm", "--", container_id), "Could not remove the stopped candidate container")
        require(not container_exists(API), "First activation did not leave a clean API slot")
        if present(ACTIVE_UNIT):
            ACTIVE_UNIT.unlink()
            fsync_dir(QUADLETS)
            output((*SYSTEMCTL, "daemon-reload"), "Could not reload the clean API slot")
        # With the unit and container absent, leave a clean API slot and keep
        # the Tunnel guard installed for the next protected activation.
        if present(guard_path(API)):
            change_guard(API, False)
        if "backupDirectory" in journal:
            verify_backup(journal)
        transition(journal, "safe-stopped")
        emit(phase_status(journal))
        return
    if not changes_backend(plan):
        require(journal["phase"] in ("recovering", "prior-ready", "prior-tunnel"), "Quiesce the deployment for recovery first")
        require_retained_pair(plan)
        if journal["phase"] == "recovering":
            transition(journal, "prior-ready")
        emit(phase_status(journal))
        return
    if journal["phase"] in ("prior-ready", "prior-tunnel"):
        if journal["requiresRestore"]:
            match_backup(request, journal)
            require(request.get("restoreReceiptSha256") == journal.get("restoreReceiptSha256"),
                    "Protected restore receipt changed")
        active_api(plan["priorImage"], plan["priorIdentity"])
        emit(phase_status(journal))
        return
    require(journal["phase"] == "recovering", "Quiesce the deployment for recovery first")
    restore_receipt = request.get("restoreReceiptSha256")
    if journal["requiresRestore"]:
        match_backup(request, journal)
        require(matches(HASH, restore_receipt), "Protected restore receipt is required after possible mutation")
    try:
        quiesce()
        if "backupDirectory" in journal:
            verify_backup(journal)
            verified_fingerprints(journal)
        image, identity = plan["priorImage"], plan["priorIdentity"]
        auth_file, auth_hash = setting_path(PRIOR_UNIT, image, plan["priorUnitSha256"])
        require_owner(plan, auth_file)
        require_release(PRIOR_RELEASE, image, identity, auth_hash)
        require(image_identity(image) == identity, "Retained prior OCI identity changed")
        require(verify_database_ledger(image) == identity["migrationFingerprint"],
                "Restored PostgreSQL migration ledger does not match the prior release")
        auth_cli(image, auth_file)
        activate(PRIOR_UNIT, image, identity)
        require_inactive(TUNNEL)
        transition(journal, "prior-ready", restoreReceiptSha256=restore_receipt)
    except (CutoverError, OSError):
        best_effort_quiesce()
        raise
    emit(phase_status(journal))


def check_outcome(plan, journal, outcome, phases):
    require(outcome in ("candidate", "prior"), "Cutover requires an explicit candidate or prior outcome")
    require(journal["phase"] in [f"{outcome}-{phase}" for phase in phases],
            "The durable host phase does not match the requested outcome")
    active_api(plan[f"{outcome}Image"], plan[f"{outcome}Identity"])
    settings, settings_sha = setting_path(ACTIVE_UNIT, plan[f"{outcome}Image"], plan[f"{outcome}UnitSha256"])
    require(settings_sha == plan["settingsSha256"], "Running API settings differ from the approved settings")
    require_owner(plan, settings)
    read_only_database_check(plan[f"{outcome}Image"], plan[f"{outcome}Identity"], settings)


def open_tunnel(plan, journal, outcome):
    if outcome == "candidate":
        require_current_window(plan)
    check_outcome(plan, journal, outcome, ("ready", "tunnel"))
    if "backupDirectory" in journal:
        verify_backup(journal)
    if not changes_backend(plan):
        require_retained_pair(plan)
        if journal["phase"] != f"{outcome}-tunnel":
            transition(journal, f"{outcome}-tunnel")
        emit(phase_status(journal))
        return
    if journal["phase"] == f"{outcome}-tunnel":
        if property_of(TUNNEL, "ActiveState") == "active" and running(TUNNEL) and not present(guard_path(TUNNEL)):
            emit(phase_status(journal))
            return
        transition(journal, f"{outcome}-ready")
    try:
        change_guard(TUNNEL, False)
        service("reset-failed", TUNNEL)
        service("start", TUNNEL)
        require(property_of(TUNNEL, "ActiveState") == "active" and running(TUNNEL), "Tunnel is not running behind the external fence")
        transition(journal, f"{outcome}-tunnel")
    except (CutoverError, OSError):
        close_service(TUNNEL)
        raise
    emit(phase_status(journal))


def verify_ready_for_publication(plan, journal, outcome, phases):
    check_outcome(plan, journal, outcome, phases)
    if "backupDirectory" in journal:
        verify_backup(journal)
    require(property_of(TUNNEL, "ActiveState") == "active" and running(TUNNEL) and
            not present(guard_path(API)) and not present(guard_path(TUNNEL)), "The accepted host components are not both online")
    validate_activation_links()


def publishing(plan, journal, outcome):
    if outcome == "candidate":
        require_current_window(plan)
    verify_ready_for_publication(plan, journal, outcome, ("tunnel", "publishing"))
    if journal["phase"] != f"{outcome}-publishing":
        # The next controller step may reopen traffic, even if it disconnects
        # before receiving confirmation from the edge. A prior backup can no
        # longer account for every possible write after this durable barrier.
        transition(journal, f"{outcome}-publishing", tunnelOpenedAt=journal["phaseChangedAt"])
    emit(phase_status(journal))


def finish(plan, journal, outcome):
    verify_ready_for_publication(plan, journal, outcome, ("publishing",))
    image, identity = plan[f"{outcome}Image"], plan[f"{outcome}Identity"]
    _, auth_hash = setting_path(ACTIVE_UNIT, image, plan[f"{outcome}UnitSha256"])
    if not changes_backend(plan):
        require_retained_pair(plan)
    elif outcome == "prior":
        require_release(PRIOR_RELEASE, image, identity, auth_hash)
        durable_write(RELEASE, PRIOR_RELEASE.read_bytes())
    else:
        if plan["priorImage"] is None:
            validate_activation_links(install=True)
            output((*SYSTEMCTL, "daemon-reload"), "Could not reload installed activation links")
        save(RELEASE, {"format": "codexia-push-deployment/v1", "image": image, "previousImage": plan["priorImage"] or "",
                       "identity": identity, "authMode": "better-auth", "authSettingsSha256": auth_hash})
    result = {"status": "finished", "outcome": outcome, "planSha256": plan["planSha256"]}
    save(TERMINAL, {**result, "plan": journal["plan"], "phaseChangedAt": journal["phaseChangedAt"],
                    "reactivationWindow": journal.get("reactivationWindow"),
                    "tunnelOpenedAt": journal["tunnelOpenedAt"]})
    JOURNAL.unlink()
    fsync_dir(STATE)
    emit(result)


def observe(journal):
    result = {"status": "observed", "sourceHostId": host_identity(), "databaseSystemIdentifier": cluster_identity(),
              "phase": journal["phase"] if journal else None}
    service_origin(TUNNEL)
    result["tunnelRunning"] = running(TUNNEL)
    result["apiRunning"] = running(API)
    if result["apiRunning"]:
        try:
            live = active_api()
            result.update(priorContainerId=live["containerId"], priorImage=live["image"], priorIdentity=live["identity"],
                          priorUnitSha256=sha256(regular(ACTIVE_UNIT).read_bytes()), apiVersion=live["apiVersion"])
        except (CutoverError, OSError):
            require(journal is not None, "An unverified API cannot be used as the cutover baseline")
            result["apiVerified"] = False
    if journal is not None:
        result["planSha256"] = journal["plan"]["planSha256"]
        result.update({key: journal[key] for key in (*BACKUP_FIELDS, "backupDirectory", "requiresRestore", "phaseChangedAt",
                                                    "recoveryStartedAt", "tunnelOpenedAt", "reactivationStartedAt",
                                                    "reactivationWindow", "retainedCandidateWorker")
                       if key in journal})
    elif present(TERMINAL):
        terminal = data(TERMINAL, private=True)
        if result.get("priorImage") == terminal["plan"][f"{terminal['outcome']}Image"]:
            result.update(phase="finished", planSha256=terminal["planSha256"], outcome=terminal["outcome"],
                          phaseChangedAt=terminal["phaseChangedAt"], tunnelOpenedAt=terminal.get("tunnelOpenedAt"),
                          reactivationWindow=terminal.get("reactivationWindow"))
    emit(result)


def main():
    require(QUADLETS.is_absolute() and QUADLETS.is_dir() and not QUADLETS.is_symlink() and
            SYSTEMD.is_absolute(), "Cutover requires canonical absolute Quadlet and systemd paths")
    require(not present(STATE / "deploy-transaction.json"), "An ordinary deployment transaction is still pending")
    require(not present(STATE / "backup-transaction"), "A backup transaction is still pending")
    require(len(sys.argv) in (2, 3), "Usage: cutover-host.sh ACTION [INPUT.json]")
    require(output((*PODMAN, "info", "--format", "{{.Host.Security.Rootless}}"),
                   "Could not determine Podman runtime identity") == "true", "Cutover requires the rootless Podman runtime")
    action = sys.argv[1]
    journal = data(JOURNAL, private=True) if present(JOURNAL) else None
    if journal is not None:
        require(journal.get("format") == "codexia-cutover-host/v1" and isinstance(journal.get("plan"), dict) and
                type(journal.get("requiresRestore")) is bool, "Invalid durable cutover intent")
    if action == "observe" and len(sys.argv) == 2:
        observe(journal)
        return
    require(action in ("stage", "admit", "checkpoint", "apply", "open-tunnel", "recover-quiesce", "recover", "publishing", "finish") and
            len(sys.argv) == 3, "Usage: cutover-host.sh ACTION [INPUT.json]")
    request = data(Path(sys.argv[2]))
    if action == "stage":
        stage(request)
        return
    plan = validate_plan(request)
    validate_host(plan)
    renewal = request.get("reactivationWindow")
    retained_frontend_retry = (not changes_backend(plan) and plan["priorImage"] is not None and
                               journal is not None and type(journal.get("retainedCandidateWorker")) is bool and
                               not journal["requiresRestore"])
    if renewal is not None:
        require(isinstance(renewal, dict) and set(renewal) == {"notAfter", "approval"} and
                matches(HASH, renewal["approval"]) and
                (plan["priorImage"] is None or retained_frontend_retry or
                 (not changes_backend(plan) and action == "finish" and journal is None and present(TERMINAL))),
                "Invalid first activation renewal")
        approved_deadline(renewal)
    if journal is not None:
        require(plan == journal["plan"], "Request does not match the durable cutover plan")
        renewing_retained = (action == "checkpoint" and retained_frontend_retry and
                             journal["phase"] == "checkpointed" and renewal is not None and
                             renewal != journal.get("reactivationWindow"))
        if renewing_retained:
            previous = journal.get("reactivationWindow") or journal["plan"]
            require(approved_deadline(renewal) > approved_deadline(previous),
                    "Renewed Frontend window must extend the durable deadline")
        if action not in ("recover-quiesce", "recover"):
            require((action == "checkpoint" and journal["phase"] == "safe-stopped") or
                    renewing_retained or renewal == journal.get("reactivationWindow"),
                    "Request changed the durable activation window")
    elif action == "finish" and present(TERMINAL):
        terminal = data(TERMINAL, private=True)
        require(terminal["plan"] == plan and terminal["outcome"] == request.get("outcome") and
                renewal == terminal.get("reactivationWindow"),
                "Completed cutover did not match the request")
        active_api(plan[f"{terminal['outcome']}Image"], plan[f"{terminal['outcome']}Identity"])
        emit({key: terminal[key] for key in ("status", "outcome", "planSha256")})
        return
    else:
        require(renewal is None, "An activation window can only be renewed from a durable safe stop")
    if renewal is not None:
        plan = {**plan, "notAfter": renewal["notAfter"]}
    if action == "admit":
        emit(phase_status(admit(plan, journal)))
        return
    if action == "checkpoint":
        checkpoint(plan, journal, request)
        return
    require(journal is not None, "No matching durable cutover intent exists")
    if action == "apply":
        apply(request, plan, journal)
    elif action == "recover-quiesce":
        recover_quiesce(plan, journal)
    elif action == "recover":
        recover(request, plan, journal)
    elif action == "open-tunnel":
        open_tunnel(plan, journal, request.get("outcome"))
    elif action == "publishing":
        publishing(plan, journal, request.get("outcome"))
    else:
        finish(plan, journal, request.get("outcome"))


try:
    main()
except CutoverError as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)
except (OSError, ValueError, KeyError, TypeError):
    print("Cutover host input, command output or state could not be read safely", file=sys.stderr)
    sys.exit(1)
PY
