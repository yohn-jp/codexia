#!/usr/bin/env python3
"""R4 convergence of a verified absent application DB; never delete a database."""
import fcntl
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

def full_image_pattern():
    repository = os.environ.get("CODEXIA_IMAGE_REPOSITORY", "")
    if not re.fullmatch(r"ghcr[.]io/[a-z0-9-]+/codexia-backend", repository):
        raise ValueError("A reviewed image repository is required")
    return re.escape(repository) + r"@sha256:[a-f0-9]{64}"

STATE_FILES = (
    "deployed-release.json", "owner-setup.intent", "owner-setup.installation",
    "owner-setup.promoted", "owner-setup.age", "owner-setup.age.pending",
)
AUTH_FILES = ("runtime.env", "owner-setup.env", "owner-setup.container")
PENDING = ("deploy-transaction.json", "deploy-transaction.json.tmp",
           "cutover-transaction.json", "deployed-release.json.tmp",
           "rollback-api.container", "rollback-release.json")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def command(args, allowed=(0,)):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120, check=False)
    require(result.returncode in allowed, "Could not verify or converge canonical host resources")
    return result.returncode, result.stdout.strip()


def present(path):
    return os.path.lexists(path)


def private_file(path):
    if not present(path):
        return False
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o600, "Unexpected deployment state file")
    return True


def directory(path):
    if present(path):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid(),
                "Unexpected deployment state directory")


def exists(kind, name):
    return command(["podman", kind, "exists", name], (0, 1))[0] == 0


def admin_sql(query, read_only=True):
    options = "-c default_transaction_read_only=on -c statement_timeout=10000" if read_only else "-c statement_timeout=10000"
    return command(["podman", "exec", "codexia-db", "sh", "-ec",
                    'export PGPASSWORD="$(cat /run/secrets/admin-password)"; '
                    'export PGOPTIONS="$1"; exec psql -X -qAt -v ON_ERROR_STOP=1 '
                    '-h 127.0.0.1 -U codexia_admin -d postgres -c "$2"',
                    "sh", options, query])[1]


def verify_absent(expected):
    if expected == "absent":
        require(not exists("container", "codexia-db") and not exists("volume", "codexia-postgres"),
                "The approved absent PostgreSQL resources changed")
        return
    require(re.fullmatch(r"[1-9][0-9]{0,19}", expected), "Invalid approved PostgreSQL cluster")
    require(exists("container", "codexia-db") and exists("volume", "codexia-postgres"),
            "The approved PostgreSQL cluster disappeared")
    observed = admin_sql("""SELECT system_identifier::text || '|' ||
        (NOT EXISTS (SELECT FROM pg_database WHERE datname='codexia'))::text || '|' ||
        (EXISTS (SELECT FROM pg_roles WHERE rolname='codexia_admin' AND rolcanlogin AND rolsuper)
         AND EXISTS (SELECT FROM pg_roles r WHERE rolname='codexia' AND rolcanlogin AND NOT rolsuper
           AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
           AND NOT EXISTS (SELECT FROM pg_auth_members WHERE roleid=r.oid OR member=r.oid)))::text
        FROM pg_control_system()""")
    require(observed == expected + "|true|true", "Database exists or approved cluster/roles changed")


def service_state(name, unit_dir):
    _, raw = command(["systemctl", "--user", "show", "--property=LoadState,ActiveState,SourcePath",
                      name + ".service"], (0, 4))
    properties = dict(line.split("=", 1) for line in raw.splitlines())
    require("LoadState" in properties and "ActiveState" in properties, "Unverified user service")
    if properties["LoadState"] != "not-found" or properties["ActiveState"] != "inactive":
        require(properties.get("SourcePath") == str(unit_dir / (name + ".container")),
                "Service does not originate from the canonical Quadlet")
        return True
    return False


def verify_api_container(unit):
    if not exists("container", "codexia-api"):
        return
    _, image = command(["podman", "inspect", "--format", "{{.ImageName}}", "codexia-api"])
    require(re.fullmatch(full_image_pattern(), image), "Unexpected image in the API slot")
    if present(unit):
        require("Image=" + image in unit.read_text().splitlines(), "API slot image differs from its Quadlet")


def stop_slot(name, unit_dir):
    if service_state(name, unit_dir):
        command(["systemctl", "--user", "stop", name + ".service"])
    if exists("container", name):
        _, running = command(["podman", "inspect", "--format", "{{.State.Running}}", name])
        require(running in ("true", "false"), "Unverified container state")
        if running == "true":
            command(["podman", "stop", name])
        command(["podman", "rm", name])
    require(not exists("container", name), "Container remains after stopping the slot")


def sync_directory(path):
    if present(path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def converge(expected, home):
    state = home / ".local/state/codexia-deploy"
    auth = home / ".config/codexia-auth"
    units = home / ".config/containers/systemd"
    wants = units / "default.target.wants"
    for path in (state, auth, units, wants):
        directory(path)
    lock = state / "host.lock"
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(), "Unexpected host lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        verify_absent(expected)
        require(not any(present(state / name) for name in PENDING),
                "An existing deployment operation must be recovered before bootstrap")
        api = units / "codexia-api.container"
        if private_file(api):
            lines = api.read_text().splitlines()
            require("ContainerName=codexia-api" in lines
                    and any(re.fullmatch("Image=" + full_image_pattern(), line) for line in lines),
                    "Unexpected API Quadlet")
        verify_api_container(api)
        obsolete = [p for p in [*(state / name for name in STATE_FILES),
                                 *(auth / name for name in AUTH_FILES), api] if private_file(p)]
        links = []
        for name in ("codexia-api", "codexia-tunnel"):
            link = wants / (name + ".service")
            if present(link):
                require(link.is_symlink() and os.readlink(link) == "../" + name + ".service",
                        "Unexpected activation link")
                links.append(link)
            service_state(name, units)
        # The rootless account, canonical names and exact generated service
        # sources bound the scope. Never remove any volume, secret or backup.
        stop_slot("codexia-tunnel", units)
        stop_slot("codexia-api", units)
        for path in links + obsolete:
            path.unlink()
        for path in (state, auth, units, wants):
            sync_directory(path)
        command(["systemctl", "--user", "daemon-reload"])
        require(not service_state("codexia-api", units), "API slot is not clean after convergence")
        verify_absent(expected)
        if expected != "absent":
            admin_sql("CREATE DATABASE codexia OWNER codexia", read_only=False)
            require(admin_sql("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='codexia'") == "codexia",
                    "New database owner could not be verified")
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2, "Expected an approved absence identity")
        converge(sys.argv[1], Path(os.environ["HOME"]))
        print("CONVERGED_ABSENT_DATABASE")
    except (OSError, ValueError, subprocess.SubprocessError):
        print("Absent database bootstrap stopped: prerequisites or current host state could not be verified", file=sys.stderr)
        raise SystemExit(1)
