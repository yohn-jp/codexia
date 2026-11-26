"""Behavior tests for the S3 backup transport; fixtures use synthetic ciphertext only."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


BACKUP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKUP_DIR))
spec = importlib.util.spec_from_file_location("s3_transfer", BACKUP_DIR / "s3_transfer.py")
if spec is None or spec.loader is None:
    raise RuntimeError("Could not load S3 transfer implementation")
s3_transfer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = s3_transfer
spec.loader.exec_module(s3_transfer)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class DefaultProfileTest(unittest.TestCase):
    def test_default_aws_profile_supplies_sdk_addressing_style(self):
        profile = s3_transfer.validate_profile({"schemaVersion": 1, "provider": "aws-s3", "region": "us-east-1",
                                                "bucket": "fixture-bucket", "prefix": "fixture"})
        self.assertEqual(profile["addressingStyle"], "virtual")


class FakeClientError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3Client:
    """Small S3 boundary double. Real service behavior is exercised by s3-fixture.sh."""

    def __init__(self):
        self.objects: dict[tuple[str, str], dict[str, object]] = {}
        self.uploads: dict[str, dict[str, object]] = {}
        self.events: list[tuple[str, str]] = []
        self.fail_upload_part = False
        self.fail_abort_count = 0
        self.deny_list_multipart_uploads = False
        self.fail_commit_marker_once = False
        self.corrupt_readback_for: str | None = None
        self.race_conditional_create = False
        self.race_key: str | None = None
        self.fail_head_code: str | None = None
        self.fail_put_for: str | None = None
        self.fail_get_for: str | None = None

    @staticmethod
    def _body(value: object) -> bytes:
        body = value if hasattr(value, "read") else io.BytesIO(bytes(value))
        return body.read()  # type: ignore[union-attr]

    def head_object(self, *, Bucket: str, Key: str, **_: object) -> dict[str, object]:
        self.events.append(("head", Key))
        if self.fail_head_code:
            raise FakeClientError(self.fail_head_code)
        item = self.objects.get((Bucket, Key))
        if item is None:
            raise FakeClientError("404")
        return {key: item[key] for key in ("ContentLength", "Metadata", "VersionId", "ETag") if key in item}

    def get_object(self, *, Bucket: str, Key: str, **_: object) -> dict[str, object]:
        self.events.append(("get", Key))
        if Key == self.fail_get_for:
            raise OSError("simulated remote read failure containing secret-token")
        item = self.objects.get((Bucket, Key))
        if item is None:
            raise FakeClientError("NoSuchKey")
        body = bytes(item["Body"])
        if Key == self.corrupt_readback_for:
            body += b"tampered"
        return {"Body": io.BytesIO(body), "ContentLength": len(body), "VersionId": item.get("VersionId"), "ETag": '"etag-is-not-sha256"'}

    def put_object(self, *, Bucket: str, Key: str, Body: object, IfNoneMatch: str | None = None, **kwargs: object) -> dict[str, object]:
        self.events.append(("put", Key))
        if Key == self.fail_put_for:
            raise OSError("simulated credential denial containing secret-token")
        if Key.endswith("/COMMIT.json") and self.fail_commit_marker_once:
            self.fail_commit_marker_once = False
            raise OSError("simulated marker write interruption")
        body = self._body(Body)
        if self.race_conditional_create and IfNoneMatch == "*":
            self.race_conditional_create = False
            self.race_key = Key
            self.objects[(Bucket, Key)] = {
                "Body": body,
                "ContentLength": len(body),
                "Metadata": {"race-winner": "preserved"},
                "VersionId": "winner-version",
                "ETag": '"winner-etag"',
            }
        existing = self.objects.get((Bucket, Key))
        if existing and IfNoneMatch == "*":
            raise FakeClientError("412")
        self.objects[(Bucket, Key)] = {
            "Body": body,
            "ContentLength": len(body),
            "Metadata": kwargs.get("Metadata", {}),
            "VersionId": "version-1",
            "ETag": '"etag-is-not-sha256"',
        }
        return {"VersionId": "version-1", "ETag": '"etag-is-not-sha256"'}

    def create_multipart_upload(self, *, Bucket: str, Key: str, **_: object) -> dict[str, str]:
        upload_id = f"upload-{len(self.uploads) + 1}"
        self.uploads[upload_id] = {"Bucket": Bucket, "Key": Key, "Parts": {}}
        self.events.append(("multipart-create", Key))
        return {"UploadId": upload_id}

    def upload_part(self, *, UploadId: str, PartNumber: int, Body: object, **_: object) -> dict[str, str]:
        self.events.append(("multipart-part", str(PartNumber)))
        if self.fail_upload_part:
            raise OSError("simulated multipart interruption")
        upload = self.uploads[UploadId]
        parts = upload["Parts"]
        assert isinstance(parts, dict)
        parts[PartNumber] = self._body(Body)
        return {"ETag": f'"part-{PartNumber}"'}

    def complete_multipart_upload(self, *, Bucket: str, Key: str, UploadId: str, **_: object) -> dict[str, str]:
        upload = self.uploads.pop(UploadId)
        parts = upload["Parts"]
        assert isinstance(parts, dict)
        body = b"".join(bytes(parts[number]) for number in sorted(parts))
        self.objects[(Bucket, Key)] = {
            "Body": body,
            "ContentLength": len(body),
            "Metadata": {},
            "VersionId": "version-1",
            "ETag": '"multipart-etag-not-sha256"',
        }
        self.events.append(("multipart-complete", Key))
        return {"VersionId": "version-1", "ETag": '"multipart-etag-not-sha256"'}

    def abort_multipart_upload(self, *, UploadId: str, **_: object) -> None:
        self.events.append(("multipart-abort", UploadId))
        if self.fail_abort_count:
            self.fail_abort_count -= 1
            raise FakeClientError("AccessDenied")
        self.uploads.pop(UploadId, None)

    def list_multipart_uploads(self, *, Bucket: str, Prefix: str, **_: object) -> dict[str, object]:
        self.events.append(("multipart-list", Prefix))
        if self.deny_list_multipart_uploads:
            raise FakeClientError("AccessDenied")
        return {
            "Uploads": [
                {"Key": upload["Key"], "UploadId": upload_id}
                for upload_id, upload in self.uploads.items()
                if upload["Bucket"] == Bucket and str(upload["Key"]).startswith(Prefix)
            ],
            "IsTruncated": False,
        }

    def get_bucket_versioning(self, **_: object) -> dict[str, object]:
        return {"Status": "Enabled"}

    def get_object_lock_configuration(self, **_: object) -> dict[str, object]:
        raise FakeClientError("ObjectLockConfigurationNotFoundError")


def profile(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schemaVersion": 1,
        "provider": "s3-compatible",
        "region": "us-east-1",
        "bucket": "codexia-fixture",
        "prefix": "codexia/backups",
        "endpointUrl": "https://objects.example.test",
        "allowedOrigins": ["https://objects.example.test"],
        "addressingStyle": "path",
        "multipartThresholdBytes": 5 * 1024 * 1024,
        "multipartPartBytes": 5 * 1024 * 1024,
    }
    value.update(overrides)
    return value


class S3TransferTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="codexia-s3-transfer-")
        self.root = Path(self.temporary.name)
        self.artifact = self.root / "artifact"
        self.artifact.mkdir(mode=0o700)
        self.receipts = self.root / "receipts"
        self.receipts.mkdir(mode=0o700)
        self.output = self.root / "restored"
        self.output.mkdir(mode=0o700)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_artifact(self, *, large_database: bool = False) -> dict[str, bytes]:
        files = {
            "database.dump.age": (b"d" * (5 * 1024 * 1024 + 1)) if large_database else b"synthetic encrypted database",
            "history.tar.age": b"synthetic encrypted history",
            "manifest.age": b"synthetic encrypted v2 manifest",
        }
        for name, body in files.items():
            (self.artifact / name).write_bytes(body)
        sums = "".join(f"{sha256(files[name])}  {name}\n" for name in sorted(files))
        (self.artifact / "SHA256SUMS").write_text(sums, encoding="ascii")
        return files

    def make_transfer(self, client: FakeS3Client, **profile_values: object):
        return s3_transfer.S3BackupTransfer(profile(**profile_values), client=client)

    def test_profile_admission_rejects_untrusted_paths_and_credentials(self) -> None:
        for invalid in (
            "../other-environment",
            "codexia//backups",
            "codexia/./backups",
            "codexia/backups/../production",
            "/codexia/backups",
            "codexia/backups\nother",
        ):
            with self.subTest(prefix=invalid), self.assertRaises(s3_transfer.TransferError):
                s3_transfer.validate_profile(profile(prefix=invalid))

        with self.assertRaises(s3_transfer.TransferError):
            s3_transfer.validate_profile(profile(accessKeyId="must-not-be-in-profile"))

    def test_profile_file_admission_requires_private_owner_file(self) -> None:
        profile_path = self.root / "profile.json"
        profile_path.write_text(json.dumps(profile()), encoding="utf-8")
        profile_path.chmod(0o640)

        with self.assertRaises(s3_transfer.TransferError):
            s3_transfer.load_profile(profile_path)

        profile_path.chmod(0o600)
        self.assertEqual(s3_transfer.load_profile(profile_path)["bucket"], "codexia-fixture")

    def test_tls_client_keeps_certificate_verification_enabled(self) -> None:
        captures: dict[str, object] = {}

        class FakeConfig:
            def __init__(self, **kwargs: object):
                captures["config"] = kwargs

        class FakeClient:
            def __init__(self):
                self.meta = type("Meta", (), {
                    "endpoint_url": "https://objects.example.test",
                    "events": type("Events", (), {"register_first": lambda *_args, **_kwargs: None})(),
                })()

        class FakeSession:
            def client(self, service: str, **kwargs: object):
                captures["service"] = service
                captures["client_kwargs"] = kwargs
                return FakeClient()

        fake_boto3 = type("Boto3", (), {"session": type("SessionModule", (), {"Session": FakeSession})})()
        fake_botocore_config = type("BotocoreConfig", (), {"Config": FakeConfig})
        with patch.object(s3_transfer, "_install_pinned_https_transport") as install_transport, patch.dict(sys.modules, {
            "boto3": fake_boto3,
            "botocore": type("Botocore", (), {"config": fake_botocore_config})(),
            "botocore.config": fake_botocore_config,
        }):
            s3_transfer._make_client(profile(caBundle="/protected/fixture-ca.pem"))
        install_transport.assert_called_once()

        client_kwargs = captures["client_kwargs"]
        self.assertEqual(captures["service"], "s3")
        self.assertEqual(client_kwargs["verify"], "/protected/fixture-ca.pem")
        self.assertNotEqual(client_kwargs["verify"], False)

    def test_credential_denial_is_redacted_and_never_publishes_recovery_point(self) -> None:
        for code in ("AccessDenied", "ExpiredToken"):
            with self.subTest(code=code):
                self.write_artifact()
                client = FakeS3Client()
                client.fail_head_code = code

                with self.assertRaises(s3_transfer.TransferError) as caught:
                    self.make_transfer(client).upload_artifact(
                        self.artifact,
                        backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
                        source_identity="a" * 40,
                        receipt_path=self.receipts / "backup.json",
                    )

                self.assertNotIn("secret", str(caught.exception).lower())
                self.assertFalse(any(key.endswith("/COMMIT.json") for _, key in client.objects))
                self.assertFalse((self.receipts / "backup.json").exists())

    def test_partial_single_object_write_never_publishes_commit_or_receipt(self) -> None:
        self.write_artifact()
        client = FakeS3Client()
        failed_key = "codexia/backups/" + "a" * 40 + "/20261123T120000Z-12345678-1234-4234-9234-1234567890ab/history.tar.age"
        client.fail_put_for = failed_key

        with self.assertRaises(s3_transfer.TransferError) as caught:
            self.make_transfer(client).upload_artifact(
                self.artifact,
                backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
                source_identity="a" * 40,
                receipt_path=self.receipts / "backup.json",
            )

        self.assertNotIn("secret-token", str(caught.exception))
        self.assertTrue(any(key.endswith("/database.dump.age") for _, key in client.objects))
        self.assertFalse(any(key.endswith("/COMMIT.json") for _, key in client.objects))
        self.assertFalse((self.receipts / "backup.json").exists())

    def test_commit_marker_readback_failure_never_writes_external_receipt(self) -> None:
        self.write_artifact()
        client = FakeS3Client()
        commit_key = "codexia/backups/" + "a" * 40 + "/20261123T120000Z-12345678-1234-4234-9234-1234567890ab/COMMIT.json"
        client.fail_get_for = commit_key

        with self.assertRaises(s3_transfer.TransferError):
            self.make_transfer(client).upload_artifact(
                self.artifact,
                backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
                source_identity="a" * 40,
                receipt_path=self.receipts / "backup.json",
            )

        self.assertIn(("codexia-fixture", commit_key), client.objects)
        self.assertFalse((self.receipts / "backup.json").exists())

    def test_profile_rejects_non_tls_redirectable_or_unapproved_origins(self) -> None:
        valid = profile()
        self.assertEqual(s3_transfer.validate_profile(valid)["endpointUrl"], valid["endpointUrl"])
        for endpoint, allowlist in [
            ("http://objects.example.test", ["http://objects.example.test"]),
            ("https://user:secret@objects.example.test", ["https://objects.example.test"]),
            ("https://objects.example.test/path", ["https://objects.example.test"]),
            ("https://objects.example.test/?next=metadata", ["https://objects.example.test"]),
            ("https://other.example.test", ["https://objects.example.test"]),
        ]:
            with self.subTest(endpoint=endpoint), self.assertRaises(s3_transfer.TransferError):
                s3_transfer.validate_profile(profile(endpointUrl=endpoint, allowedOrigins=allowlist))

    def test_endpoint_guard_rejects_private_dns_results_and_redirects(self) -> None:
        guard = s3_transfer.EndpointGuard(profile(), "https://objects.example.test")
        private_answer = [(None, None, None, None, ("127.0.0.1", 443))]
        with patch("s3_transfer.socket.getaddrinfo", return_value=private_answer):
            with self.assertRaises(s3_transfer.TransferError):
                guard.before_send(type("Request", (), {"url": "https://objects.example.test/bucket/key"})())
        for status in (301, 302, 303, 307, 308):
            response = (type("Response", (), {"status_code": status})(), {})
            with self.subTest(status=status), self.assertRaises(s3_transfer.TransferError):
                guard.needs_retry(response=response)
        with self.assertRaises(s3_transfer.TransferError):
            guard.before_send(type("Request", (), {"url": "https://metadata.example.test/latest/meta-data"})())

    def test_endpoint_guard_returns_only_validated_numeric_addresses(self) -> None:
        guard = s3_transfer.EndpointGuard(profile(), "https://objects.example.test")
        public_answer = [(None, None, None, None, ("93.184.216.34", 443))]
        with patch("s3_transfer.socket.getaddrinfo", return_value=public_answer):
            self.assertEqual(guard._resolve_public_addresses("objects.example.test", 443), ("93.184.216.34",))

        rebinding_answer = [(None, None, None, None, ("127.0.0.1", 443))]
        with patch("s3_transfer.socket.getaddrinfo", return_value=rebinding_answer):
            with self.assertRaises(s3_transfer.TransferError):
                guard._resolve_public_addresses("objects.example.test", 443)

    def test_environment_variable_cannot_enable_private_s3_endpoints(self) -> None:
        private_answer = [(None, None, None, None, ("127.0.0.1", 443))]
        with patch.dict(os.environ, {"CODEXIA_S3_FIXTURE_MODE": "1"}):
            guard = s3_transfer.EndpointGuard(profile(), "https://objects.example.test")
            with patch("s3_transfer.socket.getaddrinfo", return_value=private_answer):
                with self.assertRaises(s3_transfer.TransferError):
                    guard.before_send(type("Request", (), {"url": "https://objects.example.test/bucket/key"})())

    def test_upload_reads_back_each_object_before_publishing_commit_marker(self) -> None:
        files = self.write_artifact()
        client = FakeS3Client()
        transfer = self.make_transfer(client)

        receipt = transfer.upload_artifact(
            self.artifact,
            backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            source_identity="a" * 40,
            receipt_path=self.receipts / "backup.json",
        )

        self.assertEqual(set(receipt["objects"]), set(files) | {"SHA256SUMS"})
        keys = [key for _, key in client.events]
        commit_key = receipt["markerKey"]
        self.assertEqual(keys[-2:], [commit_key, commit_key])
        self.assertEqual(client.events[-2:], [("put", commit_key), ("get", commit_key)])
        for name in files:
            object_key = receipt["objects"][name]["key"]
            self.assertEqual(bytes(client.objects[("codexia-fixture", object_key)]["Body"]), files[name])
        self.assertNotIn("delete", [operation for operation, _ in client.events])
        self.assertEqual((self.receipts / "backup.json").stat().st_mode & 0o777, 0o600)

    def test_conditional_create_wins_race_after_missing_object_probe(self) -> None:
        files = self.write_artifact()
        client = FakeS3Client()
        client.race_conditional_create = True

        receipt = self.make_transfer(client).upload_artifact(
            self.artifact,
            backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            source_identity="a" * 40,
            receipt_path=self.receipts / "backup.json",
        )

        raced_key = client.race_key
        self.assertIsNotNone(raced_key)
        self.assertEqual(raced_key, receipt["objects"]["database.dump.age"]["key"])
        winner = client.objects[("codexia-fixture", raced_key)]
        self.assertEqual(bytes(winner["Body"]), (self.artifact / "database.dump.age").read_bytes())
        self.assertEqual(winner["Metadata"], {"race-winner": "preserved"})
        self.assertEqual(winner["VersionId"], "winner-version")
        self.assertEqual(set(receipt["objects"]), set(files) | {"SHA256SUMS"})

    def test_corrupt_readback_never_publishes_a_commit_marker_or_receipt(self) -> None:
        self.write_artifact()
        client = FakeS3Client()
        client.corrupt_readback_for = "codexia/backups/" + "a" * 40 + "/20261123T120000Z-12345678-1234-4234-9234-1234567890ab/database.dump.age"

        with self.assertRaises(s3_transfer.TransferError):
            self.make_transfer(client).upload_artifact(
                self.artifact,
                backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
                source_identity="a" * 40,
                receipt_path=self.receipts / "backup.json",
            )

        self.assertFalse(any(key.endswith("/COMMIT.json") for _, key in client.objects))
        self.assertFalse((self.receipts / "backup.json").exists())

    def test_etag_is_not_used_as_sha256_when_multipart_bytes_match(self) -> None:
        files = self.write_artifact(large_database=True)
        client = FakeS3Client()
        receipt = self.make_transfer(client).upload_artifact(
            self.artifact,
            backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            source_identity="a" * 40,
            receipt_path=self.receipts / "backup.json",
        )

        database = receipt["objects"]["database.dump.age"]
        stored = client.objects[("codexia-fixture", database["key"])]
        self.assertEqual(sha256(bytes(stored["Body"])), database["sha256"])
        self.assertEqual(stored["ETag"], '"multipart-etag-not-sha256"')
        self.assertIn(("multipart-complete", database["key"]), client.events)

    def test_multipart_failure_aborts_upload_and_does_not_publish_marker(self) -> None:
        self.write_artifact(large_database=True)
        client = FakeS3Client()
        client.fail_upload_part = True

        with self.assertRaises(s3_transfer.TransferError):
            self.make_transfer(client).upload_artifact(
                self.artifact,
                backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
                source_identity="a" * 40,
                receipt_path=self.receipts / "backup.json",
            )

        self.assertEqual(client.uploads, {})
        self.assertTrue(any(event[0] == "multipart-abort" for event in client.events))
        self.assertFalse(any(key.endswith("/COMMIT.json") for _, key in client.objects))

    def test_multipart_upload_does_not_require_bucketwide_upload_listing(self) -> None:
        self.write_artifact(large_database=True)
        client = FakeS3Client()
        client.deny_list_multipart_uploads = True

        receipt = self.make_transfer(client).upload_artifact(
            self.artifact,
            backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            source_identity="a" * 40,
            receipt_path=self.receipts / "backup.json",
        )

        self.assertEqual(receipt["backupId"], "20261123T120000Z-12345678-1234-4234-9234-1234567890ab")
        self.assertFalse(any(operation == "multipart-list" for operation, _ in client.events))
        self.assertEqual(client.uploads, {})

    def test_retry_aborts_a_recorded_upload_left_by_cleanup_failure(self) -> None:
        self.write_artifact(large_database=True)
        client = FakeS3Client()
        client.fail_upload_part = True
        client.fail_abort_count = 1
        receipt_path = self.receipts / "backup.json"
        arguments = {
            "backup_id": "20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            "source_identity": "a" * 40,
            "receipt_path": receipt_path,
        }

        with self.assertRaises(s3_transfer.TransferError):
            self.make_transfer(client).upload_artifact(self.artifact, **arguments)

        journal = self.receipts / ".codexia-20261123T120000Z-12345678-1234-4234-9234-1234567890ab.multipart.json"
        self.assertTrue(journal.exists())
        self.assertEqual(len(client.uploads), 1)
        client.fail_upload_part = False

        self.make_transfer(client).upload_artifact(self.artifact, **arguments)

        self.assertFalse(journal.exists())
        self.assertEqual(client.uploads, {})
        self.assertTrue(any(operation == "multipart-abort" for operation, _ in client.events))

    def test_retry_reuses_matching_objects_without_overwriting_them(self) -> None:
        self.write_artifact()
        client = FakeS3Client()
        client.fail_commit_marker_once = True
        transfer = self.make_transfer(client)
        arguments = {
            "backup_id": "20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            "source_identity": "a" * 40,
            "receipt_path": self.receipts / "backup.json",
        }
        with self.assertRaises(s3_transfer.TransferError):
            transfer.upload_artifact(self.artifact, **arguments)
        writes_before_retry = sum(operation == "put" for operation, _ in client.events)

        transfer.upload_artifact(self.artifact, **arguments)

        writes_after_retry = sum(operation == "put" for operation, _ in client.events)
        self.assertEqual(writes_after_retry - writes_before_retry, 1)
        self.assertTrue(any(key.endswith("/COMMIT.json") for _, key in client.objects))

    def test_retry_preserves_marker_when_bucket_capability_lookup_changes(self) -> None:
        self.write_artifact()
        client = FakeS3Client()
        arguments = {
            "backup_id": "20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            "source_identity": "a" * 40,
            "receipt_path": self.receipts / "backup.json",
        }
        write_receipt = s3_transfer._write_receipt

        def lose_receipt(path, value):
            if path == arguments["receipt_path"]:
                raise s3_transfer.TransferError("simulated failure writing the final receipt")
            return write_receipt(path, value)

        with patch.object(s3_transfer, "_write_receipt", side_effect=lose_receipt):
            with self.assertRaisesRegex(s3_transfer.TransferError, "simulated failure"):
                self.make_transfer(client).upload_artifact(self.artifact, **arguments)

        self.assertFalse(arguments["receipt_path"].exists())
        marker_key = next(key for _, key in client.objects if key.endswith("/COMMIT.json"))
        marker_bytes = bytes(client.objects[("codexia-fixture", marker_key)]["Body"])
        client.events.clear()
        with patch.object(client, "get_bucket_versioning", side_effect=OSError("unavailable")):
            receipt = self.make_transfer(client).upload_artifact(self.artifact, **arguments)
            self.assertEqual(self.make_transfer(client).upload_artifact(self.artifact, **arguments), receipt)

        self.assertNotIn("put", [operation for operation, _ in client.events])
        self.assertEqual(receipt["markerSha256"], sha256(marker_bytes))
        self.assertEqual(receipt["capabilities"]["versioning"], "Enabled")
        self.assertEqual(list(self.receipts.iterdir()), [arguments["receipt_path"]])
        self.make_transfer(client).download_artifact(
            backup_id=arguments["backup_id"], receipt_path=arguments["receipt_path"], output_dir=self.output
        )

    def test_download_requires_the_external_receipt_and_rejects_tampered_bytes(self) -> None:
        files = self.write_artifact()
        client = FakeS3Client()
        transfer = self.make_transfer(client)
        receipt_path = self.receipts / "backup.json"
        transfer.upload_artifact(
            self.artifact,
            backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            source_identity="a" * 40,
            receipt_path=receipt_path,
        )
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        client.objects[("codexia-fixture", receipt["objects"]["database.dump.age"]["key"])]["Body"] = b"tampered"

        with self.assertRaises(s3_transfer.TransferError):
            transfer.download_artifact(
                backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
                receipt_path=receipt_path,
                output_dir=self.output,
            )

        self.assertEqual(list(self.output.iterdir()), [])

    def test_download_bounds_commit_marker_reads_and_closes_the_stream(self) -> None:
        self.write_artifact()
        client = FakeS3Client()
        transfer = self.make_transfer(client)
        receipt_path = self.receipts / "backup.json"
        backup_id = "20261123T120000Z-12345678-1234-4234-9234-1234567890ab"
        transfer.upload_artifact(
            self.artifact,
            backup_id=backup_id,
            source_identity="a" * 40,
            receipt_path=receipt_path,
        )

        class TrackingBody(io.BytesIO):
            read_limit: int | None = None
            was_closed = False

            def read(self, size: int = -1) -> bytes:
                self.read_limit = size
                return super().read(size)

            def close(self) -> None:
                self.was_closed = True
                super().close()

        for content_length in (s3_transfer.MAX_COMMIT_MARKER_BYTES + 1, 1, None):
            with self.subTest(content_length=content_length):
                body = TrackingBody(b"x" * (s3_transfer.MAX_COMMIT_MARKER_BYTES + 1))
                response = {"Body": body}
                if content_length is not None:
                    response["ContentLength"] = content_length
                with patch.object(client, "get_object", return_value=response):
                    with self.assertRaisesRegex(s3_transfer.TransferError, "commit marker"):
                        transfer.download_artifact(
                            backup_id=backup_id, receipt_path=receipt_path, output_dir=self.output
                        )
                self.assertTrue(body.was_closed)
                self.assertEqual(
                    body.read_limit,
                    None if isinstance(content_length, int) and content_length > s3_transfer.MAX_COMMIT_MARKER_BYTES
                    else s3_transfer.MAX_COMMIT_MARKER_BYTES + 1,
                )
                self.assertEqual(list(self.output.iterdir()), [])

    def test_download_restores_exact_ciphertext_only_after_receipt_and_manifest_match(self) -> None:
        files = self.write_artifact()
        client = FakeS3Client()
        transfer = self.make_transfer(client)
        receipt_path = self.receipts / "backup.json"
        transfer.upload_artifact(
            self.artifact,
            backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            source_identity="a" * 40,
            receipt_path=receipt_path,
        )

        restored = transfer.download_artifact(
            backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            receipt_path=receipt_path,
            output_dir=self.output,
        )

        self.assertEqual(restored, self.output / "codexia-20261123T120000Z-12345678-1234-4234-9234-1234567890ab")
        for name, body in files.items():
            self.assertEqual((restored / name).read_bytes(), body)
        self.assertEqual(s3_transfer.validate_artifact(restored)["sha256sumsSha256"], sha256((restored / "SHA256SUMS").read_bytes()))

    def test_same_backup_id_with_changed_ciphertext_is_refused(self) -> None:
        self.write_artifact()
        client = FakeS3Client()
        transfer = self.make_transfer(client)
        arguments = {
            "backup_id": "20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            "source_identity": "a" * 40,
            "receipt_path": self.receipts / "backup.json",
        }
        transfer.upload_artifact(self.artifact, **arguments)
        original_key = next(key for bucket, key in client.objects if key.endswith("/database.dump.age"))
        (self.artifact / "database.dump.age").write_bytes(b"different ciphertext")
        sums = "".join(
            f"{sha256((self.artifact / name).read_bytes())}  {name}\n" for name in sorted(("database.dump.age", "history.tar.age", "manifest.age"))
        )
        (self.artifact / "SHA256SUMS").write_text(sums, encoding="ascii")

        with self.assertRaises(s3_transfer.TransferError):
            transfer.upload_artifact(self.artifact, **arguments)

        self.assertEqual(client.objects[("codexia-fixture", original_key)]["Body"], b"synthetic encrypted database")

    def test_existing_receipt_with_a_different_identity_is_not_overwritten(self) -> None:
        self.write_artifact()
        client = FakeS3Client()
        transfer = self.make_transfer(client)
        receipt_path = self.receipts / "backup.json"
        transfer.upload_artifact(
            self.artifact,
            backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
            source_identity="a" * 40,
            receipt_path=receipt_path,
        )
        original = receipt_path.read_bytes()

        with self.assertRaises(s3_transfer.TransferError):
            transfer.upload_artifact(
                self.artifact,
                backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
                source_identity="b" * 40,
                receipt_path=receipt_path,
            )

        self.assertEqual(receipt_path.read_bytes(), original)

    def test_private_retention_requirement_fails_when_bucket_does_not_support_it(self) -> None:
        self.write_artifact()
        client = FakeS3Client()

        with self.assertRaises(s3_transfer.TransferError):
            self.make_transfer(client, retentionMode="COMPLIANCE", retentionDays=14).upload_artifact(
                self.artifact,
                backup_id="20261123T120000Z-12345678-1234-4234-9234-1234567890ab",
                source_identity="a" * 40,
                receipt_path=self.receipts / "backup.json",
            )

        self.assertEqual(client.objects, {})


if __name__ == "__main__":
    unittest.main()
