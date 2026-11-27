"""Exercise retention verification using the synthetic S3 transfer boundary."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

from deploy.backup.test_s3_transfer import FakeClientError, FakeS3Client, profile, s3_transfer, sha256


class ObjectLockClient(FakeS3Client):
    def __init__(self):
        super().__init__()
        self.retention = {}
        self.readbacks = []
        self.capability_error = None

    def get_object_lock_configuration(self, **_):
        if self.capability_error:
            raise FakeClientError(self.capability_error)
        return {"ObjectLockConfiguration": {"ObjectLockEnabled": "Enabled"}}

    def put_object(self, *, Bucket, Key, **kwargs):
        result = super().put_object(Bucket=Bucket, Key=Key, **kwargs)
        self.retention.setdefault(Key, self.lock_fields(kwargs))
        return result

    def create_multipart_upload(self, *, Bucket, Key, **kwargs):
        result = super().create_multipart_upload(Bucket=Bucket, Key=Key, **kwargs)
        self.retention.setdefault(Key, self.lock_fields(kwargs))
        return result

    @staticmethod
    def lock_fields(request):
        return {
            name: request[name]
            for name in ("ObjectLockMode", "ObjectLockRetainUntilDate")
            if name in request
        }

    def get_object(self, *, Bucket, Key, VersionId=None):
        response = super().get_object(Bucket=Bucket, Key=Key, VersionId=VersionId)
        self.readbacks.append((Key, VersionId))
        return {**response, **self.retention.get(Key, {})}


class S3RetentionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="codexia-s3-retention-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.artifact = self.root / "artifact"
        self.artifact.mkdir()
        self.receipt = self.root / "receipt.json"
        created = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=1)
        self.backup_id = created.strftime("%Y%m%dT%H%M%SZ") + "-retention"
        self.retain_until = created + timedelta(days=7)
        self.source = "a" * 40
        self.client = ObjectLockClient()

    def write_artifact(self, *, multipart=False):
        sizes = [5 * 1024 * 1024 + 1 if multipart else 16, 12, 11]
        sums = []
        for name, size in zip(s3_transfer.ARTIFACT_FILES, sizes, strict=True):
            data = b"a" * size
            (self.artifact / name).write_bytes(data)
            sums.append(f"{sha256(data)}  {name}\n")
        (self.artifact / "SHA256SUMS").write_text("".join(sums), encoding="ascii")

    def key(self, name):
        return f"codexia/backups/{self.source}/{self.backup_id}/{name}"

    def upload(self, *, retention=True, receipt=None):
        config = profile(retentionMode="COMPLIANCE", retentionDays=7) if retention else profile()
        return s3_transfer.S3BackupTransfer(config, client=self.client).upload_artifact(
            self.artifact, backup_id=self.backup_id, source_identity=self.source,
            receipt_path=receipt or self.receipt,
        )

    def test_explicit_retention_is_read_back_for_every_exact_object_version(self):
        self.write_artifact(multipart=True)
        receipt = self.upload()
        required = {"ObjectLockMode": "COMPLIANCE", "ObjectLockRetainUntilDate": self.retain_until}
        expected_readbacks = [
            (receipt["objects"][name]["key"], receipt["objects"][name]["versionId"])
            for name in s3_transfer.OBJECT_FILES
        ]
        expected_readbacks.append((receipt["markerKey"], receipt["markerVersionId"]))
        self.assertEqual(self.client.readbacks, expected_readbacks)
        self.assertEqual(self.client.retention, {key: required for key, _ in expected_readbacks})
        self.assertIn(("multipart-complete", self.key("database.dump.age")), self.client.events)
        self.assertEqual(self.upload(), receipt)
        self.assertEqual(self.client.readbacks, expected_readbacks * 2)

    def test_unconfirmed_artifact_retention_blocks_before_commit_marker(self):
        self.write_artifact()
        for observed in (
            {},
            {"ObjectLockMode": "GOVERNANCE", "ObjectLockRetainUntilDate": self.retain_until},
            {"ObjectLockMode": "COMPLIANCE", "ObjectLockRetainUntilDate": self.retain_until - timedelta(seconds=1)},
            {"ObjectLockMode": "COMPLIANCE", "ObjectLockRetainUntilDate": self.retain_until.replace(tzinfo=None)},
            {"ObjectLockMode": "COMPLIANCE", "ObjectLockRetainUntilDate": self.retain_until, "VersionId": "wrong-version"},
        ):
            with self.subTest(observed=observed):
                self.client = ObjectLockClient()
                self.client.retention[self.key("database.dump.age")] = observed
                expected_error = "different version" if "VersionId" in observed else "retention"
                with self.assertRaisesRegex(s3_transfer.TransferError, expected_error):
                    self.upload()
                self.assertFalse(any(key.endswith("/COMMIT.json") for _, key in self.client.objects))
                self.assertFalse(self.receipt.exists())

    def test_retry_rechecks_retention_on_existing_ciphertext(self):
        self.write_artifact()
        self.upload()
        self.client.retention[self.key("database.dump.age")] = {}
        retry_receipt = self.root / "retry-receipt.json"
        self.client.events.clear()
        with self.assertRaisesRegex(s3_transfer.TransferError, "retention"):
            self.upload(receipt=retry_receipt)
        self.assertFalse(retry_receipt.exists())
        self.assertFalse(any(operation == "put" for operation, _ in self.client.events))

    def test_conditional_write_race_cannot_adopt_an_object_without_retention(self):
        self.write_artifact()
        self.client.race_conditional_create = True
        with self.assertRaisesRegex(s3_transfer.TransferError, "retention"):
            self.upload()
        race_key = self.client.race_key
        self.assertEqual(race_key, self.key("database.dump.age"))
        self.assertEqual(self.client.readbacks, [(race_key, "winner-version")])
        self.assertFalse(self.receipt.exists())
        self.assertNotIn(("codexia-fixture", self.key("COMMIT.json")), self.client.objects)

    def test_unconfirmed_commit_marker_retention_blocks_external_receipt(self):
        self.write_artifact()
        marker_key = self.key("COMMIT.json")
        self.client.retention[marker_key] = {}
        with self.assertRaisesRegex(s3_transfer.TransferError, "retention"):
            self.upload()
        self.assertIn(("codexia-fixture", marker_key), self.client.objects)
        self.assertFalse(self.receipt.exists())

    def test_retry_refuses_marker_version_drift_without_replacing_the_receipt(self):
        self.write_artifact()
        first_receipt = self.upload()
        original_receipt_bytes = self.receipt.read_bytes()
        marker_key = first_receipt["markerKey"]
        self.client.objects[("codexia-fixture", marker_key)]["VersionId"] = "new-marker-version"

        with self.assertRaisesRegex(s3_transfer.TransferError, "Existing external receipt conflicts"):
            self.upload()

        self.assertEqual(self.client.readbacks[-1], (marker_key, "new-marker-version"))
        self.assertEqual(self.receipt.read_bytes(), original_receipt_bytes)

    def test_unsupported_lock_remains_distinct_from_disabled_or_unobservable_lock(self):
        self.write_artifact()
        for code, support, enabled in (
            ("NotImplemented", False, False),
            ("ObjectLockConfigurationNotFoundError", True, False),
            ("AccessDenied", None, None),
        ):
            with self.subTest(code=code):
                self.client = ObjectLockClient()
                self.client.capability_error = code
                with self.assertRaisesRegex(s3_transfer.TransferError, "retention is not enabled"):
                    self.upload()
                self.assertFalse(self.client.objects)
                receipt = self.upload(retention=False, receipt=self.root / f"{code}.json")
                observed = receipt["capabilities"]
                self.assertIs(observed["objectLockSupported"], support)
                self.assertIs(observed["objectLockEnabled"], enabled)
                self.assertIsNone(observed["requestedRetention"])
