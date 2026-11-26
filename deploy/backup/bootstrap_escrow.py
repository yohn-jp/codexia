#!/usr/bin/env python3
"""Transfer and independently recover a bounded age envelope for bootstrap credentials."""

import argparse
import base64
import fcntl
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

from bootstrap_snapshot import HEX, RECIPIENT, canonical, private_dir, sha, validate_payload
from s3_transfer import _error_code, _make_client, _read_commit_marker, validate_profile

RECEIPT = "codexia-bootstrap-escrow/v1"
VERIFIED = "codexia-bootstrap-escrow-verified/v1"


def binding(value):
    host, generation, recipient = (value[k] for k in ("hostId", "generation", "recipient"))
    if not HEX.fullmatch(host) or not HEX.fullmatch(generation) or not RECIPIENT.fullmatch(recipient):
        raise ValueError("Invalid bootstrap escrow binding")
    return {"hostId": host, "generation": generation, "recipient": recipient}


def key(profile, snapshot, namespace):
    return f"{profile['prefix']}/{namespace}/{snapshot['hostId']}/{snapshot['generation']}"


def location(profile):
    return {field: profile[field] for field in ("provider", "region", "endpointUrl", "bucket", "prefix")}


def fetch(client, profile, object_key, version=None):
    request = {"Bucket": profile["bucket"], "Key": object_key}
    if version:
        request["VersionId"] = version
    response = client.get_object(**request)
    data = _read_commit_marker(response)  # shared bounded, length-checked read with guaranteed close
    actual_version = response.get("VersionId")
    if version and actual_version != version:
        raise ValueError("S3 returned a different version")
    if profile.get("retentionMode"):
        until = response.get("ObjectLockRetainUntilDate")
        if (not actual_version or actual_version == "null" or response.get("ObjectLockMode") != profile["retentionMode"]
                or not isinstance(until, datetime) or until <= datetime.now(timezone.utc)):
            raise ValueError("S3 object retention unverified")
    return data, actual_version


def put_once(client, profile, object_key, data):
    retention = {}
    if profile.get("retentionMode"):
        retention = {"ObjectLockMode": profile["retentionMode"],
                     "ObjectLockRetainUntilDate": datetime.now(timezone.utc) + timedelta(days=profile["retentionDays"])}
    try:
        result = client.put_object(Bucket=profile["bucket"], Key=object_key, Body=data, ContentLength=len(data),
                                   IfNoneMatch="*", **retention)
        version = result.get("VersionId")
    except Exception as error:
        if _error_code(error) not in ("412", "PreconditionFailed", "ConditionalRequestConflict", "409"):
            raise
        version = None
    stored, version = fetch(client, profile, object_key, version)
    if data != stored:
        raise ValueError("Existing escrow object differs from the protected snapshot")
    return version


def upload(client, profile, snapshot):
    source = binding(snapshot)
    cipher = base64.b64decode(snapshot["ciphertext"], validate=True)
    if not cipher.startswith(b"age-encryption.org/v1\n") or len(cipher) > 65536:
        raise ValueError("Invalid age envelope")
    version = put_once(client, profile, key(profile, source, "envelopes"), cipher)
    return {"format": RECEIPT, **source, "destination": location(profile), "versionId": version, "sha256": sha(cipher)}


def read_envelope(client, profile, receipt):
    source = binding(receipt)
    if (set(receipt) != {*source, "format", "destination", "versionId", "sha256"} or receipt["format"] != RECEIPT
            or receipt["destination"] != location(profile) or not HEX.fullmatch(receipt["sha256"])):
        raise ValueError("Invalid or misdirected bootstrap receipt")
    cipher, _ = fetch(client, profile, key(profile, source, "envelopes"), receipt["versionId"])
    if sha(cipher) != receipt["sha256"]:
        raise ValueError("Bootstrap escrow readback digest mismatch")
    return cipher


def write_secrets(destination, secrets):
    # Recovery only prepares private input files; it cannot access or mutate a live Podman store.
    private_dir(destination.parent)
    parent_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Serialize concurrent local restore attempts and publish only a complete directory.
        fcntl.flock(parent_fd, fcntl.LOCK_EX)
        if os.path.lexists(destination):
            raise FileExistsError("Private recovery destination already exists")
        with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".bootstrap-restore-") as temporary:
            prepared = Path(temporary) / "credentials"
            prepared.mkdir(mode=0o700)
            for name, value in secrets.items():
                with (prepared / name).open("xb") as output:
                    os.fchmod(output.fileno(), 0o600)
                    output.write(value.encode())
                    output.flush()
                    os.fsync(output.fileno())
            os.rename(prepared, destination)
            os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def identity_recipient(identity):
    identity_stat = identity.lstat()
    if (not stat.S_ISREG(identity_stat.st_mode) or identity_stat.st_uid != os.getuid()
            or stat.S_IMODE(identity_stat.st_mode) not in (0o400, 0o600)):
        raise ValueError("Age identity must be a private regular file owned by the recovery user")
    return subprocess.run(["age-keygen", "-y", str(identity)], check=True, capture_output=True).stdout.decode().strip()


def recover_files(client, profile, receipt, identity, destination=None):
    source = binding(receipt)
    encrypted = read_envelope(client, profile, receipt)
    recipient = identity_recipient(identity)
    if recipient != source["recipient"]:
        raise ValueError("Independent recovery identity differs from the bootstrap recipient")
    plaintext = subprocess.run(["age", "-d", "-i", str(identity)], input=encrypted, check=True, capture_output=True).stdout
    data = json.loads(plaintext)
    validate_payload(data)
    if (sha(plaintext) != source["generation"] or data["hostId"] != source["hostId"]
            or data["recipient"] != recipient or canonical(data) != plaintext):
        raise ValueError("Recovered credential set differs from the production snapshot")
    # Exercise the actual restoration writer even on a drill. Persist only through --output-dir.
    if destination is None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "secrets"
            write_secrets(target, data["secrets"])
            if {f.name: f.read_bytes() for f in target.iterdir()} != {k: v.encode() for k, v in data["secrets"].items()}:
                raise ValueError("Restored files differ from the decrypted credential set")
    else:
        write_secrets(destination, data["secrets"])


def recover(client, profile, receipt, identity, destination=None):
    recover_files(client, profile, receipt, identity, destination)
    proof = canonical({"format": VERIFIED, "receipt": receipt})
    put_once(client, profile, key(profile, binding(receipt), "verified"), proof)


def verified_receipt(client, profile, snapshot):
    source = binding(snapshot)
    raw, _ = fetch(client, profile, key(profile, source, "verified"))
    proof = json.loads(raw)
    if set(proof) != {"format", "receipt"} or proof["format"] != VERIFIED or binding(proof["receipt"]) != source:
        raise ValueError("Independent restore proof differs from current VM secrets")
    return proof["receipt"]


def check(client, profile, snapshot):
    read_envelope(client, profile, verified_receipt(client, profile, snapshot))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    ops = parser.add_subparsers(dest="operation", required=True)
    upload_args = ops.add_parser("upload")
    upload_args.add_argument("--receipt", type=Path, required=True)
    ops.add_parser("check")
    restore = ops.add_parser("recover")
    restore.add_argument("--receipt", type=Path, required=True)
    restore.add_argument("--identity", type=Path, required=True)
    restore.add_argument("--output-dir", type=Path)
    files = ops.add_parser("restore", help="recover files using a previously verified proof, with read-only S3 access")
    files.add_argument("--host-id", required=True)
    files.add_argument("--generation", required=True)
    files.add_argument("--identity", type=Path, required=True)
    files.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        profile = validate_profile(json.loads(os.environ["CODEXIA_BOOTSTRAP_ESCROW_PROFILE"]))
        credential = json.loads(os.environ["CODEXIA_BOOTSTRAP_ESCROW_CREDENTIAL"])
        if not isinstance(credential, dict) or not credential.get("accessKeyId") or not credential.get("secretAccessKey"):
            raise ValueError("Protected credential required")
        client = _make_client(profile, credential=credential)
        if args.operation == "recover":
            recover(client, profile, json.loads(args.receipt.read_bytes()), args.identity, args.output_dir)
        elif args.operation == "restore":
            snapshot = {"hostId": args.host_id, "generation": args.generation, "recipient": identity_recipient(args.identity)}
            receipt = verified_receipt(client, profile, snapshot)
            recover_files(client, profile, receipt, args.identity, args.output_dir)
        else:
            snapshot = json.loads(sys.stdin.buffer.read(1024 * 128))
            if snapshot["hostId"] != os.environ["CODEXIA_BOOTSTRAP_ESCROW_HOST_ID"] or snapshot["recipient"] != os.environ["CODEXIA_BOOTSTRAP_ESCROW_RECIPIENT"]:
                raise ValueError("Escrow target differs from the admitted host")
            if args.operation == "upload":
                receipt = upload(client, profile, snapshot)
                private_dir(args.receipt.parent)
                with args.receipt.open("xb") as out:
                    out.write(canonical(receipt))
            else:
                check(client, profile, snapshot)
        return 0
    except Exception:
        # SDK, age and input parser diagnostics may contain credentials or endpoints.
        print(f"Bootstrap escrow {args.operation} failed; recovery evidence was not accepted.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
