"""Credential-free regression tests for the protected bootstrap control plane."""
from __future__ import annotations

import base64
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest import mock

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
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_SHA": "c" * 40,
            "GITHUB_RUN_ID": "900",
            "GITHUB_RUN_ATTEMPT": "1",
            "RUNNER_TEMP": str(self.base),
            "GITHUB_OUTPUT": str(self.base / "outputs"),
            "CODEXIA_BOOTSTRAP_MODE": "preflight",
            "CODEXIA_BOOTSTRAP_HOST": self.host,
            "CODEXIA_BOOTSTRAP_SSH_USER": "bootstrap-admin",
            "CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY": self.key.read_text(),
            "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS": f"{self.host} {pubkey}",
            "CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED": "false",
            "CODEXIA_BOOTSTRAP_FULL_IMAGE": "",
            "CODEXIA_RUNTIME_SSH_PUBLIC_KEY": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureRuntimeKey",
        }
        self.image = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "a" * 64
        self.candidate = self.base / "codexia-lifecycle-candidate.json"
        self.set_bundle()

    def certify(self, *, image: str | None = None, profile: str = "full", **binding):
        receipt = {
            "sourceSha": self.env["GITHUB_SHA"],
            "runId": int(self.env["GITHUB_RUN_ID"]),
            "attempt": int(self.env["GITHUB_RUN_ATTEMPT"]),
            "candidateBackend": {
                "image": image or self.image,
                "identity": {"profile": profile},
            },
        }
        self.candidate.write_text(json.dumps(receipt | binding), encoding="utf-8")
        self.candidate.chmod(0o600)

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
        inventory = yaml.safe_load((control / "inventory.yml").read_text())
        group = inventory["all"]["children"]["codexia"]
        target = group["hosts"]["codexia-target"]
        self.assertEqual(target["ansible_host"], "codexia-bootstrap-target")
        self.assertEqual(target["ansible_user"], "bootstrap-admin")
        self.assertEqual(target["ansible_connection"], "ssh")
        self.assertIn("codexia-bootstrap/ssh/config", target["ansible_ssh_common_args"])
        self.assertTrue(all(not key.startswith("ansible_") for key in runtime))
        self.assertEqual(group["vars"]["codexia_service_uid"], 1001)
        self.assertNotIn("fixture-private", json.dumps(inventory))
        self.assertEqual(runtime["codexia_stage"], "inspect")
        self.assertFalse(runtime["codexia_database_initialization_approved"])
        self.assertNotIn("codexia_recreate_missing_app_database_approved", runtime)
        self.assertNotIn("fixture-private/tunnel-token", json.dumps(runtime))
        self.assertIn(self.host, (self.base / "outputs").read_text())

    def test_bootstrap_requires_reviewed_digest_and_explicit_approvals(self):
        self.env["CODEXIA_BOOTSTRAP_MODE"] = "bootstrap"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "reviewed immutable Full image"):
            bootstrap.prepare(self.env)
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        self.certify()
        self.env["CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED"] = "true"
        out = bootstrap.prepare(self.env)
        runtime = json.loads((Path(out["control"]) / "runtime-vars.json").read_text())
        self.assertTrue(runtime["codexia_database_initialization_approved"])
        self.assertNotIn("codexia_recreate_missing_app_database_approved", runtime)
        self.assertEqual(runtime["codexia_auth_bootstrap_image"], self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"])
        inventory = yaml.safe_load((Path(out["control"]) / "inventory.yml").read_text())
        self.assertEqual(inventory["all"]["children"]["codexia"]["vars"]["codexia_deploy_ssh_public_key"],
                         self.env["CODEXIA_RUNTIME_SSH_PUBLIC_KEY"])

    def test_bootstrap_refuses_missing_or_invalid_runtime_public_key(self):
        self.env["CODEXIA_BOOTSTRAP_MODE"] = "bootstrap"
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        self.certify()
        self.env["CODEXIA_RUNTIME_SSH_PUBLIC_KEY"] = "not-a-public-key"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "runtime SSH public key is invalid"):
            bootstrap.prepare(self.env)

    def test_bootstrap_refuses_inventory_key_different_from_production_credential(self):
        self.env["CODEXIA_BOOTSTRAP_MODE"] = "bootstrap"
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        self.certify()
        inventory = yaml.safe_load(self.contents["inventory.yml"])
        inventory["all"]["children"]["codexia"]["vars"]["codexia_deploy_ssh_public_key"] = "ssh-ed25519 DifferentKey"
        self.contents["inventory.yml"] = yaml.safe_dump(inventory).encode()
        self.set_bundle()
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "Inventory runtime public key differs"):
            bootstrap.prepare(self.env)

    def test_bootstrap_refuses_format_valid_digest_without_candidate_verification(self):
        self.env["CODEXIA_BOOTSTRAP_MODE"] = "bootstrap"
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "verified lifecycle candidate"):
            bootstrap.prepare(self.env)
        self.assertFalse((self.base / "codexia-bootstrap").exists())

    def test_bootstrap_refuses_candidate_from_another_source_run_or_attempt(self):
        self.env["CODEXIA_BOOTSTRAP_MODE"] = "bootstrap"
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        for binding in ({"sourceSha": "b" * 40}, {"runId": 901}, {"attempt": 2}):
            with self.subTest(binding=binding):
                self.certify(**binding)
                with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "current workflow run and attempt"):
                    bootstrap.prepare(self.env)
                self.assertFalse((self.base / "codexia-bootstrap").exists())

    def test_bootstrap_refuses_a_different_certified_image_or_profile(self):
        self.env["CODEXIA_BOOTSTRAP_MODE"] = "bootstrap"
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        for candidate in ({"image": self.image[:-1] + "b"}, {"profile": "core"}):
            with self.subTest(candidate=candidate):
                self.certify(**candidate)
                with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "reviewed digest and Full profile"):
                    bootstrap.prepare(self.env)
                self.assertFalse((self.base / "codexia-bootstrap").exists())

    def test_owner_setup_and_prepare_activation_require_same_run_candidate(self):
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        for mode in ("owner-setup", "prepare-activation"):
            with self.subTest(mode=mode):
                self.env["CODEXIA_BOOTSTRAP_MODE"] = mode
                with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "verified lifecycle candidate"):
                    bootstrap.prepare(self.env)
                self.assertFalse((self.base / "codexia-bootstrap").exists())

    def test_owner_operations_require_explicit_inventory_approval(self):
        self.certify()
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        for mode in ("owner-setup", "prepare-activation"):
            with self.subTest(mode=mode):
                self.env["CODEXIA_BOOTSTRAP_MODE"] = mode
                with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "explicitly approve owner setup"):
                    bootstrap.prepare(self.env)
                shutil.rmtree(self.base / "codexia-bootstrap")

    def test_owner_setup_requires_separate_edge_approval(self):
        self.certify()
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        self.env["CODEXIA_BOOTSTRAP_MODE"] = "owner-setup"
        inv = yaml.safe_load(self.contents["inventory.yml"])
        inv["all"]["children"]["codexia"]["vars"]["codexia_owner_setup_approved"] = True
        self.contents["inventory.yml"] = yaml.safe_dump(inv).encode()
        self.set_bundle()
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "explicitly approve the restricted owner setup edge"):
            bootstrap.prepare(self.env)

    def test_approved_owner_modes_stage_only_the_requested_certified_operation(self):
        self.certify()
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        inv = yaml.safe_load(self.contents["inventory.yml"])
        approvals = inv["all"]["children"]["codexia"]["vars"]
        approvals["codexia_owner_setup_approved"] = True
        approvals["codexia_owner_setup_edge_approved"] = True
        self.contents["inventory.yml"] = yaml.safe_dump(inv).encode()
        self.set_bundle()
        for mode in ("owner-setup", "prepare-activation"):
            with self.subTest(mode=mode):
                self.env["CODEXIA_BOOTSTRAP_MODE"] = mode
                out = bootstrap.prepare(self.env)
                runtime = json.loads((Path(out["control"]) / "runtime-vars.json").read_text())
                self.assertEqual(runtime["codexia_stage"], mode)
                self.assertEqual(runtime["codexia_auth_bootstrap_image"], self.image)
                self.assertFalse(runtime["codexia_database_initialization_approved"])
                shutil.rmtree(self.base / "codexia-bootstrap")

    def test_preflight_rejects_mutation_gate(self):
        self.env["CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED"] = "true"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "Read-only preflight"):
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

    def test_refuses_a_host_range_in_the_single_host_mapping(self):
        inventory = yaml.safe_load(self.contents["inventory.yml"])
        hosts = inventory["all"]["children"]["codexia"]["hosts"]
        hosts["node[01:02]"] = hosts.pop("node")
        self.contents["inventory.yml"] = yaml.safe_dump(inventory).encode()
        self.set_bundle()
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "one literal host alias"):
            bootstrap.prepare(self.env)

    def test_refuses_additional_inventory_topology_or_connection_overrides(self):
        original = self.contents["inventory.yml"]
        for section, key, value in (
            ("all", "hosts", {}),
            ("children", "other", {}),
            ("group", "children", {}),
            ("host", "ansible_ssh_executable", "/some/ssh"),
            ("vars", "ansible_ssh_executable", "/some/ssh"),
            ("vars", "codexia_stage", "deploy"),
            ("vars", "codexia_auth_bootstrap_image", self.image),
            ("vars", "codexia_database_initialization_approved", True),
            ("vars", "codexia_recreate_missing_app_database_approved", True),
            ("vars", "codexia_expected_absent_database", "123"),
            ("vars", "codexia_bootstrap_stages", ["base", "auth-runtime"]),
            ("vars", "codexia_expected_bootstrap_resume", {"clusterId": "123"}),
            ("vars", "codexia_expected_owner_setup_checkpoint", {"setupMarkerPresent": True}),
            ("vars", "codexia_owner_setup_install_intent", True),
            ("vars", "codexia_owner_setup_operation", "open"),
        ):
            with self.subTest(section=section, key=key):
                inventory = yaml.safe_load(original)
                group = inventory["all"]["children"]["codexia"]
                sections = {
                    "all": inventory["all"], "children": inventory["all"]["children"],
                    "group": group, "host": group["hosts"]["node"], "vars": group["vars"],
                }
                sections[section][key] = value
                self.contents["inventory.yml"] = yaml.safe_dump(inventory).encode()
                self.set_bundle()
                with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "Private inventory"):
                    bootstrap.prepare(self.env)
                # Invalid bundles abort before staging the SSH configuration.
                control_root = self.base / "codexia-bootstrap"
                self.assertFalse((control_root / "ssh").exists())
                if control_root.exists():
                    shutil.rmtree(control_root)

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
        self.env["CODEXIA_BOOTSTRAP_FULL_IMAGE"] = self.image
        self.certify()
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "explicitly approve"):
            bootstrap.prepare(self.env)


if __name__ == "__main__":
    unittest.main()
