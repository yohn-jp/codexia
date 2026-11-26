#!/usr/bin/env python3
"""S3 transport for existing Codexia age v2 backup directories.

This module only moves fixed, already encrypted backup files. It is not a
backup producer and never restores a live database. The external receipt is
written outside the object store so a later isolated drill can compare the
store's commit marker and bytes with an independently protected record.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import sys
import tempfile
from typing import Any, BinaryIO
from urllib.parse import urlsplit


ARTIFACT_FILES = ("database.dump.age", "history.tar.age", "manifest.age")
OBJECT_FILES = (*ARTIFACT_FILES, "SHA256SUMS")
PROFILE_FIELDS = {
    "schemaVersion", "provider", "region", "bucket", "prefix", "endpointUrl",
    "allowedOrigins", "addressingStyle", "multipartThresholdBytes",
    "multipartPartBytes", "retentionMode", "retentionDays", "caBundle", "allowedPrivateAddresses",
}
BACKUP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SOURCE_ID_RE = re.compile(r"^[a-f0-9]{40}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9+/=_-]{1,2048}$")
MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024
DEFAULT_MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024
DEFAULT_MULTIPART_PART_BYTES = 8 * 1024 * 1024
MAX_COMMIT_MARKER_BYTES = 64 * 1024
PRIVATE_IPV4_NETWORKS = tuple(ipaddress.ip_network(cidr) for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


class TransferError(Exception):
    """A deliberately redacted, operator-safe transfer failure."""


def _transfer_failure(error: BaseException) -> tuple[str, bool]:
    current: BaseException | None = error
    while current is not None:
        code = _error_code(current)
        if code in ("AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken"):
            return "credentials_unavailable", False
        if code in ("SlowDown", "RequestTimeout", "ServiceUnavailable", "InternalError", "Throttling", "ThrottlingException"):
            return "s3_unavailable", True
        name = type(current).__name__
        if name in ("EndpointConnectionError", "ConnectTimeoutError", "ReadTimeoutError", "ConnectionClosedError", "ConnectionResetError", "TimeoutError") or isinstance(current, (TimeoutError, socket.timeout, ConnectionError)):
            return "s3_unavailable", True
        response = getattr(current, "response", None)
        metadata = response.get("ResponseMetadata") if isinstance(response, dict) else None
        status = metadata.get("HTTPStatusCode") if isinstance(metadata, dict) else None
        if isinstance(status, int) and (status == 429 or status >= 500):
            return "s3_unavailable", True
        current = current.__cause__
    return "transfer_failed", False


def _fail(message: str) -> None:
    raise TransferError(message)


def validate_private_addresses(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        _fail("S3 private address policy is invalid")
    addresses: list[str] = []
    for raw in value:
        try:
            if not isinstance(raw, str):
                _fail("S3 private address policy is invalid")
            address = ipaddress.ip_address(raw)
        except ValueError as error:
            raise TransferError("S3 private address policy is invalid") from error
        if address.version != 4 or not any(address in network for network in PRIVATE_IPV4_NETWORKS) or address.compressed in addresses:
            _fail("S3 private address policy is invalid")
        addresses.append(address.compressed)
    return tuple(addresses)


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("JSON contains a duplicate object key")
        result[key] = value
    return result


def _read_json(path: Path, *, require_private_file: bool = False) -> dict[str, Any]:
    try:
        file_stat = path.lstat()
    except OSError as error:
        raise TransferError("Cannot inspect the selected JSON file") from error
    if not stat.S_ISREG(file_stat.st_mode) or stat.S_ISLNK(file_stat.st_mode):
        _fail("The selected JSON file must be a regular file without symlinks")
    if require_private_file and (
        file_stat.st_uid != os.getuid() or stat.S_IMODE(file_stat.st_mode) not in (0o400, 0o600)
    ):
        _fail("The selected JSON file must be owned by the current user and mode 0400 or 0600")
    try:
        raw = path.read_text(encoding="utf-8")
        value = json.loads(raw, object_pairs_hook=_strict_object)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise TransferError("Cannot read the selected JSON file") from error
    if not isinstance(value, dict):
        _fail("The selected JSON file must contain an object")
    return value


def _origin(url: str) -> str:
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            _fail("S3 endpoints must use an allowlisted HTTPS origin")
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            _fail("S3 endpoints cannot include a path, query, or fragment")
        port = parsed.port
    except ValueError as error:
        raise TransferError("Invalid S3 endpoint origin") from error
    host = parsed.hostname.lower()
    if not re.fullmatch(r"[a-z0-9.-]+", host) or host.startswith(".") or host.endswith(".") or ".." in host:
        _fail("Invalid S3 endpoint hostname")
    return f"https://{host}" + (f":{port}" if port not in (None, 443) else "")


def _request_origin(url: str) -> str:
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            _fail("S3 SDK requests must use an HTTPS origin")
        if parsed.fragment:
            _fail("S3 SDK requests cannot include a fragment")
        port = parsed.port
    except ValueError as error:
        raise TransferError("Invalid S3 request origin") from error
    host = parsed.hostname.lower()
    return f"https://{host}" + (f":{port}" if port not in (None, 443) else "")


def validate_profile(value: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - PROFILE_FIELDS:
        _fail("S3 profile has unsupported fields")
    if value.get("schemaVersion") != 1:
        _fail("Unsupported S3 profile version")
    provider = value.get("provider")
    if provider not in ("aws-s3", "s3-compatible"):
        _fail("Unsupported S3 provider")
    region = value.get("region")
    if not isinstance(region, str) or not re.fullmatch(r"[a-z0-9-]{3,64}", region):
        _fail("Invalid S3 region")
    bucket = value.get("bucket")
    if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        _fail("Invalid S3 bucket name")
    if re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", bucket):
        _fail("IP-address-style bucket names are unsupported")
    prefix = value.get("prefix")
    if not isinstance(prefix, str) or not prefix or prefix.startswith("/") or prefix.endswith("/"):
        _fail("S3 prefix must be a nonempty relative object prefix")
    prefix_parts = prefix.split("/")
    if any(part in ("", ".", "..") or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", part) for part in prefix_parts):
        _fail("S3 prefix contains an unsafe path component")
    addressing = value.get("addressingStyle", "virtual")
    if addressing not in ("virtual", "path"):
        _fail("Unsupported S3 addressing style")
    if provider == "s3-compatible":
        endpoint = value.get("endpointUrl")
        allowed = value.get("allowedOrigins")
        if not isinstance(endpoint, str) or not isinstance(allowed, list) or not allowed:
            _fail("Compatible S3 profiles require an endpoint and exact-origin allowlist")
        endpoint_origin = _origin(endpoint)
        allowed_origins: list[str] = []
        for item in allowed:
            if not isinstance(item, str):
                _fail("S3 endpoint allowlist entries must be HTTPS origins")
            allowed_origins.append(_origin(item))
        if endpoint_origin not in allowed_origins or len(set(allowed_origins)) != len(allowed_origins):
            _fail("S3 endpoint is not present exactly once in its origin allowlist")
        if addressing == "virtual":
            _fail("Compatible S3 endpoints must use path-style addressing")
        value = dict(value)
        value["endpointUrl"] = endpoint_origin
        value["allowedOrigins"] = allowed_origins
    else:
        if value.get("endpointUrl") is not None or value.get("allowedOrigins", []) not in ([], None):
            _fail("AWS S3 endpoints are derived from the selected AWS region")
        if addressing != "virtual":
            _fail("AWS S3 profiles use virtual-hosted addressing")
        value = dict(value)
        value["endpointUrl"] = None
        value["allowedOrigins"] = []
    threshold = value.get("multipartThresholdBytes", DEFAULT_MULTIPART_THRESHOLD_BYTES)
    part_size = value.get("multipartPartBytes", DEFAULT_MULTIPART_PART_BYTES)
    for number, name in ((threshold, "multipart threshold"), (part_size, "multipart part size")):
        if not isinstance(number, int) or isinstance(number, bool) or number < MIN_MULTIPART_PART_BYTES or number > 5 * 1024 * 1024 * 1024:
            _fail(f"Invalid S3 {name}")
    retention_mode = value.get("retentionMode")
    retention_days = value.get("retentionDays")
    if (retention_mode is None) != (retention_days is None):
        _fail("S3 retention mode and days must be configured together")
    if retention_mode is not None and retention_mode not in ("GOVERNANCE", "COMPLIANCE"):
        _fail("Unsupported S3 retention mode")
    if retention_days is not None and (
        not isinstance(retention_days, int) or isinstance(retention_days, bool) or not 1 <= retention_days <= 3650
    ):
        _fail("Invalid S3 retention period")
    ca_bundle = value.get("caBundle")
    if ca_bundle is not None and (not isinstance(ca_bundle, str) or not os.path.isabs(ca_bundle)):
        _fail("S3 CA bundle path must be absolute")
    value["addressingStyle"] = addressing
    value["allowedPrivateAddresses"] = list(validate_private_addresses(value.get("allowedPrivateAddresses", [])))
    value["multipartThresholdBytes"] = threshold
    value["multipartPartBytes"] = part_size
    return value


def load_profile(path: Path) -> dict[str, Any]:
    return validate_profile(_read_json(path, require_private_file=True))


def _sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), size


def validate_artifact(directory: Path) -> dict[str, Any]:
    try:
        directory_stat = directory.lstat()
    except OSError as error:
        raise TransferError("Cannot inspect the selected backup artifact") from error
    if not stat.S_ISDIR(directory_stat.st_mode) or stat.S_ISLNK(directory_stat.st_mode):
        _fail("Backup artifact directory must be a real directory without symlinks")
    for name in OBJECT_FILES:
        try:
            file_stat = (directory / name).lstat()
        except OSError as error:
            raise TransferError("Backup artifact is incomplete") from error
        if not stat.S_ISREG(file_stat.st_mode) or stat.S_ISLNK(file_stat.st_mode):
            _fail("Backup artifact contains an unsafe file")
    try:
        sums_bytes = (directory / "SHA256SUMS").read_bytes()
    except OSError as error:
        raise TransferError("Backup checksum manifest cannot be read") from error
    files: dict[str, dict[str, Any]] = {}
    canonical_sums = []
    for name in ARTIFACT_FILES:
        digest, size = _sha256_file(directory / name)
        files[name] = {"sha256": digest, "size": size}
        canonical_sums.append(f"{digest}  {name}\n")
    # The restore drill compares raw sha256sum output in this same fixed order.
    if sums_bytes != "".join(canonical_sums).encode("ascii"):
        _fail("Backup ciphertext checksum mismatch")
    sums_digest = hashlib.sha256(sums_bytes).hexdigest()
    files["SHA256SUMS"] = {"sha256": sums_digest, "size": len(sums_bytes)}
    return {"files": files, "sha256sumsSha256": sums_digest}


def _safe_parent(path: Path, *, require_private: bool = True) -> Path:
    parent = path
    try:
        parent_stat = parent.lstat()
    except OSError as error:
        raise TransferError("Selected protected directory is unavailable") from error
    if not stat.S_ISDIR(parent_stat.st_mode) or stat.S_ISLNK(parent_stat.st_mode):
        _fail("Selected protected path must be a real directory without symlinks")
    if require_private and (
        parent_stat.st_uid != os.getuid() or stat.S_IMODE(parent_stat.st_mode) & 0o077
    ):
        _fail("Selected protected directory must be owned by the current user and private")
    return parent


def _write_receipt(path: Path, value: dict[str, Any]) -> dict[str, Any]:
    _safe_parent(path.parent)
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
    try:
        existing = path.lstat()
    except FileNotFoundError:
        existing = None
    except OSError as error:
        raise TransferError("Cannot inspect the external receipt path") from error
    if existing is not None:
        if not stat.S_ISREG(existing.st_mode) or stat.S_ISLNK(existing.st_mode) or existing.st_uid != os.getuid() or stat.S_IMODE(existing.st_mode) not in (0o400, 0o600):
            _fail("Existing external receipt is not a protected regular file")
        prior = _read_json(path, require_private_file=True)
        for field in (
            "format", "backupId", "sourceIdentity", "bucket", "prefix",
            "markerKey", "markerSha256", "markerVersionId", "objects",
        ):
            if prior.get(field) != value.get(field):
                _fail("Existing external receipt conflicts with this backup ID")
        return prior
    fd = -1
    temporary: Path | None = None
    try:
        fd, temporary_name = tempfile.mkstemp(prefix=".receipt-", dir=path.parent)
        temporary = Path(temporary_name)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb", closefd=True) as stream:
            fd = -1
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            return _write_receipt(path, value)
        dir_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError as error:
        raise TransferError("Cannot persist the external backup receipt") from error
    finally:
        if fd >= 0:
            os.close(fd)
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
    return value


def _safe_identifier(value: str, pattern: re.Pattern[str], name: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value) or ".." in value:
        _fail(f"Invalid {name}")
    return value


def _object_key(profile: dict[str, Any], source_identity: str, backup_id: str, name: str) -> str:
    return f"{profile['prefix']}/{source_identity}/{backup_id}/{name}"


def _error_code(error: BaseException) -> str | None:
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        details = response.get("Error")
        if isinstance(details, dict) and isinstance(details.get("Code"), str):
            return details["Code"]
        metadata = response.get("ResponseMetadata")
        if isinstance(metadata, dict) and metadata.get("HTTPStatusCode") == 404:
            return "404"
    return None


def _not_found(error: BaseException) -> bool:
    return _error_code(error) in (
        "404", "NoSuchKey", "NoSuchUpload", "NotFound",
        "ObjectLockConfigurationNotFoundError", "NoSuchObjectLockConfiguration",
    )


def _upload_journal_path(receipt_path: Path, backup_id: str) -> Path:
    return receipt_path.parent / f".codexia-{backup_id}.multipart.json"


def _read_upload_journal(path: Path, backup_id: str, source_identity: str) -> dict[str, str]:
    try:
        path.lstat()
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise TransferError("Cannot inspect protected multipart state") from error
    value = _read_json(path, require_private_file=True)
    if (
        value.get("format") != "codexia-s3-multipart-journal/v1"
        or value.get("backupId") != backup_id
        or value.get("sourceIdentity") != source_identity
        or not isinstance(value.get("pending"), dict)
    ):
        _fail("Protected multipart state is invalid")
    pending = value["pending"]
    for key, upload_id in pending.items():
        if (
            not isinstance(key, str)
            or not key
            or len(key) > 2048
            or not isinstance(upload_id, str)
            or not UPLOAD_ID_RE.fullmatch(upload_id)
        ):
            _fail("Protected multipart state is invalid")
    return pending


def _write_upload_journal(path: Path, backup_id: str, source_identity: str, pending: dict[str, str]) -> None:
    _safe_parent(path.parent)
    if not pending:
        try:
            existing = path.lstat()
        except FileNotFoundError:
            return
        except OSError as error:
            raise TransferError("Cannot inspect protected multipart state") from error
        if (
            not stat.S_ISREG(existing.st_mode)
            or stat.S_ISLNK(existing.st_mode)
            or existing.st_uid != os.getuid()
            or stat.S_IMODE(existing.st_mode) not in (0o400, 0o600)
        ):
            _fail("Protected multipart state is not a private regular file")
        try:
            path.unlink()
            dir_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError as error:
            raise TransferError("Cannot clear protected multipart state") from error
        return

    encoded = (
        json.dumps(
            {
                "format": "codexia-s3-multipart-journal/v1",
                "backupId": backup_id,
                "sourceIdentity": source_identity,
                "pending": pending,
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )
        + "\n"
    ).encode("ascii")
    fd = -1
    temporary: Path | None = None
    try:
        fd, temporary_name = tempfile.mkstemp(prefix=".multipart-", dir=path.parent)
        temporary = Path(temporary_name)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb", closefd=True) as stream:
            fd = -1
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            existing = path.lstat()
        except FileNotFoundError:
            existing = None
        if existing is not None and (
            not stat.S_ISREG(existing.st_mode)
            or stat.S_ISLNK(existing.st_mode)
            or existing.st_uid != os.getuid()
            or stat.S_IMODE(existing.st_mode) not in (0o400, 0o600)
        ):
            _fail("Protected multipart state is not a private regular file")
        os.replace(temporary, path)
        temporary = None
        dir_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except TransferError:
        raise
    except OSError as error:
        raise TransferError("Cannot persist protected multipart state") from error
    finally:
        if fd >= 0:
            os.close(fd)
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _read_stream(body: BinaryIO, *, output: BinaryIO | None = None) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    try:
        while chunk := body.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
            if output is not None:
                output.write(chunk)
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()
    return digest.hexdigest(), size


def _encode_commit_marker(value: dict[str, Any]) -> bytes:
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
    if len(encoded) > MAX_COMMIT_MARKER_BYTES:
        _fail("S3 commit marker exceeds the supported format size")
    return encoded


def _read_commit_marker(response: dict[str, Any]) -> bytes:
    body = response.get("Body")
    if body is None:
        _fail("S3 commit marker response has no body")
    try:
        content_length = response.get("ContentLength")
        if content_length is not None and (
            not isinstance(content_length, int)
            or isinstance(content_length, bool)
            or content_length < 0
            or content_length > MAX_COMMIT_MARKER_BYTES
        ):
            _fail("S3 commit marker exceeds the supported format size")
        marker_bytes = body.read(MAX_COMMIT_MARKER_BYTES + 1)
        if not isinstance(marker_bytes, bytes) or len(marker_bytes) > MAX_COMMIT_MARKER_BYTES:
            _fail("S3 commit marker exceeds the supported format size")
        if content_length is not None and len(marker_bytes) != content_length:
            _fail("S3 commit marker size differs from its declared content length")
        return marker_bytes
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()


class S3BackupTransfer:
    def __init__(
        self,
        profile: dict[str, Any],
        *,
        client: Any | None = None,
        credential: dict[str, str] | None = None,
        _allow_private_test_addresses: bool = False,
    ):
        self.profile = validate_profile(profile)
        self.client = client if client is not None else _make_client(
            self.profile, _allow_private_test_addresses=_allow_private_test_addresses, credential=credential
        )

    def _load_pending_uploads(
        self, journal_path: Path, backup_id: str, source_identity: str
    ) -> dict[str, str]:
        pending = _read_upload_journal(journal_path, backup_id, source_identity)
        allowed_keys = {
            _object_key(self.profile, source_identity, backup_id, name) for name in OBJECT_FILES
        }
        if not set(pending).issubset(allowed_keys):
            _fail("Protected multipart state identifies an unexpected object")
        return pending

    def _clear_pending_upload(
        self, journal_path: Path, backup_id: str, source_identity: str, key: str
    ) -> None:
        pending = self._load_pending_uploads(journal_path, backup_id, source_identity)
        pending.pop(key, None)
        _write_upload_journal(journal_path, backup_id, source_identity, pending)

    def _abort_pending_upload(
        self, journal_path: Path, backup_id: str, source_identity: str, key: str
    ) -> None:
        pending = self._load_pending_uploads(journal_path, backup_id, source_identity)
        upload_id = pending.get(key)
        if upload_id is None:
            return
        try:
            self.client.abort_multipart_upload(
                Bucket=self.profile["bucket"], Key=key, UploadId=upload_id
            )
        except Exception as error:
            if not _not_found(error):
                raise TransferError("S3 multipart cleanup could not be confirmed") from error
        pending.pop(key, None)
        _write_upload_journal(journal_path, backup_id, source_identity, pending)

    def _head(self, key: str) -> dict[str, Any] | None:
        try:
            return self.client.head_object(Bucket=self.profile["bucket"], Key=key)
        except Exception as error:
            if _not_found(error):
                return None
            raise TransferError("S3 object inspection failed") from error

    def _get_verified(
        self, key: str, expected: dict[str, Any], *,
        version_id: str | None, retention: dict[str, Any],
    ) -> None:
        if retention and (not isinstance(version_id, str) or version_id in ("", "null")):
            _fail("S3 object retention requires a unique version ID")
        request: dict[str, Any] = {"Bucket": self.profile["bucket"], "Key": key}
        if version_id:
            request["VersionId"] = version_id
        try:
            response = self.client.get_object(**request)
            if response.get("ContentLength") != expected["size"]:
                body = response.get("Body")
                if body is not None:
                    body.close()
                _fail("S3 object size differs from its protected digest receipt")
            digest, size = _read_stream(response["Body"])
        except TransferError:
            raise
        except Exception as error:
            raise TransferError("S3 object retrieval failed") from error
        if size != expected["size"] or digest != expected["sha256"]:
            _fail("S3 object SHA-256 differs from its protected digest receipt")
        if retention:
            retain_until = response.get("ObjectLockRetainUntilDate")
            if (
                response.get("VersionId") != version_id
                or response.get("ObjectLockMode") != retention["ObjectLockMode"]
                or not isinstance(retain_until, datetime)
                or retain_until.utcoffset() is None
                or retain_until < retention["ObjectLockRetainUntilDate"]
                or retain_until <= datetime.now(timezone.utc)
            ):
                _fail("S3 object retention did not match the requested mode and date on the selected version")

    def _inspect_capabilities(self) -> dict[str, Any]:
        try:
            versioning = self.client.get_bucket_versioning(Bucket=self.profile["bucket"])
            versioning_status = versioning.get("Status", "Disabled")
        except Exception:
            versioning_status = "Unknown"
        try:
            lock_config = self.client.get_object_lock_configuration(Bucket=self.profile["bucket"])
            lock_configuration = lock_config.get("ObjectLockConfiguration", {})
            lock_enabled = lock_configuration.get("ObjectLockEnabled") == "Enabled"
            default_retention = lock_configuration.get("Rule", {}).get("DefaultRetention")
            lock_supported = True
        except Exception as error:
            code = _error_code(error)
            if code in ("NotImplemented", "NotSupported", "501"):
                lock_supported, lock_enabled, default_retention = False, False, None
            elif code in ("ObjectLockConfigurationNotFoundError", "NoSuchObjectLockConfiguration", "404"):
                lock_supported, lock_enabled, default_retention = True, False, None
            else:
                lock_supported, lock_enabled, default_retention = None, None, None
        retention_mode = self.profile.get("retentionMode")
        retention_days = self.profile.get("retentionDays")
        if retention_mode is not None and (
            versioning_status != "Enabled" or lock_supported is not True or lock_enabled is not True
        ):
            _fail("Requested S3 retention is not enabled on the selected bucket")
        if retention_mode is not None and isinstance(default_retention, dict):
            effective_mode = default_retention.get("Mode")
            effective_days = default_retention.get("Days")
            if effective_mode and effective_mode != retention_mode:
                _fail("S3 bucket default retention conflicts with the requested retention mode")
            if effective_days is not None and effective_days < retention_days:
                _fail("S3 bucket default retention is shorter than requested")
        return {
            "versioning": versioning_status,
            "objectLockSupported": lock_supported,
            "objectLockEnabled": lock_enabled,
            "defaultRetention": default_retention,
            "requestedRetention": None if retention_mode is None else {"mode": retention_mode, "days": retention_days},
        }

    def _retention_args(self, backup_id: str) -> dict[str, Any]:
        mode = self.profile.get("retentionMode")
        days = self.profile.get("retentionDays")
        if mode is None or days is None:
            return {}
        match = re.match(r"^(\d{8}T\d{6}Z)-", backup_id)
        if not match:
            _fail("Retention requires a timestamped backup ID")
        try:
            created = datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise TransferError("Retention requires a valid backup timestamp") from error
        retain_until = created + timedelta(days=days)
        if retain_until <= datetime.now(timezone.utc):
            _fail("Requested retention date has already elapsed")
        return {"ObjectLockMode": mode, "ObjectLockRetainUntilDate": retain_until}

    def _upload_one(
        self,
        directory: Path,
        name: str,
        key: str,
        expected: dict[str, Any],
        backup_id: str,
        source_identity: str,
        journal_path: Path,
        retention: dict[str, Any],
    ) -> dict[str, Any]:
        current = self._head(key)
        if current is not None:
            version_id = current.get("VersionId")
            self._get_verified(key, expected, version_id=version_id, retention=retention)
            self._abort_pending_upload(journal_path, backup_id, source_identity, key)
            return {"key": key, **expected, "versionId": version_id}
        path = directory / name
        metadata = {"codexia-sha256": expected["sha256"], "codexia-backup-id": backup_id}
        if expected["size"] < self.profile["multipartThresholdBytes"]:
            try:
                with path.open("rb") as stream:
                    result = self.client.put_object(
                        Bucket=self.profile["bucket"], Key=key, Body=stream,
                        ContentLength=expected["size"], ContentType="application/octet-stream",
                        Metadata=metadata, IfNoneMatch="*", **retention,
                    )
            except Exception as error:
                if _error_code(error) not in ("PreconditionFailed", "412", "ConditionalRequestConflict"):
                    raise TransferError("S3 object upload failed") from error
                current = self._head(key)
                if current is None:
                    raise TransferError("S3 object upload conflict could not be inspected") from error
                version_id = current.get("VersionId")
                self._get_verified(key, expected, version_id=version_id, retention=retention)
                return {"key": key, **expected, "versionId": version_id}
            version_id = result.get("VersionId")
        else:
            self._abort_pending_upload(journal_path, backup_id, source_identity, key)
            upload_id: str | None = None
            try:
                created = self.client.create_multipart_upload(
                    Bucket=self.profile["bucket"], Key=key, ContentType="application/octet-stream",
                    Metadata=metadata, **retention,
                )
                upload_id = created.get("UploadId")
                if not isinstance(upload_id, str) or not UPLOAD_ID_RE.fullmatch(upload_id):
                    upload_id = None
                    _fail("S3 returned an invalid multipart upload identity")
                pending = self._load_pending_uploads(journal_path, backup_id, source_identity)
                pending[key] = upload_id
                try:
                    _write_upload_journal(journal_path, backup_id, source_identity, pending)
                except Exception as error:
                    try:
                        self.client.abort_multipart_upload(
                            Bucket=self.profile["bucket"], Key=key, UploadId=upload_id
                        )
                    except Exception as cleanup_error:
                        raise TransferError("S3 multipart upload state could not be persisted or cleaned up") from cleanup_error
                    raise TransferError("Cannot persist protected multipart state") from error
                parts: list[dict[str, Any]] = []
                part_number = 1
                with path.open("rb") as stream:
                    while chunk := stream.read(self.profile["multipartPartBytes"]):
                        uploaded = self.client.upload_part(
                            Bucket=self.profile["bucket"], Key=key, UploadId=upload_id,
                            PartNumber=part_number, Body=chunk,
                        )
                        parts.append({"PartNumber": part_number, "ETag": uploaded["ETag"]})
                        part_number += 1
                completed = self.client.complete_multipart_upload(
                    Bucket=self.profile["bucket"], Key=key, UploadId=upload_id,
                    MultipartUpload={"Parts": parts}, IfNoneMatch="*",
                )
                upload_id = None
                self._clear_pending_upload(journal_path, backup_id, source_identity, key)
                version_id = completed.get("VersionId")
            except Exception as error:
                if upload_id is not None:
                    try:
                        self.client.abort_multipart_upload(
                            Bucket=self.profile["bucket"], Key=key, UploadId=upload_id
                        )
                    except Exception as cleanup_error:
                        if _not_found(cleanup_error):
                            self._clear_pending_upload(journal_path, backup_id, source_identity, key)
                        else:
                            raise TransferError("S3 multipart upload failed and cleanup could not be confirmed") from cleanup_error
                    else:
                        self._clear_pending_upload(journal_path, backup_id, source_identity, key)
                if _error_code(error) in ("PreconditionFailed", "412", "ConditionalRequestConflict"):
                    current = self._head(key)
                    if current is not None:
                        current_version = current.get("VersionId")
                        self._get_verified(key, expected, version_id=current_version, retention=retention)
                        return {"key": key, **expected, "versionId": current_version}
                if isinstance(error, TransferError):
                    raise
                raise TransferError("S3 multipart upload failed") from error
        self._get_verified(key, expected, version_id=version_id, retention=retention)
        return {"key": key, **expected, "versionId": version_id}

    def _marker_key(self, source_identity: str, backup_id: str) -> str:
        return _object_key(self.profile, source_identity, backup_id, "COMMIT.json")

    def upload_artifact(self, directory: Path, *, backup_id: str, source_identity: str, receipt_path: Path) -> dict[str, Any]:
        backup_id = _safe_identifier(backup_id, BACKUP_ID_RE, "backup ID")
        source_identity = _safe_identifier(source_identity, SOURCE_ID_RE, "source identity")
        inventory = validate_artifact(directory)
        retention = self._retention_args(backup_id)
        capabilities = self._inspect_capabilities()
        _safe_parent(receipt_path.parent)
        receipt_name_digest = hashlib.sha256(os.fsencode(receipt_path.name)).hexdigest()
        pending_path = receipt_path.parent / f".codexia-{backup_id}-{receipt_name_digest}.commit.json"
        prior_receipt = os.path.lexists(receipt_path)
        record_path = receipt_path if prior_receipt else pending_path
        prior = None
        if os.path.lexists(record_path):
            prior = self._validate_receipt(_read_json(record_path, require_private_file=True), backup_id)
            if prior["sourceIdentity"] != source_identity:
                _fail("Protected backup record belongs to a different source identity")
            observed = prior.get("capabilities")
            if not isinstance(observed, dict) or observed.get("requestedRetention") != capabilities["requestedRetention"]:
                _fail("Requested S3 retention differs from the protected backup record")
            # A retry must verify the original marker, even if capability discovery changes.
            capabilities = observed
        journal_path = _upload_journal_path(receipt_path, backup_id)
        object_records: dict[str, Any] = {}
        for name in OBJECT_FILES:
            key = _object_key(self.profile, source_identity, backup_id, name)
            object_records[name] = self._upload_one(
                directory, name, key, inventory["files"][name], backup_id,
                source_identity, journal_path, retention,
            )
        marker_key = self._marker_key(source_identity, backup_id)
        marker = {
            "format": "codexia-s3-commit/v1",
            "backupId": backup_id,
            "sourceIdentity": source_identity,
            "provider": self.profile["provider"],
            "bucket": self.profile["bucket"],
            "prefix": self.profile["prefix"],
            "region": self.profile["region"],
            "endpointOrigin": self.profile.get("endpointUrl"),
            "objects": object_records,
            "sha256sumsSha256": inventory["sha256sumsSha256"],
            "capabilities": capabilities,
        }
        marker_bytes = _encode_commit_marker(marker)
        marker_digest = hashlib.sha256(marker_bytes).hexdigest()
        if prior is not None and prior["markerSha256"] != marker_digest:
            _fail("S3 commit marker differs from the protected backup record")
        receipt = {
            **marker,
            "format": "codexia-backup-receipt/v1",
            "markerKey": marker_key,
            "markerSha256": marker_digest,
            "markerVersionId": None,
        }
        if not prior_receipt:
            # Persist the candidate bytes' identity before the conditional S3 write.
            _write_receipt(pending_path, receipt)
        existing_marker = self._head(marker_key)
        if prior_receipt and existing_marker is None:
            _fail("Existing external receipt conflicts with the missing S3 commit marker")
        if existing_marker is None:
            try:
                result = self.client.put_object(
                    Bucket=self.profile["bucket"], Key=marker_key, Body=marker_bytes,
                    ContentLength=len(marker_bytes), ContentType="application/json",
                    Metadata={"codexia-sha256": marker_digest}, IfNoneMatch="*",
                    **retention,
                )
                marker_version = result.get("VersionId")
            except Exception as error:
                if _error_code(error) not in ("PreconditionFailed", "412", "ConditionalRequestConflict"):
                    raise TransferError("S3 commit marker publication failed") from error
                existing_marker = self._head(marker_key)
                if existing_marker is None:
                    raise TransferError("S3 commit marker race could not be inspected") from error
                marker_version = existing_marker.get("VersionId")
        else:
            marker_version = existing_marker.get("VersionId")
        self._get_verified(
            marker_key, {"sha256": marker_digest, "size": len(marker_bytes)},
            version_id=marker_version, retention=retention,
        )
        receipt["markerVersionId"] = marker_version
        receipt["verifiedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        receipt["verifiedByUid"] = os.getuid()
        verified_receipt = _write_receipt(receipt_path, receipt)
        pending_path.unlink(missing_ok=True)
        return verified_receipt

    def _validate_receipt(self, value: dict[str, Any], backup_id: str) -> dict[str, Any]:
        if value.get("format") != "codexia-backup-receipt/v1" or value.get("backupId") != backup_id:
            _fail("External receipt does not identify the selected backup")
        if value.get("provider") != self.profile["provider"] or value.get("bucket") != self.profile["bucket"] or value.get("prefix") != self.profile["prefix"]:
            _fail("External receipt does not match the selected S3 profile")
        if value.get("region") != self.profile["region"] or value.get("endpointOrigin") != self.profile.get("endpointUrl"):
            _fail("External receipt does not match the selected S3 endpoint")
        source_identity = _safe_identifier(value.get("sourceIdentity"), SOURCE_ID_RE, "receipt source identity")
        expected_marker_key = self._marker_key(source_identity, backup_id)
        if value.get("markerKey") != expected_marker_key or not SHA256_RE.fullmatch(str(value.get("markerSha256", ""))):
            _fail("External receipt contains an invalid commit marker identity")
        objects = value.get("objects")
        if not isinstance(objects, dict) or set(objects) != set(OBJECT_FILES):
            _fail("External receipt does not identify the exact backup artifact set")
        for name in OBJECT_FILES:
            record = objects[name]
            expected_key = _object_key(self.profile, source_identity, backup_id, name)
            if not isinstance(record, dict) or record.get("key") != expected_key or not SHA256_RE.fullmatch(str(record.get("sha256", ""))):
                _fail("External receipt contains an invalid object identity")
            if not isinstance(record.get("size"), int) or record["size"] < 0:
                _fail("External receipt contains an invalid object size")
        return value

    def download_artifact(self, *, backup_id: str, receipt_path: Path, output_dir: Path) -> Path:
        backup_id = _safe_identifier(backup_id, BACKUP_ID_RE, "backup ID")
        receipt = self._validate_receipt(_read_json(receipt_path, require_private_file=True), backup_id)
        _safe_parent(output_dir)
        source_identity = receipt["sourceIdentity"]
        marker_key = receipt["markerKey"]
        try:
            marker_response = self.client.get_object(
                Bucket=self.profile["bucket"], Key=marker_key,
                **({"VersionId": receipt["markerVersionId"]} if receipt.get("markerVersionId") else {}),
            )
            marker_bytes = _read_commit_marker(marker_response)
        except TransferError:
            raise
        except Exception as error:
            raise TransferError("S3 commit marker retrieval failed") from error
        marker_digest = hashlib.sha256(marker_bytes).hexdigest()
        if marker_digest != receipt["markerSha256"]:
            _fail("S3 commit marker differs from the external receipt")
        try:
            marker = json.loads(marker_bytes.decode("ascii"), object_pairs_hook=_strict_object)
        except (UnicodeError, json.JSONDecodeError) as error:
            raise TransferError("S3 commit marker is malformed") from error
        expected_marker = {
            "format": "codexia-s3-commit/v1", "backupId": backup_id,
            "sourceIdentity": source_identity, "provider": self.profile["provider"],
            "bucket": self.profile["bucket"], "prefix": self.profile["prefix"],
            "region": self.profile["region"], "endpointOrigin": self.profile.get("endpointUrl"),
            "objects": receipt["objects"], "sha256sumsSha256": receipt["sha256sumsSha256"],
            "capabilities": receipt["capabilities"],
        }
        if marker != expected_marker:
            _fail("S3 commit marker does not match the external receipt")
        final_path = output_dir / f"codexia-{backup_id}"
        if final_path.exists() or final_path.is_symlink():
            _fail("Downloaded backup destination already exists")
        staging_path = Path(tempfile.mkdtemp(prefix=f".s3-{backup_id}-", dir=output_dir))
        os.chmod(staging_path, 0o700)
        try:
            for name in OBJECT_FILES:
                record = receipt["objects"][name]
                request: dict[str, Any] = {"Bucket": self.profile["bucket"], "Key": record["key"]}
                if record.get("versionId"):
                    request["VersionId"] = record["versionId"]
                try:
                    response = self.client.get_object(**request)
                    destination = staging_path / name
                    fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
                    with os.fdopen(fd, "wb") as stream:
                        digest, size = _read_stream(response["Body"], output=stream)
                        stream.flush()
                        os.fsync(stream.fileno())
                except TransferError:
                    raise
                except Exception as error:
                    raise TransferError("S3 backup object download failed") from error
                if size != record["size"] or digest != record["sha256"]:
                    _fail("Downloaded S3 object differs from the external receipt")
            inventory = validate_artifact(staging_path)
            if inventory["sha256sumsSha256"] != receipt["sha256sumsSha256"]:
                _fail("Downloaded backup checksum manifest differs from the external receipt")
            os.rename(staging_path, final_path)
            dir_fd = os.open(output_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
            return final_path
        except Exception:
            shutil.rmtree(staging_path, ignore_errors=True)
            raise


def _make_client(
    profile: dict[str, Any], *, _allow_private_test_addresses: bool = False,
    credential: dict[str, str] | None = None,
) -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise TransferError("Pinned Boto3 runtime is not installed; run install-s3-runtime.sh") from error
    config = Config(
        signature_version="s3v4",
        proxies={},
        s3={"addressing_style": profile["addressingStyle"]},
        retries={"mode": "standard", "total_max_attempts": 3},
        connect_timeout=5,
        read_timeout=120,
    )
    session_fields = {}
    if credential is not None:
        if set(credential) - {"accessKeyId", "secretAccessKey", "sessionToken"} or not credential.get("accessKeyId") or not credential.get("secretAccessKey"):
            _fail("S3 transfer credential is invalid")
        session_fields = {
            "aws_access_key_id": credential["accessKeyId"],
            "aws_secret_access_key": credential["secretAccessKey"],
            **({"aws_session_token": credential["sessionToken"]} if credential.get("sessionToken") else {}),
        }
    client = boto3.session.Session(**session_fields).client(
        "s3", region_name=profile["region"], endpoint_url=profile.get("endpointUrl"),
        config=config, verify=profile.get("caBundle") or True,
    )
    guard = EndpointGuard(
        profile,
        client.meta.endpoint_url,
        allowed_private_addresses=profile.get("allowedPrivateAddresses", []),
        _allow_private_test_addresses=_allow_private_test_addresses,
    )
    _install_pinned_https_transport(client, guard)
    client.meta.events.register_first("before-send.s3", guard.before_send)
    client.meta.events.register_first("needs-retry.s3", guard.needs_retry)
    return client


def _install_pinned_https_transport(client: Any, guard: "EndpointGuard") -> None:
    """Pin each HTTPS socket to the public DNS answer validated for that connection."""
    try:
        import botocore.awsrequest
        from urllib3.exceptions import ConnectTimeoutError, NewConnectionError
        from urllib3.util import connection

        session = client._endpoint.http_session
        pool_classes = session._pool_classes_by_scheme
        manager = session._manager
        original_https_pool = pool_classes["https"]
        if original_https_pool is not botocore.awsrequest.AWSHTTPSConnectionPool:
            _fail("Pinned Boto3 HTTPS connection pool is unsupported")
    except TransferError:
        raise
    except Exception as error:
        raise TransferError("Pinned Boto3 HTTPS transport is unsupported") from error

    class PinnedAWSHTTPSConnection(botocore.awsrequest.AWSHTTPSConnection):
        endpoint_guard = guard

        def _new_conn(self):
            if self.proxy is not None:
                _fail("S3 endpoint proxies are not supported")
            port = self.port or 443
            addresses = self.endpoint_guard._resolve_public_addresses(self.host, port)
            last_error: OSError | None = None
            for address in addresses:
                try:
                    # The IP literal prevents urllib3 or the OS from resolving the
                    # hostname again. self.host remains the original DNS name for
                    # TLS SNI, certificate verification, and the HTTP Host header.
                    return connection.create_connection(
                        (address, port), self.timeout,
                        source_address=self.source_address,
                        socket_options=self.socket_options,
                    )
                except OSError as error:
                    last_error = error
            if last_error is None:
                _fail("S3 endpoint resolved to no addresses")
            if isinstance(last_error, (TimeoutError, socket.timeout)):
                raise ConnectTimeoutError(
                    self, f"Connection to {self.host} timed out (connect timeout={self.timeout})"
                ) from last_error
            raise NewConnectionError(
                self, f"Failed to connect to validated S3 endpoint address: {last_error}"
            ) from last_error

    class PinnedAWSHTTPSConnectionPool(botocore.awsrequest.AWSHTTPSConnectionPool):
        ConnectionCls = PinnedAWSHTTPSConnection

    pool_classes["https"] = PinnedAWSHTTPSConnectionPool
    manager.pool_classes_by_scheme = pool_classes


class EndpointGuard:
    """Keep AWS SDK requests on the selected HTTPS endpoint, including retries."""

    def __init__(
        self,
        profile: dict[str, Any],
        endpoint_url: str,
        *,
        allowed_private_addresses: list[str] | tuple[str, ...] | None = None,
        _allow_private_test_addresses: bool = False,
    ):
        self.profile = profile
        self.endpoint_url = endpoint_url
        self._allow_private_test_addresses = _allow_private_test_addresses
        self.allowed_private_addresses = set(validate_private_addresses(allowed_private_addresses or ()))
        self.expected = _origin(endpoint_url)

    def _approved_host(self, url: str) -> tuple[str, int]:
        origin = _request_origin(url)
        parsed = urlsplit(url)
        if self.profile["provider"] == "s3-compatible":
            if origin != self.expected or origin not in self.profile["allowedOrigins"]:
                _fail("S3 SDK attempted to contact an origin outside the exact allowlist")
        else:
            host = parsed.hostname or ""
            base_host = urlsplit(self.endpoint_url).hostname or ""
            if host != base_host and not host.endswith("." + base_host):
                _fail("AWS S3 SDK attempted to contact an endpoint outside the selected region")
            if not host.endswith(".amazonaws.com"):
                _fail("AWS S3 endpoint is not an official Amazon HTTPS endpoint")
        port = parsed.port or 443
        return parsed.hostname or "", port

    def _resolve_public_addresses(self, host: str, port: int) -> tuple[str, ...]:
        try:
            results = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as error:
            raise TransferError("S3 endpoint DNS lookup failed") from error
        if not results:
            _fail("S3 endpoint resolved to no addresses")
        addresses: list[str] = []
        for result in results:
            try:
                address = result[4][0]
                if not isinstance(address, str):
                    _fail("S3 endpoint returned an invalid IP address")
                if "%" in address:
                    _fail("S3 endpoint returned a scoped IP address")
                parsed = ipaddress.ip_address(address)
            except (IndexError, TypeError, ValueError) as error:
                raise TransferError("S3 endpoint returned an invalid IP address") from error
            if self.allowed_private_addresses:
                if parsed.compressed not in self.allowed_private_addresses:
                    _fail("S3 endpoint resolved outside its operator-approved private addresses")
            elif not self._allow_private_test_addresses and (not parsed.is_global or parsed.is_multicast):
                _fail("S3 endpoint resolved to a private, local, or reserved address")
            normalized = parsed.compressed
            if normalized not in addresses:
                addresses.append(normalized)
        if self.allowed_private_addresses and set(addresses) != self.allowed_private_addresses:
            _fail("S3 endpoint DNS answer differs from its operator-approved private addresses")
        return tuple(addresses)

    def _check_dns(self, host: str, port: int) -> None:
        self._resolve_public_addresses(host, port)

    def before_send(self, request: Any, **_: Any) -> None:
        host, port = self._approved_host(request.url)
        self._check_dns(host, port)

    def needs_retry(self, response: Any = None, **_: Any) -> bool | None:
        if response:
            http_response = response[0]
            status = getattr(http_response, "status_code", None)
            if isinstance(status, int) and 300 <= status < 400:
                raise TransferError("S3 endpoint redirect was rejected")
        return None


def _command_profile(path: str) -> dict[str, Any]:
    return load_profile(Path(path))


def _cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    upload = subparsers.add_parser("upload", help="upload and verify an existing age v2 artifact")
    upload.add_argument("--profile", required=True)
    upload.add_argument("--artifact-dir", required=True)
    upload.add_argument("--backup-id", required=True)
    upload.add_argument("--source-identity", required=True)
    upload.add_argument("--receipt", required=True)
    upload.add_argument("--credential-stdin", action="store_true")
    upload.add_argument("--machine-result", action="store_true")
    download = subparsers.add_parser("download", help="retrieve only a receipt-verified artifact for an isolated drill")
    download.add_argument("--profile", required=True)
    download.add_argument("--backup-id", required=True)
    download.add_argument("--receipt", required=True)
    download.add_argument("--output-dir", required=True)
    download.add_argument("--credential-stdin", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _cli().parse_args(argv)
    try:
        credential = None
        if args.credential_stdin:
            try:
                credential = json.load(sys.stdin, object_pairs_hook=_strict_object)
            except (UnicodeError, json.JSONDecodeError) as error:
                raise TransferError("S3 transfer credential input is invalid") from error
            if not isinstance(credential, dict):
                raise TransferError("S3 transfer credential input is invalid")
        transfer = S3BackupTransfer(_command_profile(args.profile), credential=credential)
        if args.operation == "upload":
            receipt = transfer.upload_artifact(
                Path(args.artifact_dir), backup_id=args.backup_id,
                source_identity=args.source_identity, receipt_path=Path(args.receipt),
            )
            print(json.dumps({"status": "VERIFIED", "backupId": receipt["backupId"], "markerSha256": receipt["markerSha256"]}, sort_keys=True))
        else:
            path = transfer.download_artifact(
                backup_id=args.backup_id, receipt_path=Path(args.receipt), output_dir=Path(args.output_dir),
            )
            print(json.dumps({"status": "VERIFIED", "backupId": args.backup_id, "artifactDirectory": str(path)}, sort_keys=True))
        return 0
    except TransferError as error:
        if getattr(args, "machine_result", False):
            reason_code, retryable = _transfer_failure(error)
            print(json.dumps({"status": "UNKNOWN" if retryable else "FAILED", "reasonCode": reason_code}, sort_keys=True))
            return 75 if retryable else 1
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
