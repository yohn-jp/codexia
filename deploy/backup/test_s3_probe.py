"""Fixture-only tests for console S3 destination admission and probes."""
from __future__ import annotations

import io
import unittest
from unittest.mock import patch

import s3_probe
import s3_transfer


POLICY = {"destinations": [{"provider": "s3-compatible", "bucket": "codexia-fixture",
          "prefix": "codexia/backups", "origin": "https://objects.example.test",
          "allowProbeCleanup": True}]}
DRAFT = {"provider": "s3-compatible", "region": "us-east-1", "bucket": "codexia-fixture",
         "prefix": "codexia/backups/test", "endpoint": "https://objects.example.test",
         "addressingStyle": "path"}


class Client:
    def __init__(self, corrupt: bool = False):
        self.objects: dict[tuple[str, str], bytes] = {}
        self.corrupt = corrupt
        self.calls: list[str] = []

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, IfNoneMatch: str, **_: object) -> dict[str, str]:
        self.calls.append("put")
        assert IfNoneMatch == "*"
        self.objects[(Bucket, Key)] = Body
        return {"VersionId": "fixture-version"}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, object]:
        self.calls.append("get")
        value = self.objects[(Bucket, Key)]
        return {"Body": io.BytesIO(value + (b"!" if self.corrupt else b""))}

    def delete_object(self, *, Bucket: str, Key: str, VersionId: str | None = None) -> None:
        self.calls.append("delete")
        assert VersionId == "fixture-version"
        self.objects.pop((Bucket, Key), None)


class S3ProbeTests(unittest.TestCase):
    def test_object_lock_retention_supports_days_and_conservative_years(self) -> None:
        class RetentionClient:
            def __init__(self, default: dict):
                self.default = default

            def get_bucket_versioning(self, **kwargs):
                return {"Status": "Enabled"}

            def get_object_lock_configuration(self, **kwargs):
                return {"ObjectLockConfiguration": {
                    "ObjectLockEnabled": "Enabled",
                    "Rule": {"DefaultRetention": self.default},
                }}

        for default, expected in (
            ({"Mode": "COMPLIANCE", "Days": 30}, 30),
            ({"Mode": "COMPLIANCE", "Years": 1}, 365),
            ({"Mode": "COMPLIANCE", "Years": 2}, 730),
            ({"Mode": "COMPLIANCE", "Years": True}, None),
            ({"Mode": "COMPLIANCE", "Years": 0}, None),
            ({"Mode": "COMPLIANCE", "Days": 30, "Years": 1}, None),
        ):
            with self.subTest(default=default):
                result = s3_probe._observe_retention_capabilities(
                    RetentionClient(default), DRAFT, {},
                )
                self.assertEqual(result["objectLock"], "enabled")
                self.assertEqual(result["defaultRetentionDays"], expected)

    def test_admission_rejects_bucket_prefix_and_endpoint_escape(self) -> None:
        with self.assertRaisesRegex(s3_probe.ProbeError, "destination_not_allowed"):
            s3_probe.validate_destination({**DRAFT, "bucket": "other-bucket"}, POLICY)
        with self.assertRaisesRegex(s3_probe.ProbeError, "destination_not_allowed"):
            s3_probe.validate_destination({**DRAFT, "prefix": "codexia/backups-prod"}, POLICY)
        with self.assertRaisesRegex(s3_probe.ProbeError, "invalid_destination"):
            s3_probe.validate_destination({**DRAFT, "endpoint": "http://127.0.0.1"}, POLICY)

    def test_probe_uses_unique_key_verifies_bytes_and_cleans_up(self) -> None:
        client = Client()
        result = s3_probe.probe_destination(DRAFT, POLICY, client=client)
        self.assertEqual(result["status"], "PASSED")
        self.assertEqual(client.calls, ["put", "get", "delete"])
        self.assertFalse(client.objects)

    def test_probe_rejects_corrupted_readback_and_still_cleans_up(self) -> None:
        client = Client(corrupt=True)
        result = s3_probe.probe_destination(DRAFT, POLICY, client=client)
        self.assertEqual((result["status"], result["reasonCode"]), ("FAILED", "readback_mismatch"))
        self.assertEqual(client.calls, ["put", "get", "delete"])
        self.assertFalse(client.objects)

    def test_aws_endpoint_is_derived_and_cannot_be_overridden(self) -> None:
        with self.assertRaises(s3_probe.ProbeError):
            s3_probe.validate_destination({"provider": "aws-s3", "region": "us-east-1",
                "bucket": "codexia-fixture", "prefix": "codexia/backups",
                "endpoint": "https://attacker.example"}, POLICY)

    def test_private_allowlist_accepts_only_exact_rfc1918_addresses(self) -> None:
        self.assertEqual(s3_probe._private_allowlist(["192.168.20.4"]), ("192.168.20.4",))
        for address in ("127.0.0.1", "169.254.169.254", "198.18.0.1", "::1"):
            with self.subTest(address=address), self.assertRaises(s3_probe.ProbeError):
                s3_probe._private_allowlist([address])


if __name__ == "__main__":
    unittest.main()
