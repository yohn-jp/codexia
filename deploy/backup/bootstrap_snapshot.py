#!/usr/bin/env python3
"""Snapshot canonical Podman credentials under the deployment lock, on the VM only."""

import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

REQUIRED = frozenset((
    "codexia-postgres-admin-password", "codexia-postgres-app-password",
    "codexia-auth-database-url", "codexia-auth-secret",
    "codexia-oauth-introspection-client-secret", "codexia-tunnel-token",
))
OPTIONAL = "codexia-oidc-client-secret"
FORMAT = "codexia-bootstrap-secrets/v1"
RECIPIENT = re.compile(r"age1[023456789acdefghjklmnpqrstuvwxyz]{58}")
HEX = re.compile(r"[a-f0-9]{64}")


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_payload(data):
    if not isinstance(data, dict) or set(data) != {"format", "hostId", "recipient", "secrets"}:
        raise ValueError("Invalid bootstrap recovery payload")
    if data["format"] != FORMAT or not HEX.fullmatch(data["hostId"]) or not RECIPIENT.fullmatch(data["recipient"]):
        raise ValueError("Invalid bootstrap recovery identity")
    values = data["secrets"]
    if not isinstance(values, dict) or set(values) not in (REQUIRED, REQUIRED | {OPTIONAL}):
        raise ValueError("Incomplete bootstrap credential set")
    if any(not isinstance(value, str) or not re.fullmatch(r"[!-~]{1,8192}(?:\n)?", value) for value in values.values()):
        raise ValueError("Invalid bootstrap credential content")


def seal_payload(recipient, encoded):
    return subprocess.run(["age", "-r", recipient], input=encoded, capture_output=True, check=True).stdout


def compare_record(path, identities):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("Unsafe credential identity record")
    if {name: identities[name] for name in REQUIRED} != json.loads(path.read_bytes()):
        raise ValueError("Canonical credentials changed before escrow")


def snapshot(recipient, host_id, seal, expected_ids=None):
    machine = Path("/etc/machine-id").read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[a-f0-9]{32}", machine) or sha(machine.encode()) != host_id or not RECIPIENT.fullmatch(recipient):
        raise ValueError("Bootstrap target or recovery recipient mismatch")
    state = Path.home() / ".local/state/codexia-deploy"
    private_dir(state)
    fd = os.open(state / "host.lock", os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Unsafe host lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        adopting = expected_ids is not None
        if adopting:
            if not seal or not isinstance(expected_ids, dict) or set(expected_ids) not in (REQUIRED, REQUIRED | {OPTIONAL}):
                raise ValueError("Adoption requires the complete reviewed credential identities")
            if any(os.path.lexists(state / name) for name in (
                "deploy-transaction.json", "deploy-transaction.json.tmp", "deployed-release.json.tmp",
                "rollback-api.container", "rollback-release.json", "cutover-transaction.json", "backup-transaction")):
                raise ValueError("Pending deployment or backup transaction precludes credential adoption")
            if os.getuid() == 0 or subprocess.run(["podman", "info", "--format", "{{.Host.Security.Rootless}}"],
                                                  check=True, capture_output=True).stdout.strip() != b"true":
                raise ValueError("Only the rootless service identity can adopt existing credentials")
        names = set(REQUIRED)
        exists = subprocess.run(["podman", "secret", "exists", OPTIONAL], capture_output=True)
        if exists.returncode == 0:
            names.add(OPTIONAL)
        elif exists.returncode != 1:
            raise ValueError("Cannot observe optional identity")
        raw = subprocess.run(["podman", "secret", "inspect", "--showsecret", *sorted(names)], check=True, capture_output=True)
        items = json.loads(raw.stdout)
        values = {item["Spec"]["Name"]: item["SecretData"] for item in items}
        if set(values) != names or len(items) != len(names):
            raise ValueError("Podman credential set changed")
        payload = {"format": FORMAT, "recipient": recipient, "hostId": host_id, "secrets": values}
        validate_payload(payload)
        encoded = canonical(payload)
        binding = {"hostId": host_id, "recipient": recipient, "generation": sha(encoded)}
        if not seal:
            rows = sorted(f"{item['Spec']['Name']} {item['ID']}\n" for item in items)
            binding["idsSha256"] = sha("".join(rows).encode())
        if seal:
            identities = {item["Spec"]["Name"]: sha(json.dumps(item["ID"]).encode()) for item in items}
            record_path = state / "bootstrap-secret-ids.json"
            if not adopting or os.path.lexists(record_path):
                compare_record(record_path, identities)
            if adopting:
                if expected_ids != identities:
                    raise ValueError("Secret identities changed since preflight")
                # Older staged installations have no R4 receipt. Seal exactly the
                # observed set to stdout without writing a marker or caching on the VM.
                return {**binding, "existingSet": True,
                        "ciphertext": base64.b64encode(seal_payload(recipient, encoded)).decode("ascii")}
            cache = state / "bootstrap-escrow"
            cache.mkdir(mode=0o700, exist_ok=True)
            private_dir(cache)
            path = cache / (binding["generation"] + ".age")
            if not path.exists():
                # Keep the first ciphertext across retries; age intentionally uses fresh randomness.
                cipher = seal_payload(recipient, encoded)
                with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temporary:
                    try:
                        temporary.write(cipher)
                        temporary.flush()
                        os.fsync(temporary.fileno())
                        os.link(temporary.name, path)
                    finally:
                        os.unlink(temporary.name)
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
                raise ValueError("Invalid cached escrow")
            ciphertext = path.read_bytes()
            if not ciphertext.startswith(b"age-encryption.org/v1\n"):
                raise ValueError("Invalid encrypted snapshot")
            binding["ciphertext"] = base64.b64encode(ciphertext).decode("ascii")
        return binding


def private_dir(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Unsafe bootstrap recovery directory")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["seal", "identity", "adopt"])
    parser.add_argument("host_id")
    parser.add_argument("recipient")
    args = parser.parse_args()
    try:
        expected = None
        if args.operation == "adopt":
            raw = sys.stdin.buffer.read(4097)
            if len(raw) > 4096:
                raise ValueError("Oversized adoption evidence")
            expected = json.loads(raw)
            if not isinstance(expected, dict):
                raise ValueError("Adoption requires the reviewed identities")
        print(json.dumps(snapshot(args.recipient, args.host_id, args.operation != "identity", expected)))
    except Exception:
        sys.exit("Cannot establish the protected bootstrap credential snapshot")
