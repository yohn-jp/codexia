"""Production controller tests using independent disposable SSH identities."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

spec = importlib.util.spec_from_file_location("bootstrap", Path(__file__).with_name("prepare-production-bootstrap.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.tmp = Path(directory.name)
        for name in ("admin", "runtime", "host"):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.tmp / name)], check=True)
        self.host = "vm.example.invalid"
        cloudflared = self.tmp / "cloudflared"
        cloudflared.write_text("#!/bin/sh\nexit 0\n")
        cloudflared.chmod(0o700)
        self.env = {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "yohn-jp/codexia", "GITHUB_REF": "refs/heads/main",
            "GITHUB_REPOSITORY_ID": "401", "GITHUB_REPOSITORY_OWNER_ID": "502",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "RUNNER_TEMP": directory.name, "GITHUB_SHA": "a" * 40,
            "GITHUB_RUN_ID": "10", "GITHUB_RUN_ATTEMPT": "2", "CODEXIA_BOOTSTRAP_HOST": self.host,
            "CODEXIA_BOOTSTRAP_SSH_USER": "admin", "CODEXIA_BOOTSTRAP_MODE": "preflight",
            "CODEXIA_MANAGEMENT_HOSTNAME": self.host,
            "CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET": json.dumps({
                "repository": "yohn-jp/codexia", "repositoryId": 401, "ownerId": 502,
                "sshHostname": self.host, "sshPolicyId": "10000000-0000-4000-8000-000000000001",
            }),
            "CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY": (self.tmp / "admin").read_text(),
            "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS": self.host + " " + (self.tmp / "host.pub").read_text(),
            "CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED": "false",
        }
        self.image = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "b" * 64
        self.binding = {"repository": self.env["GITHUB_REPOSITORY"], "repositoryId": 401, "ownerId": 502}
        self.env["CODEXIA_PUBLIC_ORIGIN"] = json.loads(Path(__file__).resolve().parents[1]
                                                        .joinpath("production.json").read_text())["publicOrigin"]
        self.receipt = {**self.binding, "sourceSha": self.env["GITHUB_SHA"], "runId": 10, "attempt": 2,
                        "candidateBackend": {"identity": {"profile": "full"}, "verifyRun": self.binding, "image": self.image}}

    def mutation(self, mode="bootstrap"):
        self.env["CODEXIA_BOOTSTRAP_MODE"] = mode
        if mode == "bootstrap":
            self.env["CODEXIA_RUNTIME_SSH_PUBLIC_KEY"] = " ".join((self.tmp / "runtime.pub").read_text().split()[:2])
        if mode == "owner-setup":
            self.env["CODEXIA_OWNER_SETUP_AGE_RECIPIENT"] = "age1fixture"
        (self.tmp / "codexia-lifecycle-candidate.json").write_text(json.dumps(self.receipt))

    def prepare(self):
        target = Path(bootstrap.prepare(self.env)["control"])
        group = yaml.safe_load((target / "inventory.yml").read_text())["all"]["children"]["codexia"]
        self.assertEqual(list(group["hosts"]), ["codexia-target"])
        connection = group["hosts"]["codexia-target"]
        self.assertEqual(connection["ansible_user"], "admin")
        self.assertEqual(connection["ansible_host"], "codexia-bootstrap-target")
        runtime = json.loads((target / "runtime-vars.json").read_text())
        self.assertNotIn("ansible_host", runtime)
        return target, group["vars"], runtime

    def test_bootstrap_config_routes_pinned_ssh_via_protected_cloudflare(self):
        target, _, _ = self.prepare()
        config = target.parent / "ssh/config"
        effective = subprocess.run(["ssh", "-G", "-F", str(config), "codexia-bootstrap-target"],
                                   check=True, capture_output=True, text=True).stdout.lower()
        self.assertIn(f"hostname {self.host}", effective)
        self.assertIn("stricthostkeychecking true", effective)
        self.assertIn("proxycommand ", effective)
        self.assertIn("cloudflared-proxy.sh", effective)
        self.assertNotIn("proxycommand none", effective)
        self.assertIn("userknownhostsfile ", effective)

    def test_bootstrap_refuses_unbound_cloudflare_management(self):
        self.env["CODEXIA_MANAGEMENT_HOSTNAME"] = "other.example.invalid"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "management hostname"):
            self.prepare()

    def test_bootstrap_refuses_foreign_cloudflare_target(self):
        target = json.loads(self.env["CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET"])
        target["repositoryId"] = 999
        self.env["CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET"] = json.dumps(target)
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "protected repository"):
            self.prepare()

    def test_bootstrap_refuses_missing_cloudflared(self):
        (self.tmp / "cloudflared").unlink()
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "transport is unavailable"):
            self.prepare()

    def test_access_only_needs_connection(self):
        target, values, runtime = self.prepare()
        self.assertEqual(runtime["codexia_stage"], "inspect")
        self.assertEqual(sorted(f.name for f in target.iterdir()), ["inventory.yml", "runtime-vars.json"])
        self.assertNotIn("codexia_secrets_approved", values)

    def test_bootstrap_generates_inventory_and_binds_certified_image(self):
        self.mutation()
        self.env["CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED"] = "true"
        target, values, runtime = self.prepare()
        self.assertIs(values["codexia_managed_bootstrap_secrets"], True)
        self.assertIs(runtime["codexia_database_initialization_approved"], True)
        self.assertNotIn("codexia_owner_setup_age_recipient", values)
        self.assertEqual(runtime["codexia_auth_bootstrap_image"], self.image)
        self.assertEqual(sorted(f.name for f in target.iterdir()), ["inventory.yml", "runtime-vars.json"])

    def test_preparation_does_not_need_r4_or_handoff_secrets(self):
        self.mutation("prepare-activation")
        _, values, _ = self.prepare()
        self.assertFalse(values["codexia_owner_setup_edge_approved"])

    def test_owner_setup_uses_only_handoff_recipient(self):
        self.mutation("owner-setup")
        _, values, _ = self.prepare()
        self.assertTrue(values["codexia_owner_setup_edge_approved"])
        self.assertEqual(values["codexia_owner_setup_age_recipient"], "age1fixture")
        self.assertNotIn("codexia_host_approved", values)

    def test_owner_setup_refuses_missing_handoff_recipient(self):
        self.mutation("owner-setup")
        del self.env["CODEXIA_OWNER_SETUP_AGE_RECIPIENT"]
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "CODEXIA_OWNER_SETUP_AGE_RECIPIENT"):
            self.prepare()

    def test_independent_admin_and_runtime_keys(self):
        self.mutation()
        self.env["CODEXIA_RUNTIME_SSH_PUBLIC_KEY"] = " ".join((self.tmp / "admin.pub").read_text().split()[:2])
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "independent"):
            self.prepare()

    def test_refuses_missing_or_unbound_certificate(self):
        self.receipt["runId"] = 99
        self.mutation()
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "current workflow"):
            self.prepare()

    def test_refuses_unpinned_host(self):
        self.env["CODEXIA_BOOTSTRAP_HOST"] = "other.example.invalid"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "pinned"):
            self.prepare()

    def test_refuses_non_admin_user(self):
        self.env["CODEXIA_BOOTSTRAP_SSH_USER"] = "codexia"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "independent"):
            self.prepare()

    def test_refuses_same_name_certificate_for_another_repository_id(self):
        self.mutation()
        self.env["GITHUB_REPOSITORY_ID"] = "818"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "different repository"):
            self.prepare()
