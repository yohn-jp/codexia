#!/usr/bin/env python3
"""Supplement the canonical Ansible inspect and writer observations.

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
import sys
from contextlib import ExitStack
from datetime import datetime, timezone

FULL_IMAGE = r"ghcr[.]io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}"
RAW_HASH = r"[a-f0-9]{64}"
RECORD_ID = r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}"


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


# The read-only observer and the locked owner and activation operations bind Podman IDs.
# Lookup metadata only. Never request secret contents.
BASE_SECRETS = ("codexia-tunnel-token", "codexia-postgres-admin-password", "codexia-postgres-app-password")
AUTH_SECRETS = ("codexia-auth-database-url", "codexia-auth-secret", "codexia-oauth-introspection-client-secret")
OPTIONAL_SECRET = "codexia-oidc-client-secret"


def secret_identities():
    hashes = {}
    for name in (*BASE_SECRETS, *AUTH_SECRETS, OPTIONAL_SECRET):
        if command(["podman", "secret", "exists", name], (0, 1))[0] == 0:
            identity = command(["podman", "secret", "inspect", "--format", "{{.ID}}", name])[1]
            require(bool(identity))
            hashes[name] = digest(identity)
    return hashes


def verify_host_lock(state_dir, lock_fd):
    lock = state_dir / "host.lock"
    actual = os.fstat(lock_fd)
    require(stat.S_ISREG(actual.st_mode) and actual.st_uid == os.getuid() and
            os.path.samestat(actual, lock.stat(follow_symlinks=False)))
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def verify_secret_identities(expected, lock_fd):
    require(re.fullmatch(RAW_HASH, expected))
    verify_host_lock(Path.home() / ".local/state/codexia-deploy", lock_fd)
    hashes = secret_identities()
    require(set(BASE_SECRETS + AUTH_SECRETS).issubset(hashes) and digest(hashes) == expected)


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


def no_duplicate_keys(pairs):
    result = dict(pairs)
    require(len(result) == len(pairs))
    return result


def require_fields(value, fields):
    require(isinstance(value, dict) and value.keys() == fields.keys())
    require(all(isinstance(value[key], str) and re.fullmatch(pattern, value[key])
                for key, pattern in fields.items()))


def read_owner_handoff(home, lock_fd, recipient, grant_binding):
    """Read only the encrypted owner handoff under the inherited host lock."""
    current_uid = os.getuid()
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with ExitStack() as descriptors:
        def opened(path, flags, **kwargs):
            descriptor = os.open(path, flags, **kwargs)
            descriptors.callback(os.close, descriptor)
            return descriptor

        home_fd = opened(home, directory_flags)
        home_info = os.fstat(home_fd)
        require(home_info.st_uid == current_uid and not home_info.st_mode & 0o022)
        state_fd = home_fd
        for component in (".local", "state", "codexia-deploy"):
            state_fd = opened(component, directory_flags, dir_fd=state_fd)
            directory = os.fstat(state_fd)
            require(directory.st_uid == current_uid and not directory.st_mode & 0o022)
        require(stat.S_IMODE(directory.st_mode) == 0o700)
        lock = os.fstat(lock_fd)
        require(stat.S_ISREG(lock.st_mode) and lock.st_uid == current_uid and lock.st_nlink == 1 and
                os.path.samestat(lock, os.stat("host.lock", dir_fd=state_fd, follow_symlinks=False)))
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for marker in ("owner-setup.age.pending", "owner-setup.promoted", "deployed-release.json",
                       "deploy-transaction.json", "cutover-transaction.json"):
            try:
                os.stat(marker, dir_fd=state_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            require(False)
        def protected_bytes(name, limit):
            descriptor = opened(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=state_fd)
            info = os.fstat(descriptor)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == current_uid and info.st_nlink == 1 and
                    stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= limit)
            content = os.read(descriptor, limit + 1)
            current = os.stat(name, dir_fd=state_fd, follow_symlinks=False)
            require(len(content) == info.st_size and info.st_ctime_ns == current.st_ctime_ns and
                    os.path.samestat(info, current))
            return content

        receipt = json.loads(protected_bytes("owner-setup.age.receipt.json", 4096),
                             object_pairs_hook=no_duplicate_keys)
        require_fields(receipt, {
            "format": r"codexia-owner-handoff/v1", "recipient": r"age1[0-9a-z]+",
            "grantBindingSha256": RAW_HASH, "envelopeSha256": RAW_HASH,
        })
        require(receipt["recipient"] == recipient and receipt["grantBindingSha256"] == grant_binding)
        ciphertext = protected_bytes("owner-setup.age", 16 * 1024)
        require(hashlib.sha256(ciphertext).hexdigest() == receipt["envelopeSha256"])
        return ciphertext


def read_recovery_handoff(state_dir):
    path = state_dir / "recovery-handoff.json"
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        parent = path.parent.stat(follow_symlinks=False)
        require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid() and
                stat.S_IMODE(parent.st_mode) == 0o700 and stat.S_ISREG(info.st_mode) and
                info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600 and
                info.st_nlink == 1 and 0 < info.st_size <= 16 * 1024)
        raw = stream.read(16 * 1024 + 1)
        require(len(raw) == info.st_size and
                os.path.samestat(info, path.stat(follow_symlinks=False)) and
                os.path.samestat(parent, path.parent.stat(follow_symlinks=False)))
    value = json.loads(raw, object_pairs_hook=no_duplicate_keys)
    require(isinstance(value, dict) and set(value) == {
        "format", "operationId", "environment", "backup", "target", "release",
        "window", "writerFence", "executorFenceSha256", "credentialsRecordSha256",
        "postBackupWritesRecordSha256",
    })
    require_fields({key: value[key] for key in
                    ("format", "operationId", "environment", "executorFenceSha256", "credentialsRecordSha256",
                     "postBackupWritesRecordSha256")}, {
        "format": r"codexia-recovery-handoff/v1", "operationId": RECORD_ID,
        "environment": "codexia-production", "executorFenceSha256": RAW_HASH,
        "credentialsRecordSha256": RAW_HASH, "postBackupWritesRecordSha256": RAW_HASH,
    })
    point = {
        "id": r"codexia-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}",
        "sourceHostId": RAW_HASH, "manifestSha256": RAW_HASH, "transferReceiptSha256": RAW_HASH,
        "restoreReceiptSha256": RAW_HASH, "databaseFingerprint": RAW_HASH, "historyFingerprint": RAW_HASH,
    }
    if isinstance(value["backup"], dict) and ("sourceClusterId" in value["backup"] or "sourceDatabaseOid" in value["backup"]):
        point.update({"sourceClusterId": r"[1-9][0-9]{0,19}", "sourceDatabaseOid": r"[1-9][0-9]{0,9}"})
    require_fields(value["backup"], point)
    require_fields(value["target"], {
        "hostId": RAW_HASH, "clusterId": r"[1-9][0-9]{0,19}", "databaseOid": r"[1-9][0-9]{0,9}",
        "ledgerSha256": RAW_HASH, "authSchemaSha256": "sha256:" + RAW_HASH,
        "ownerBindingSha256": "sha256:" + RAW_HASH, "settingsSha256": RAW_HASH, "secretSetSha256": RAW_HASH,
    })
    source, target = value["backup"], value["target"]
    require(not (source["sourceHostId"] == target["hostId"] and
                 source.get("sourceClusterId") == target["clusterId"] and
                 source.get("sourceDatabaseOid") == target["databaseOid"]))
    require_fields(value["release"], {
        "image": FULL_IMAGE, "sourceSha": r"[a-f0-9]{40}", "frontendArtifactSha256": RAW_HASH,
    })
    timestamp = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"
    require_fields(value["window"], {"id": RECORD_ID, "notBefore": timestamp, "notAfter": timestamp})
    start, end = (datetime.fromisoformat(value["window"][key]) for key in ("notBefore", "notAfter"))
    backup_time = datetime.strptime(source["id"].split("-")[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    require(backup_time <= start < end)
    require_fields(value["writerFence"], {
        "kind": r"(?:decommissioned|write-access-revoked)", "recordSha256": RAW_HASH,
    })
    return value, hashlib.sha256(raw).hexdigest()


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


def read_migration_ledger():
    ledger = json_sql("codexia", """SELECT coalesce(json_agg(json_build_object(
        'version', version, 'checksum', btrim(checksum)) ORDER BY version COLLATE "C"), '[]'::json)
        FROM public.codexia_schema_migrations;""")
    require(isinstance(ledger, list) and 0 < len(ledger) <= 1000)
    return ledger


def read_auth_schema_fingerprint(auth_query):
    definitions = sql("codexia", "BEGIN READ ONLY; SET LOCAL search_path TO codexia_auth; " + auth_query + "; COMMIT;").splitlines()
    return "sha256:" + hashlib.sha256(json.dumps(definitions, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def restored_owner_settings(auth_dir):
    owner = sql("codexia", """SELECT 'sha256:' || encode(sha256(convert_to(setup.owner_id::text,'UTF8')),'hex')
        FROM codexia_auth.owner_setup setup
        WHERE setup.id='first-owner' AND setup.consumed_at IS NOT NULL
          AND (SELECT count(*) FROM codexia_auth."user") = 1
          AND EXISTS (SELECT FROM codexia_auth."user" u JOIN codexia_auth."passkey" p ON p."userId"=u.id
            WHERE u.id=setup.owner_id);""")
    require(re.fullmatch("sha256:" + RAW_HASH, owner))
    runtime_path = auth_dir / "runtime.env"
    runtime_info = metadata(runtime_path)
    require(runtime_info is not None and stat.S_IMODE(runtime_info.st_mode) == 0o600)
    runtime = private_text(runtime_path)
    subjects = [line.split("=", 1)[1] for line in runtime.splitlines()
                if line.startswith("CODEXIA_OAUTH_OWNER_SUBJECT=")]
    require(len(subjects) == 1 and "sha256:" + hashlib.sha256(subjects[0].encode()).hexdigest() == owner)
    return {"ownerBindingSha256": owner, "settingsSha256": hashlib.sha256(runtime.encode()).hexdigest()}


def machine_identity():
    machine = Path("/etc/machine-id").read_text().strip()
    require(re.fullmatch(r"[a-f0-9]{32}", machine))
    return hashlib.sha256(machine.encode()).hexdigest()


def assert_restored_target(record, database, host_id):
    target = record["target"]
    require(target["hostId"] == host_id and target["ledgerSha256"] == digest(database["ledger"]))
    require(all(target[key] == database[key]
                for key in ("clusterId", "databaseOid", "ownerBindingSha256", "settingsSha256")))
    require(target["authSchemaSha256"] == database["authSchemaSha256"])


def require_recovery_worker_stopped():
    _, status = command(["systemctl", "--user", "show", "--property=LoadState",
                         "--property=UnitFileState", "--property=ActiveState",
                         "codexia-backup-executor.service"], (0, 4))
    fields = dict(line.split("=", 1) for line in status.splitlines() if "=" in line)
    require(fields.get("ActiveState") == "inactive" and
            (fields.get("LoadState") == "not-found" or fields.get("UnitFileState") in ("disabled", "masked")))


def require_tunnel_inactive():
    _, state = command(["systemctl", "--user", "show", "--property=ActiveState", "--value",
                        "codexia-tunnel.service"])
    require(state == "inactive" and command(["podman", "container", "exists", "codexia-tunnel"], (0, 1))[0] == 1)


def verify_recovery_handoff(expected_digest, operation_id, image, source_sha, lock_fd):
    home = Path.home()
    state_dir = home / ".local/state/codexia-deploy"
    verify_host_lock(state_dir, lock_fd)
    evidence = read_recovery_handoff(state_dir)
    require(evidence is not None)
    record, evidence_digest = evidence
    require(evidence_digest == expected_digest and record["operationId"] == operation_id and
            record["release"]["image"] == image and record["release"]["sourceSha"] == source_sha)
    now = datetime.now(timezone.utc)
    require(datetime.fromisoformat(record["window"]["notBefore"]) <= now <=
            datetime.fromisoformat(record["window"]["notAfter"]))
    require_recovery_worker_stopped()
    require_tunnel_inactive()
    verify_secret_identities(record["target"]["secretSetSha256"], lock_fd)
    database = json_sql("codexia", """SELECT json_build_object('clusterId', system_identifier::text,
        'databaseOid', (SELECT oid::text FROM pg_database WHERE datname=current_database()))
        FROM pg_control_system();""")
    database["ledger"] = read_migration_ledger()
    database["authSchemaSha256"] = read_auth_schema_fingerprint(os.environ["CODEXIA_AUTH_SCHEMA_QUERY"])
    database.update(restored_owner_settings(home / ".config/codexia-auth"))
    assert_restored_target(record, database, machine_identity())
    return {key: record["backup"][key] for key in ("databaseFingerprint", "historyFingerprint")}


def read_owner_installation_intent(path, cluster):
    info = metadata(path)
    if info is None:
        return None
    require(stat.S_IMODE(info.st_mode) == 0o600)
    system_id, database_oid, image = private_text(path).removesuffix("\n").split(":", 2)
    require(system_id == cluster["clusterId"] and database_oid == cluster["databaseOid"]
            and re.fullmatch(r"[1-9][0-9]{0,9}", database_oid) and re.fullmatch(FULL_IMAGE, image))
    return {"clusterId": system_id, "databaseOid": database_oid, "image": image}


def user_exists(name):
    try:
        pwd.getpwnam(name)
        return True
    except KeyError:
        return False


def observe_transaction(state_dir):
    require(metadata(state_dir / "backup-transaction") is None)
    # No retired operation can be interpreted or resumed by ordinary deployment.
    require(metadata(state_dir / "cutover-transaction.json") is None)
    path = state_dir / "deploy-transaction.json"
    if metadata(path) is not None:
        data = json.loads(private_text(path))
        require(data.get("format") == "codexia-deploy-transaction/v1"
                and data.get("phase") in ("pending", "committed"))
        require(all(type(data.get(k)) is bool for k in
                    ("hadUnit", "tunnelWasActive", "apiLinkCreated", "tunnelLinkCreated", "releasePresent")))
        return {"format": "codexia-deploy-transaction/v1", "phase": data["phase"], "sha256": digest(data)}
    # An orphan temporary journal or rollback snapshot is not proof of a clean slot.
    for name in ("deploy-transaction.json.tmp", "deployed-release.json.tmp",
                 "rollback-api.container", "rollback-release.json"):
        require(metadata(state_dir / name) is None)
    return None


def observe_database(volumes, containers, state_dir, auth_dir, writer, auth_query, volume_layout,
                     resume_clean=False, inspect_restored=False):
    if not volumes["codexia-postgres"]:
        require(not containers["codexia-db"])
        return {"state": "absent", "authState": "absent"}
    if not containers["codexia-db"]:
        return {"state": "pristine", "authState": "absent"} if volume_layout == "empty" else {"state": "unknown", "authState": "unknown"}
    if command(["podman", "inspect", "--format", "{{.State.Running}}", "codexia-db"])[1] != "true":
        return {"state": "unknown", "authState": "unknown"}
    cluster = json_sql("postgres", """SELECT json_build_object(
        'clusterId', (SELECT system_identifier::text FROM pg_control_system()),
        'databaseOid', (SELECT oid::text FROM pg_database WHERE datname='codexia'),
        'appExists', EXISTS (SELECT FROM pg_database WHERE datname='codexia'),
        'rolesValid', EXISTS (SELECT FROM pg_roles WHERE rolname='codexia_admin' AND rolcanlogin AND rolsuper)
          AND EXISTS (SELECT FROM pg_roles r WHERE rolname='codexia' AND rolcanlogin AND NOT rolsuper
            AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
            AND NOT EXISTS (SELECT FROM pg_auth_members WHERE roleid=r.oid OR member=r.oid)
            AND (NOT EXISTS (SELECT FROM pg_database WHERE datname='codexia')
              OR EXISTS (SELECT FROM pg_database WHERE datname='codexia' AND datdba=r.oid)))) ;""")
    require(re.fullmatch(r"[1-9][0-9]{0,19}", cluster["clusterId"]))
    require(cluster["rolesValid"] and volume_layout == "ready")
    if not cluster["appExists"]:
        return {"state": "missing", "authState": "absent", "clusterId": cluster["clusterId"]}
    db = json_sql("codexia", """SELECT json_build_object(
        'ledgerExists', to_regclass('public.codexia_schema_migrations') IS NOT NULL,
        'authExists', EXISTS (SELECT FROM pg_namespace WHERE nspname='codexia_auth'),
        'appRelations', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','v','m','f','S'))) ;""")
    if not db["ledgerExists"]:
        require(not db["authExists"] and db["appRelations"] == 0)
        return {"state": "pristine", "authState": "absent", "clusterId": cluster["clusterId"]}
    ledger = read_migration_ledger()
    require(re.fullmatch(r"[1-9][0-9]{0,9}", cluster["databaseOid"]))
    result = {"state": "initialized", "clusterId": cluster["clusterId"], "databaseOid": cluster["databaseOid"], "ledger": ledger,
              "authState": "unknown", "authSchemaSha256": None, "ownerBindingSha256": None}
    if not db["authExists"]:
        result["authState"] = "legacy" if writer and writer.get("authMode") == "legacy" else "absent"
        if (resume_clean and writer is None and not containers.get("codexia-api")
                and all(metadata(state_dir / name) is None for name in (
                    "owner-setup.installation", "owner-setup.promoted", "owner-setup.age", "owner-setup.age.pending"))):
            intent = read_owner_installation_intent(state_dir / "owner-setup.intent", cluster)
            if intent is not None:
                result["bootstrapIntent"] = intent
        return result
    namespace = json_sql("codexia", """SELECT json_build_object(
        'empty', n.nspowner = (SELECT oid FROM pg_roles WHERE rolname='codexia_auth_runtime')
          AND EXISTS (SELECT FROM pg_roles r WHERE r.oid=n.nspowner AND r.rolcanlogin AND NOT r.rolsuper
            AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication
            AND NOT r.rolbypassrls)
          AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member=n.nspowner OR roleid=n.nspowner)
          AND NOT EXISTS (SELECT FROM pg_default_acl WHERE defaclrole=n.nspowner)
          AND NOT EXISTS (SELECT FROM aclexplode(COALESCE(n.nspacl, acldefault('n',n.nspowner))) acl
            WHERE acl.grantee<>n.nspowner)
          AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid)
          AND NOT EXISTS (SELECT FROM pg_class c WHERE c.relnamespace=n.oid)
          AND NOT EXISTS (SELECT FROM pg_proc p WHERE p.pronamespace=n.oid)
          AND NOT EXISTS (SELECT FROM pg_type t WHERE t.typnamespace=n.oid)
        ) FROM pg_namespace n WHERE n.nspname='codexia_auth';""")
    # A schema-only catalog checkpoint is valid only while the original install
    # intent and the clean setup slot are both positively observed under lock.
    if (namespace.get("empty") is True and resume_clean and writer is None and
            all(metadata(state_dir / name) is None for name in (
                "owner-setup.installation", "owner-setup.promoted", "owner-setup.age",
                "owner-setup.age.pending"))):
        intent = read_owner_installation_intent(state_dir / "owner-setup.intent", cluster)
        if intent is not None:
            result.update({"authState": "absent", "emptyAuthSchema": True,
                           "bootstrapIntent": intent})
    # Use the owning auth-schema catalog query supplied by the checked-out source.
    # Hash its ordered text definitions locally; never emit them.
    result["authSchemaSha256"] = read_auth_schema_fingerprint(auth_query)
    if result.get("emptyAuthSchema") is True:
        return result
    if inspect_restored:
        require(writer is None)
        result.update(restored_owner_settings(auth_dir))
        result["authState"] = "ready"
        return result
    if writer and writer.get("authMode") == "better-auth":
        result["ownerBindingSha256"] = writer["ownerBindingSha256"]
        # Reuse the existing read-only Better Auth schema/client verifier in the
        # already running API container. Never start a setup or candidate image.
        status, _ = command(["podman", "exec", writer["containerId"], "node",
                             "/app/node_modules/@codexia/api/dist/verify-auth-clients.js"], (0, 1))
        result["authState"] = "ready" if status == 0 else "unknown"
        return result
    intent = read_owner_installation_intent(state_dir / "owner-setup.intent", cluster)
    marker = state_dir / "owner-setup.installation"
    marker_info = metadata(marker)
    has_marker = marker_info is not None
    if intent is None and not has_marker:
        return result  # Existing schema alone is not a fresh-install authorization.
    if has_marker:
        require(stat.S_IMODE(marker_info.st_mode) == 0o600 and private_text(marker).strip() == cluster["clusterId"])
    if intent is not None:
        result["setupImage"] = intent["image"]
    else:
        # Earlier setup operations wrote the installation marker only after
        # migration. An existing grant can resume with the exact staged unit.
        lines = private_text(auth_dir / "owner-setup.container").splitlines()
        images = [line.removeprefix("Image=") for line in lines if line.startswith("Image=")]
        require(len(images) == 1 and re.fullmatch(FULL_IMAGE, images[0]))
        result["setupImage"] = images[0]
    if sql("codexia", "SELECT to_regclass('codexia_auth.owner_setup') IS NOT NULL;") != "t":
        return result
    owner = json_sql("codexia", """SELECT json_build_object(
        'grant', COALESCE(grant_id IS NOT NULL AND grant_digest IS NOT NULL
          AND expires_at > now() AND consumed_at IS NULL AND owner_id IS NULL, false),
        'hasGrant', grant_id IS NOT NULL,
        'grantBinding', CASE WHEN grant_id IS NOT NULL
          THEN encode(sha256(convert_to(json_build_array(grant_id, extract(epoch FROM expires_at))::text,'UTF8')),'hex') END,
        'consumed', consumed_at IS NOT NULL,
        'pristine', NOT EXISTS (SELECT FROM codexia_auth."user")
          AND NOT EXISTS (SELECT FROM codexia_auth."account")
          AND NOT EXISTS (SELECT FROM codexia_auth."passkey")
          AND NOT EXISTS (SELECT FROM codexia_auth."session")
          AND NOT EXISTS (SELECT FROM codexia_auth."verification")
          AND NOT EXISTS (SELECT FROM codexia_auth."oauthClient")
          AND NOT EXISTS (SELECT FROM codexia_auth."jwks"),
        'ownerCount', (SELECT count(*) FROM codexia_auth."user"),
        'ownerBinding', CASE WHEN EXISTS (SELECT FROM codexia_auth."user" u
          JOIN codexia_auth."passkey" p ON p."userId"=u.id WHERE u.id=owner_id)
          THEN 'sha256:' || encode(sha256(convert_to(owner_id::text,'UTF8')),'hex') END)
        FROM (SELECT 1) seed LEFT JOIN codexia_auth.owner_setup ON id='first-owner';""")
    require(isinstance(owner, dict))
    grant_binding = owner["grantBinding"]
    require((grant_binding is None and not owner["hasGrant"]) or
            (owner["hasGrant"] and isinstance(grant_binding, str) and re.fullmatch(r"[a-f0-9]{64}", grant_binding)))
    promotion_marker = state_dir / "owner-setup.promoted"
    promotion_info = metadata(promotion_marker)
    promoted = promotion_info is not None
    if promoted:
        require(has_marker and stat.S_IMODE(promotion_info.st_mode) == 0o600)
        promotion = private_text(promotion_marker)
        require(promotion == "activation-ready\n" or (intent is None and promotion == ""))
    handoff = metadata(state_dir / "owner-setup.age")
    has_envelope = bool(handoff and stat.S_ISREG(handoff.st_mode) and handoff.st_uid == os.getuid()
                        and stat.S_IMODE(handoff.st_mode) == 0o600 and handoff.st_size > 0)
    pending_handoff = metadata(state_dir / "owner-setup.age.pending") is not None
    result["ownerSetupCheckpoint"] = {
        "setupMarkerPresent": has_marker, "grantBindingSha256": grant_binding,
        "pendingHandoff": pending_handoff, "encryptedHandoffPresent": has_envelope,
    }
    if not promoted and not owner["hasGrant"] and owner["pristine"] and intent is not None:
        require(handoff is None)
        result["authState"] = "pending"
    elif owner["grant"] and not owner["consumed"] and owner["ownerCount"] == 0 and not promoted:
        result["authState"] = "pending" if has_marker and has_envelope and not pending_handoff else "recovery"
    elif owner["consumed"] and owner["ownerCount"] == 1 and owner["ownerBinding"]:
        require(has_marker)
        result["ownerBindingSha256"] = owner["ownerBinding"]
        result["authState"] = "unprepared"
        runtime = private_text(auth_dir / "runtime.env")
        subjects = [line.split("=", 1)[1] for line in runtime.splitlines()
                    if line.startswith("CODEXIA_OAUTH_OWNER_SUBJECT=")]
        if subjects or promoted:
            require(len(subjects) == 1 and "sha256:" + hashlib.sha256(subjects[0].encode()).hexdigest()
                    == owner["ownerBinding"])
            result["settingsSha256"] = hashlib.sha256(runtime.encode()).hexdigest()
        if promoted:
            # The marker is created only after the canonical prepare-activation
            # operation verifies owner and clients. Actual admission rechecks them.
            result["authState"] = "ready"
            if intent is not None:
                result["bootstrapIntent"] = intent
    else:
        result["authState"] = "recovery"
    return result


def observe():
    facts = json.loads(os.environ["CODEXIA_INSPECT_FACTS"])
    writer = json.loads(os.environ["CODEXIA_WRITER_OBSERVATION"])
    host_id = machine_identity()
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
        # enough to rule out a clean slot, and its target is checked by writer observation.
        residue = any(os.path.lexists(p) for p in residues)
        storage = home / ".local/share/containers/storage"
        store = metadata(storage)
        require((store is not None) == facts["storagePresent"])
        if store is None:
            require(not residue and transaction is None and
                    all(metadata(p) is None for p in (state_dir / "owner-setup.installation",
                                                      state_dir / "owner-setup.intent",
                                                      auth_dir / "runtime.env")))
            return {**base, "H": "partial", "database": {"state": "absent", "authState": "absent"},
                    "backend": {"state": "absent"}, "transaction": None,
                    "topology": {"accountPresent": True, "storagePresent": False, "hostReady": facts["hostReady"]}}
        require(stat.S_ISDIR(store.st_mode))
        require(command(["podman", "info", "--format", "{{.Host.Security.Rootless}}"])[1] == "true")

        def existence(kind, names):
            return {name: command(["podman", kind, "exists", name], (0, 1))[0] == 0 for name in names}

        networks = existence("network", ("codexia", "codexia-data"))
        volumes = existence("volume", ("codexia-postgres", "codexia-data", "codexia-history"))
        secrets = existence("secret", BASE_SECRETS)
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
        secret_hashes = secret_identities()
        for name, exists in containers.items():
            if exists:
                container_hashes[name] = digest(command(["podman", "inspect", "--format",
                    "{{.Id}} {{.State.Running}} {{.Image}}", name])[1])
        topology = {"accountPresent": True, "storagePresent": True, "hostReady": facts["hostReady"], "uid": account.pw_uid,
                    "gid": account.pw_gid, "networks": networks, "volumes": volumes,
                    "secrets": secrets, "containers": containers, "baseEvidence": facts["baseEvidence"],
                    "unitHashes": unit_hashes, "networkHashes": network_hashes, "volumeHashes": volume_hashes,
                    "secretHashes": secret_hashes, "containerHashes": container_hashes}
        # Reuse the already validated full-writer observation rather than
        # inferring authentication or a release identity from a container name.
        full = writer.get("writer") if writer and writer.get("hostId") == host_id else None
        setup_file = auth_dir / "owner-setup.container"
        setup_unit = None
        if metadata(residues[0]) is not None and metadata(setup_file) is not None and not any(
                os.path.lexists(p) for p in residues[1:]):
            unit = private_text(residues[0])
            if "Environment=CODEXIA_AUTH_MODE=setup-only" in unit.splitlines() and unit == private_text(setup_file):
                setup_unit = unit
        backend = {"state": "unknown"}
        if containers["codexia-api"]:
            info = command(["podman", "inspect", "--format",
                            "{{.Id}} {{.State.Running}} {{.ImageName}}", "codexia-api"])[1].split()
            require(len(info) == 3)
            if full and info == [full["containerId"], "true", full["image"]]:
                backend = {"state": "running", "writer": full}
            elif setup_unit and re.fullmatch(FULL_IMAGE, info[2]) and "Image=" + info[2] in setup_unit.splitlines():
                backend = {"state": "setup", "containerSha256": digest(info)}
            else:
                backend = {"state": "fault"} if info[1] == "false" else {"state": "unknown"}
        elif setup_unit:
            backend = {"state": "setup", "unitSha256": digest(setup_unit)}
        elif residue:
            backend = {"state": "fault"}
        else:
            code, unit_state = command(["systemctl", "--user", "show",
                "--property=LoadState,ActiveState", "codexia-api.service"], (0, 4))
            if set(unit_state.splitlines()) == {"LoadState=not-found", "ActiveState=inactive"}:
                backend = {"state": "absent"}
        recovery = None
        observe_restore = transaction is None and os.environ.get("CODEXIA_OBSERVE_RECOVERY") == "true"
        clean_restore = bool(lock_handle is not None and backend["state"] == "absent" and not residue and
                             not containers["codexia-api"] and not containers["codexia-tunnel"])
        if observe_restore:
            recovery = read_recovery_handoff(state_dir)
        if recovery is not None:
            require(clean_restore)
            require_recovery_worker_stopped()
            require_tunnel_inactive()
            require(set(BASE_SECRETS + AUTH_SECRETS).issubset(secret_hashes) and
                    digest(secret_hashes) == recovery[0]["target"]["secretSetSha256"])
        database = observe_database(volumes, containers, state_dir, auth_dir, full,
                                    os.environ["CODEXIA_AUTH_SCHEMA_QUERY"], facts["volumeLayout"],
                                    resume_clean=not observe_restore and lock_handle is not None and transaction is None and
                                    backend.get("state") == "absent" and not residue and
                                    not containers["codexia-api"],
                                    inspect_restored=observe_restore and clean_restore)
        if database["state"] in ("missing", "absent"):
            # Verify the canonical residual slot independently of old DB health.
            if containers["codexia-api"]:
                require(re.fullmatch(FULL_IMAGE, info[2]))
                if metadata(residues[0]) is not None:
                    lines = private_text(residues[0]).splitlines()
                    require("ContainerName=codexia-api" in lines and "Image=" + info[2] in lines)
            if backend["state"] != "absent":
                if not residue and not containers["codexia-api"]:
                    # An interrupted reset may have removed the Quadlet before reload.
                    _, source = command(["systemctl", "--user", "show", "--property=SourcePath", "--value", "codexia-api.service"], (0, 4))
                    require(source == str(residues[0]))
                backend = {"state": "fault", "databaseAbsent": True}
        elif full:
            require(database.get("clusterId") == writer["database"]["clusterId"])
        base_unknown = facts["baseDrift"] or (containers["codexia-tunnel"] and not facts["baseEvidence"]["tunnel"])
        h = "drift" if drift else "unknown" if base_unknown else "ready" if facts["hostReady"] and all(networks.values()) and all(volumes.values()) \
            and all(secrets.values()) and containers["codexia-db"] and facts["baseEvidence"]["database"] \
            and set(unit_hashes) == set(facts["quadlets"]) else "partial"
        result = {**base, "H": h, "database": database, "backend": backend,
                  "transaction": transaction, "topology": topology}
        if recovery is not None:
            record, evidence_digest = recovery
            require(h == "ready" and database["state"] == "initialized" and database["authState"] == "ready" and
                    datetime.now(timezone.utc) <= datetime.fromisoformat(record["window"]["notAfter"]))
            assert_restored_target(record, database, host_id)
            result["recovery"] = {"operationId": record["operationId"], "evidenceSha256": evidence_digest,
                                  "release": record["release"], "window": record["window"]}
        return result
    finally:
        if lock_handle is not None:
            lock_handle.close()


if __name__ == "__main__":
    try:
        if sys.argv[1:2] in (["check-owner-handoff"], ["export-owner-handoff"]):
            require(len(sys.argv) == 5 and sys.argv[2] == "9")
            account = pwd.getpwnam("codexia")
            require(account.pw_uid == os.getuid() and account.pw_uid > 0 and account.pw_dir == "/home/codexia")
            ciphertext = read_owner_handoff(Path(account.pw_dir), 9, sys.argv[3], sys.argv[4])
            if sys.argv[1] == "export-owner-handoff":
                sys.stdout.buffer.write(ciphertext)
            sys.exit(0)
        if sys.argv[1:2] == ["verify-secret-identities"]:
            require(len(sys.argv) == 3)
            verify_secret_identities(sys.argv[2], 9)
            sys.exit(0)
        if sys.argv[1:2] == ["verify-recovery-handoff"]:
            require(len(sys.argv) == 6)
            print(json.dumps(verify_recovery_handoff(*sys.argv[2:], lock_fd=9), separators=(",", ":")))
            sys.exit(0)
        require(len(sys.argv) == 1)
        result = observe()
        result["observedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        print(json.dumps(result, separators=(",", ":")))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Neither raw SQL error, arbitrary file content nor subprocess output
        # may escape this observer.
        print("Lifecycle host observation could not be verified", file=__import__("sys").stderr)
        raise SystemExit(1)
