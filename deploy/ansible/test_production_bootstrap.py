"""Credential-free regression tests for the protected bootstrap control plane."""
from __future__ import annotations

import base64
import importlib.util
import io
import json
from pathlib import Path
from unittest import mock
import tarfile
import tempfile
import unittest

import yaml

MODULE_FILE = Path(__file__).with_name("prepare-production-bootstrap.py")
spec = importlib.util.spec_from_file_location("prepare_production_bootstrap", MODULE_FILE)
assert spec and spec.loader
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="codexia-bootstrap-test-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.key = self.base / "key"
        self.key.write_text("fixture-private-identity\n")
        self.ssh_probe = mock.patch.object(bootstrap.subprocess, "run")
        self.ssh_probe.start()
        self.addCleanup(self.ssh_probe.stop)
        pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureHostKey"
        self.host = "codexia-bootstrap.example.invalid"
        self.contents = {name: (f"fixture-{name}\n").encode() for name in bootstrap.REQUIRED_FILES}
        self.contents["inventory.yml"] = yaml.safe_dump({
            "all": {"children": {"codexia": {
                "hosts": {"node": {"ansible_host": self.host, "ansible_user": "bootstrap-admin"}},
                "vars": {
                    "codexia_service_user": "codexia",
                    "codexia_service_home": "/home/codexia",
                    "codexia_service_uid": 1001,
                    "codexia_host_approved": True,
                    "codexia_secrets_approved": True,
                    "codexia_base_approved": True,
                    "codexia_auth_runtime_approved": True,
                    "codexia_auth_registration_pending": False,
                },
            }}}}, sort_keys=False).encode()
        self.env = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": "yohn-jp/codexia",
            "RUNNER_TEMP": str(self.base),
            "GITHUB_OUTPUT": str(self.base / "outputs"),
            "CODEXIA_BOOTSTRAP_MODE": "preflight",
            "CODEXIA_BOOTSTRAP_HOST": self.host,
            "CODEXIA_BOOTSTRAP_SSH_USER": "bootstrap-admin",
            "CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY": self.key.read_text(),
            "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS": f"{self.host} {pubkey}",
            "CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED": "false",
            "CODEXIA_BOOTSTRAP_RECREATE_MISSING_DATABASE_APPROVED": "false",
            "CODEXIA_BOOTSTRAP_FULL_IMAGE": "",
        }
        self.set_bundle()

    def set_bundle(self, extra_members: dict[str, bytes] | None = None, symlink: str | None = None):
        result = io.BytesIO()
        with tarfile.open(fileobj=result, mode="w:gz") as archive:
            for name, data in {**self.contents, **(extra_members or {})}.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
            if symlink:
                entry = tarfile.TarInfo(symlink)
                entry.type = tarfile.SYMTYPE
                entry.linkname = "/etc/shadow"
                archive.addfile(entry)
        self.env["CODEXIA_BOOTSTRAP_BUNDLE_B64"] = base64.b64encode(result.getvalue()).decode()

    def test_preflight_validates_pinned_ssh_and_stages_only_private_files(self):
        result = bootstrap.prepare(self.env)
        self.assertEqual(result["mode"], "preflight")
        control = Path(result["control"])
        self.assertEqual((control / "inventory.yml").stat().st_mode & 0o777, 0o600)
        runtime = json.loads((control / "runtime-vars.json").read_text())
        self.assertEqual(runtime["codexia_stage"], "bootstrap")
        self.assertFalse(runtime["codexia_database_initialization_approved"])
        self.assertFalse(runtime["codexia_recreate_missing_app_database_approved"])
        self.assertNotIn("fixture-private/tunnel-token", json.dumps(runtime))
        self.assertIn(self.host, (self.base / "outputs").read_text())

    def test_bootstrap_requires_reviewed_digest_and_explicit_approvals(self):
        self.env["CODEXIA_BOOTSTRAP_MODE"] = "bootstrap"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "reviewed immutable Full image"):
            bootstrap.prepare(self.env)
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "a" * 64
        self.env["CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED"] = "true"
        self.env["CODEXIA_BOOTSTRAP_RECREATE_MISSING_DATABASE_APPROVED"] = "true"
        out = bootstrap.prepare(self.env)
        runtime = json.loads((Path(out["control"]) / "runtime-vars.json").read_text())
        self.assertTrue(runtime["codexia_database_initialization_approved"])
        self.assertTrue(runtime["codexia_recreate_missing_app_database_approved"])
        self.assertEqual(runtime["codexia_auth_bootstrap_image"], self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"])

    def test_preflight_rejects_mutation_gate(self):
        self.env["CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED"] = "true"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "Read-only preflight"):
            bootstrap.prepare(self.env)

    def test_recreation_cannot_bypass_separate_initialization_approval(self):
        self.env["CODEXIA_BOOTSTRAP_RECREATE_MISSING_DATABASE_APPROVED"] = "true"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "requires database initialization approval"):
            bootstrap.prepare(self.env)

    def test_refuses_incomplete_bundle(self):
        del self.contents["private/postgres-admin-password"]
        self.set_bundle()
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "missing required"):
            bootstrap.prepare(self.env)

    def test_refuses_archive_path_traversal(self):
        self.set_bundle({"../../untrusted": b"sensitive"})
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "unexpected"):
            bootstrap.prepare(self.env)
        self.assertFalse((self.base / "untrusted").exists())

    def test_refuses_symlink_to_escape_controller(self):
        self.set_bundle(symlink="private/enrollment/bootstrap.env")
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "non-regular"):
            bootstrap.prepare(self.env)

    def test_refuses_target_mismatch(self):
        self.env["CODEXIA_BOOTSTRAP_HOST"] = "different.example.invalid"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "independently pinned"):
            bootstrap.prepare(self.env)

    def test_refuses_rootless_service_as_admin_identity(self):
        self.env["CODEXIA_BOOTSTRAP_SSH_USER"] = "codexia"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "independent"):
            bootstrap.prepare(self.env)

    def test_requires_all_individual_convergence_approvals(self):
        inv = yaml.safe_load(self.contents["inventory.yml"])
        inv["all"]["children"]["codexia"]["vars"]["codexia_auth_runtime_approved"] = False
        self.contents["inventory.yml"] = yaml.safe_dump(inv).encode()
        self.set_bundle()
        self.env["CODEXIA_BOOTSTRAP_MODE"] = "bootstrap"
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "a" * 64
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "explicitly approve"):
            bootstrap.prepare(self.env)


if __name__ == "__main__":
    unittest.main()
