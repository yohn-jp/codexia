#!/usr/bin/env python3
"""Initialize rootless Podman credentials on an admitted fresh target, or adopt intact identities."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit

ADMIN = "codexia-postgres-admin-password"
APP = "codexia-postgres-app-password"
AUTH_URL = "codexia-auth-database-url"
AUTH = "codexia-auth-secret"
INTROSPECTION = "codexia-oauth-introspection-client-secret"
LEGACY_TUNNEL_SECRET = "codexia-tunnel-token"
LEGACY_TUNNEL_CONTAINER = "codexia-tunnel"
NAMES = (ADMIN, APP, AUTH_URL, AUTH, INTROSPECTION)


def require(ok, message):
    if not ok:
        raise ValueError(message)


def podman(*args, data=None, allowed=(0,)):
    result = subprocess.run(["podman", *args], input=data, text=True, capture_output=True, timeout=30)
    require(result.returncode in allowed, "Could not verify rootless Podman state")
    return result


def exists(kind, name):
    return podman(kind, "exists", name, allowed=(0, 1)).returncode == 0


def inspect(name):
    records = json.loads(podman("secret", "inspect", "--showsecret", name).stdout)
    require(len(records) == 1 and records[0]["Spec"]["Name"] == name, "Unexpected Podman secret identity")
    record = records[0]
    require(isinstance(record["ID"], str) and record["ID"], "Missing Podman secret ID")
    # Use the identity representation produced by preflight-observe.py, without exposing the ID.
    return hashlib.sha256(json.dumps(record["ID"]).encode()).hexdigest(), record["SecretData"]


def auth_password(url):
    connection = urlsplit(url)
    require(re.fullmatch(r"[!-~]+", url) and connection.scheme in ("postgres", "postgresql")
            and connection.username == "codexia_auth_runtime" and connection.password
            and connection.hostname == "codexia-db" and connection.port == 5432
            and connection.path == "/codexia" and not connection.query and not connection.fragment,
            "Auth credential does not identify the dedicated runtime role")
    password = unquote(connection.password, errors="strict")
    require(password.isprintable() and password, "Invalid auth role password")
    return password


def validate(values, installing):
    database = [values[name].removesuffix("\n") for name in (ADMIN, APP)]
    require(all(re.fullmatch(r"[A-Fa-f0-9]{64}", value) for value in database),
            "Invalid base database credential")
    role_password = auth_password(values[AUTH_URL])
    require(len(set(database + [role_password])) == 3, "Database credentials must be independent")
    require(re.fullmatch(r"[!-~]{32,}", values[AUTH]) and
            re.fullmatch(r"[!-~]+", values[INTROSPECTION]) and
            len(values[INTROSPECTION]) >= (32 if installing else 16),
            "Invalid Auth or introspection credential")


def value_for(name):
    value = secrets.token_hex(32)
    if name == AUTH_URL:
        return f"postgresql://codexia_auth_runtime:{value}@codexia-db:5432/codexia"
    return value


def require_fresh(home, missing, installing):
    require(installing, "Missing credentials require fresh installation approval")
    state = home / ".local/state/codexia-deploy"
    residues = [state / name for name in ("owner-setup.intent", "owner-setup.installation", "owner-setup.promoted",
                                           "owner-setup.age", "owner-setup.age.pending", "deployed-release.json")]
    residues += [home / ".config/codexia-auth/runtime.env", home / ".config/containers/systemd/codexia-api.container",
                 home / ".config/containers/systemd/default.target.wants/codexia-api.service"]
    require(not any(os.path.lexists(path) for path in residues)
            and not any(exists("volume", name) for name in ("codexia-postgres", "codexia-data", "codexia-history"))
            and not any(exists("container", name) for name in ("codexia-db", "codexia-api")),
            "Data, runtime or installation state with missing credentials requires independent recovery")


def require_legacy_tunnel_retired():
    require(not exists("container", LEGACY_TUNNEL_CONTAINER),
            "The legacy rootless Tunnel container requires owner-approved one-time retirement after pinned management SSH and publication-gate acceptance; no resource was changed")
    require(not exists("secret", LEGACY_TUNNEL_SECRET),
            "The legacy Podman Tunnel credential requires owner-approved one-time retirement after pinned management SSH and publication-gate acceptance; no resource was changed")


def read_identities(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600,
            "Unsafe bootstrap identities file")
    return json.loads(path.read_text())


def record_identities(state, path, identities):
    fd, tmp = tempfile.mkstemp(prefix=".bootstrap-secret-ids-", dir=state)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(identities, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.link(tmp, path)
        directory = os.open(state, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(tmp)


def converge(home, admitted, installing):
    state = home / ".local/state/codexia-deploy"
    info = state.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid(), "Unsafe deployment state directory")
    fd = os.open(state / "host.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(), "Unsafe deployment lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not any(os.path.lexists(state / name) for name in (
            "deploy-transaction.json", "deploy-transaction.json.tmp", "deployed-release.json.tmp",
            "rollback-api.container", "rollback-release.json", "cutover-transaction.json", "backup-transaction")),
            "An existing deployment or backup transaction requires recovery")
        require_legacy_tunnel_retired()
        machine = Path("/etc/machine-id").read_text().strip()
        require(re.fullmatch(r"[a-f0-9]{32}", machine)
                and hashlib.sha256(machine.encode()).hexdigest() == admitted["host"],
                "Admitted host identity changed")
        require(os.getuid() > 0 and podman("info", "--format", "{{.Host.Security.Rootless}}").stdout.strip() == "true",
                "Managed credentials require rootless Podman")
        observed = {name: inspect(name) for name in NAMES if exists("secret", name)}
        ids = {name: pair[0] for name, pair in observed.items()}
        require(ids == {k: v for k, v in admitted["hashes"].items() if k in NAMES},
                "Podman secret identities changed since admission")

        receipt = state / "bootstrap-secret-ids.json"
        recorded = os.path.lexists(receipt)
        if recorded:
            require(set(ids) == set(NAMES) and read_identities(receipt) == ids,
                    "Recorded Podman secret identities require independent recovery")

        missing = [name for name in NAMES if name not in observed]
        if missing:
            require_fresh(home, missing, installing)
        values = {name: pair[1] for name, pair in observed.items()}
        values.update({name: value_for(name) for name in missing})
        validate(values, installing)
        for name in missing:
            podman("secret", "create", name, "-", data=values[name])
            identity, actual = inspect(name)
            require(actual == values[name], "Podman did not retain the generated credential")
            ids[name] = identity
        if not recorded:
            record_identities(state, receipt, ids)
        return not recorded


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["auth-password"]:
            identity, url = inspect(AUTH_URL)
            require(read_identities(Path.home() / ".local/state/codexia-deploy/bootstrap-secret-ids.json")[AUTH_URL]
                    == identity, "Auth database credential changed after bootstrap")
            print(base64.b64encode(auth_password(url).encode()).decode())
        else:
            require(len(sys.argv) == 3 and sys.argv[2] in ("install", "adopt"), "Invalid bootstrap operation")
            changed = converge(Path(os.environ["HOME"]), json.loads(sys.argv[1]),
                               sys.argv[2] == "install")
            print("INITIALIZED" if changed else "VERIFIED")
    except (OSError, ValueError, KeyError, IndexError, TypeError, subprocess.SubprocessError):
        # Do not print parsing/subprocess exceptions; they may include secret input.
        sys.exit("Managed bootstrap stopped; verify the approved target, secret identities, and recovery state")
