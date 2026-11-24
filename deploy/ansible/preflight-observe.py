#!/usr/bin/env python3
"""Supplement the canonical Ansible inspect and cutover observations.

Only existing files, containers, systemd state and read-only SQL are queried.
No Podman storage initialization, image pull, owner operation or backup creation.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
from datetime import datetime, timezone


def require(ok):
    if not ok:
        raise ValueError("Unverified host evidence")


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), sort_keys=True,
                                     ensure_ascii=False).encode()).hexdigest()


def command(args, allowed=(0,), stdin=None):
    result = subprocess.run(args, input=stdin, text=True, capture_output=True,
                            timeout=30, check=False)
    require(result.returncode in allowed)
    return result.returncode, result.stdout.strip()


def metadata(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    require(not stat.S_ISLNK(info.st_mode))
    return info


def private_text(path):
    info = metadata(path)
    require(info is not None and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid())
    require(info.st_size <= 1024 * 1024)
    return path.read_text(encoding="utf-8")


def sql(database, query):
    # SQL is reviewed controller code, never a dispatch input. The existing
    # administrator password stays in the DB container; stdout is not logged.
    require(database in ("postgres", "codexia"))
    return command(["podman", "exec", "-i", "codexia-db", "sh", "-ec",
                    'export PGPASSWORD="$(cat /run/secrets/admin-password)"; '
                    'export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000"; '
                    'exec psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_admin -d "$1"',
                    "sh", database], stdin=query + "\n")[1]


def json_sql(database, query):
    return json.loads(sql(database, query))


def user_exists(name):
    try:
        pwd.getpwnam(name)
        return True
    except KeyError:
        return False


def observe_transaction(state_dir):
    journals = []
    for name, expected, phases in (
        ("deploy-transaction.json", "codexia-deploy-transaction/v1", ("pending", "committed")),
        ("cutover-transaction.json", "codexia-cutover-host/v1",
         ("intent", "checkpointed", "converting", "candidate-ready", "candidate-tunnel",
          "recovering", "prior-ready", "prior-tunnel")),
    ):
        path = state_dir / name
        if metadata(path) is None:
            continue
        data = json.loads(private_text(path))
        require(data.get("format") == expected and data.get("phase") in phases)
        if expected == "codexia-cutover-host/v1":
            require(isinstance(data.get("plan"), dict)
                    and re.fullmatch(r"[a-f0-9]{64}", data["plan"].get("planSha256", ""))
                    and type(data.get("requiresRestore")) is bool)
        else:
            require(all(type(data.get(k)) is bool for k in
                        ("hadUnit", "tunnelWasActive", "apiLinkCreated", "tunnelLinkCreated", "releasePresent")))
        journals.append({"format": expected, "phase": data["phase"], "sha256": digest(data)})
    require(len(journals) <= 1)
    # An orphan temporary journal or rollback snapshot is not proof of a clean slot.
    if not journals:
        for name in ("deploy-transaction.json.tmp", "deployed-release.json.tmp",
                     "rollback-api.container", "rollback-release.json"):
            require(metadata(state_dir / name) is None)
    return journals[0] if journals else None


def observe_database(volumes, containers, state_dir, auth_dir, writer, auth_query, volume_layout):
    if not volumes["codexia-postgres"]:
        require(not containers["codexia-db"])
        return {"state": "absent", "authState": "absent"}
    if not containers["codexia-db"]:
        return {"state": "pristine", "authState": "absent"} if volume_layout == "empty" else {"state": "unknown", "authState": "unknown"}
    if command(["podman", "inspect", "--format", "{{.State.Running}}", "codexia-db"])[1] != "true":
        return {"state": "unknown", "authState": "unknown"}
    cluster = json_sql("postgres", """SELECT json_build_object(
        'clusterId', (SELECT system_identifier::text FROM pg_control_system()),
        'appExists', EXISTS (SELECT FROM pg_database WHERE datname='codexia'),
        'rolesValid', EXISTS (SELECT FROM pg_roles WHERE rolname='codexia_admin' AND rolcanlogin AND rolsuper)
          AND EXISTS (SELECT FROM pg_roles r WHERE rolname='codexia' AND rolcanlogin AND NOT rolsuper
            AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
            AND NOT EXISTS (SELECT FROM pg_auth_members WHERE roleid=r.oid OR member=r.oid)
            AND EXISTS (SELECT FROM pg_database WHERE datname='codexia' AND datdba=r.oid))) ;""")
    require(re.fullmatch(r"[1-9][0-9]{0,19}", cluster["clusterId"]))
    if not cluster["appExists"]:
        return {"state": "missing", "authState": "unknown", "clusterId": cluster["clusterId"]}
    require(cluster["rolesValid"] and volume_layout == "ready")
    db = json_sql("codexia", """SELECT json_build_object(
        'ledgerExists', to_regclass('public.codexia_schema_migrations') IS NOT NULL,
        'authExists', EXISTS (SELECT FROM pg_namespace WHERE nspname='codexia_auth'),
        'appRelations', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','v','m','f','S'))) ;""")
    if not db["ledgerExists"]:
        require(not db["authExists"] and db["appRelations"] == 0)
        return {"state": "pristine", "authState": "absent", "clusterId": cluster["clusterId"]}
    ledger = json_sql("codexia", """SELECT coalesce(json_agg(json_build_object(
        'version', version, 'checksum', btrim(checksum))), '[]'::json)
        FROM public.codexia_schema_migrations;""")
    require(isinstance(ledger, list) and len(ledger) > 0 and len(ledger) <= 1000)
    result = {"state": "initialized", "clusterId": cluster["clusterId"], "ledger": ledger,
              "authState": "unknown", "authSchemaSha256": None, "ownerBindingSha256": None}
    if not db["authExists"]:
        result["authState"] = "legacy" if writer and writer.get("authMode") == "legacy" else "absent"
        return result
    # Use the owning auth-schema catalog query supplied by the checked-out source.
    # Hash its ordered text definitions locally; never emit them.
    definitions = sql("codexia", "BEGIN READ ONLY; SET LOCAL search_path TO codexia_auth; " + auth_query + "; COMMIT;").splitlines()
    result["authSchemaSha256"] = "sha256:" + hashlib.sha256(
        json.dumps(definitions, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if writer and writer.get("authMode") == "better-auth":
        result["ownerBindingSha256"] = writer["ownerBindingSha256"]
        # Reuse the existing read-only Better Auth schema/client verifier in the
        # already running API container. Never start a setup or candidate image.
        status, _ = command(["podman", "exec", writer["containerId"], "node",
                             "/app/node_modules/@codexia/api/dist/verify-auth-clients.js"], (0, 1))
        result["authState"] = "ready" if status == 0 else "unknown"
        return result
    marker = state_dir / "owner-setup.installation"
    if metadata(marker) is None:
        return result  # Existing schema alone is not a fresh-install authorization.
    require(private_text(marker).strip() == cluster["clusterId"])
    if sql("codexia", "SELECT to_regclass('codexia_auth.owner_setup') IS NOT NULL;") != "t":
        return result
    owner = json_sql("codexia", """SELECT json_build_object(
        'grant', grant_id IS NOT NULL AND expires_at > now() AND revoked_at IS NULL,
        'consumed', consumed_at IS NOT NULL,
        'ownerCount', (SELECT count(*) FROM codexia_auth."user"),
        'ownerBinding', CASE WHEN EXISTS (SELECT FROM codexia_auth."user" u
          JOIN codexia_auth."passkey" p ON p."userId"=u.id WHERE u.id=owner_id)
          THEN 'sha256:' || encode(sha256(convert_to(owner_id::text,'UTF8')),'hex') END)
        FROM codexia_auth.owner_setup WHERE id='first-owner';""")
    require(isinstance(owner, dict))
    promoted = metadata(state_dir / "owner-setup.promoted") is not None
    if owner["grant"] and not owner["consumed"] and owner["ownerCount"] == 0 and not promoted:
        result["authState"] = "pending"
    elif owner["consumed"] and owner["ownerCount"] == 1 and owner["ownerBinding"]:
        result["ownerBindingSha256"] = owner["ownerBinding"]
        result["authState"] = "unprepared"
        if promoted:
            runtime = private_text(auth_dir / "runtime.env")
            subjects = [line.split("=", 1)[1] for line in runtime.splitlines()
                        if line.startswith("CODEXIA_OAUTH_OWNER_SUBJECT=")]
            require(len(subjects) == 1 and "sha256:" + hashlib.sha256(subjects[0].encode()).hexdigest()
                    == owner["ownerBinding"])
            result["settingsSha256"] = hashlib.sha256(runtime.encode()).hexdigest()
            # The marker is created only after the canonical prepare-activation
            # operation verifies owner and clients. Actual admission rechecks them.
            result["authState"] = "ready"
    else:
        result["authState"] = "recovery"
    return result


def observe():
    facts = json.loads(os.environ["CODEXIA_INSPECT_FACTS"])
    writer = json.loads(os.environ["CODEXIA_WRITER_OBSERVATION"])
    machine = Path("/etc/machine-id").read_text().strip()
    require(re.fullmatch(r"[a-f0-9]{32}", machine))
    host_id = hashlib.sha256(machine.encode()).hexdigest()
    base = {"format": "codexia-lifecycle-host/v1", "hostId": host_id, "M": "ready"}
    if not facts["accountPresent"]:
        # Account absence alone cannot establish an empty installation.
        require(not user_exists("codexia") and not user_exists("sophia"))
        require(all(metadata(Path(path)) is None for path in ("/home/codexia", "/home/sophia")))
        return {**base, "H": "absent", "database": {"state": "absent", "authState": "absent"},
                "backend": {"state": "absent"}, "transaction": None, "topology": {"accountPresent": False}}
    account = pwd.getpwnam("codexia")
    require(account.pw_uid == os.getuid() and account.pw_uid > 0 and account.pw_dir == os.environ["HOME"])
    home = Path(account.pw_dir)
    state_dir = home / ".local/state/codexia-deploy"
    auth_dir = home / ".config/codexia-auth"
    units = home / ".config/containers/systemd"
    lock = state_dir / "host.lock"
    lock_info = metadata(lock)
    lock_handle = None
    try:
        if lock_info is not None:
            require(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == os.getuid())
            lock_handle = lock.open("rb")
            fcntl.flock(lock_handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
        transaction = observe_transaction(state_dir)
        residues = [units / "codexia-api.container", units / "default.target.wants/codexia-api.service",
                    state_dir / "deployed-release.json"]
        # The activation symlink is expected on an installed system; presence is
        # enough to rule out a clean slot, and its target is checked by cutover.
        residue = any(os.path.lexists(p) for p in residues)
        storage = home / ".local/share/containers/storage"
        store = metadata(storage)
        require((store is not None) == facts["storagePresent"])
        if store is None:
            require(not residue and transaction is None and
                    all(metadata(p) is None for p in (state_dir / "owner-setup.installation",
                                                      auth_dir / "runtime.env")))
            return {**base, "H": "partial", "database": {"state": "absent", "authState": "absent"},
                    "backend": {"state": "absent"}, "transaction": None,
                    "topology": {"accountPresent": True, "storagePresent": False}}
        require(stat.S_ISDIR(store.st_mode))
        require(command(["podman", "info", "--format", "{{.Host.Security.Rootless}}"])[1] == "true")

        def existence(kind, names):
            return {name: command(["podman", kind, "exists", name], (0, 1))[0] == 0 for name in names}

        networks = existence("network", ("codexia", "codexia-data"))
        volumes = existence("volume", ("codexia-postgres", "codexia-data", "codexia-history"))
        secrets = existence("secret", ("codexia-tunnel-token", "codexia-postgres-admin-password",
                                       "codexia-postgres-app-password"))
        containers = existence("container", ("codexia-db", "codexia-api", "codexia-tunnel"))
        if not lock_handle:
            require(not containers["codexia-api"] and not residue and transaction is None)
        drift = False
        unit_hashes = {}
        for name, expected in facts["quadlets"].items():
            path = units / name
            if metadata(path) is not None:
                actual = hashlib.sha256(private_text(path).encode()).hexdigest()
                unit_hashes[name] = actual
                drift |= actual != expected
        network_hashes = {}
        volume_hashes = {}
        secret_hashes = {}
        container_hashes = {}
        for name, exists in networks.items():
            if exists:
                detail = command(["podman", "network", "inspect", "--format",
                                  "{{.Name}}|{{.Driver}}|{{.Internal}}", name])[1]
                drift |= detail != name + "|bridge|" + ("true" if name == "codexia-data" else "false")
                network_hashes[name] = digest(command(["podman", "network", "inspect", "--format", "{{.ID}}", name])[1])
        for name, exists in volumes.items():
            if exists:
                detail = command(["podman", "volume", "inspect", "--format", "{{.Name}}|{{.Mountpoint}}", name])[1]
                volume_hashes[name] = digest(detail)
                drift |= not detail.startswith(name + "|/")
        for name in (*secrets, "codexia-auth-database-url", "codexia-auth-secret",
                     "codexia-oauth-introspection-client-secret", "codexia-oidc-client-secret"):
            if command(["podman", "secret", "exists", name], (0, 1))[0] == 0:
                secret_hashes[name] = digest(command(["podman", "secret", "inspect", "--format", "{{.ID}}", name])[1])
        for name, exists in containers.items():
            if exists:
                container_hashes[name] = digest(command(["podman", "inspect", "--format",
                    "{{.Id}} {{.State.Running}} {{.Image}}", name])[1])
        topology = {"accountPresent": True, "storagePresent": True, "uid": account.pw_uid,
                    "gid": account.pw_gid, "networks": networks, "volumes": volumes,
                    "secrets": secrets, "containers": containers, "baseEvidence": facts["baseEvidence"],
                    "unitHashes": unit_hashes, "networkHashes": network_hashes, "volumeHashes": volume_hashes,
                    "secretHashes": secret_hashes, "containerHashes": container_hashes}
        # Reuse the already validated full-writer observation rather than
        # inferring authentication or a release identity from a container name.
        full = writer.get("writer") if writer and writer.get("hostId") == host_id else None
        backend = {"state": "unknown"}
        if containers["codexia-api"]:
            info = command(["podman", "inspect", "--format",
                            "{{.Id}} {{.State.Running}} {{.ImageName}}", "codexia-api"])[1].split()
            require(len(info) == 3)
            if full and info == [full["containerId"], "true", full["image"]]:
                backend = {"state": "running", "writer": full}
            elif info[1] == "true" and metadata(units / "codexia-api.container") is not None:
                unit = private_text(units / "codexia-api.container")
                setup_file = auth_dir / "owner-setup.container"
                if ("Environment=CODEXIA_AUTH_MODE=setup-only" in unit.splitlines()
                        and metadata(setup_file) is not None and unit == private_text(setup_file)):
                    backend = {"state": "setup", "containerSha256": digest(info)}
                else:
                    backend = {"state": "unknown"}
            else:
                backend = {"state": "fault"} if info[1] == "false" else {"state": "unknown"}
        elif residue:
            backend = {"state": "fault"}
        else:
            code, unit_state = command(["systemctl", "--user", "show",
                "--property=LoadState,ActiveState", "codexia-api.service"], (0, 4))
            if set(unit_state.splitlines()) == {"LoadState=not-found", "ActiveState=inactive"}:
                backend = {"state": "absent"}
        database = observe_database(volumes, containers, state_dir, auth_dir, full,
                                    os.environ["CODEXIA_AUTH_SCHEMA_QUERY"], facts["volumeLayout"])
        if full:
            require(database.get("clusterId") == writer["database"]["clusterId"])
        base_unknown = facts["baseDrift"] or (containers["codexia-tunnel"] and not facts["baseEvidence"]["tunnel"])
        h = "drift" if drift else "unknown" if base_unknown else "ready" if all(networks.values()) and all(volumes.values()) \
            and all(secrets.values()) and containers["codexia-db"] and facts["baseEvidence"]["database"] \
            and set(unit_hashes) == set(facts["quadlets"]) else "partial"
        return {**base, "H": h, "database": database, "backend": backend,
                "transaction": transaction, "topology": topology}
    finally:
        if lock_handle is not None:
            lock_handle.close()


if __name__ == "__main__":
    try:
        result = observe()
        result["observedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        print(json.dumps(result, separators=(",", ":")))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Neither raw SQL error, arbitrary file content nor subprocess output
        # may escape this observer.
        print("Lifecycle host observation could not be verified", file=__import__("sys").stderr)
        raise SystemExit(1)
