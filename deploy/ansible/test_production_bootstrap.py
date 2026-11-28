"""Production controller tests using independent disposable SSH identities."""
import base64
import importlib.util
import json
from pathlib import Path
import stat
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
        self.env = {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "yohn-jp/codexia", "GITHUB_REF": "refs/heads/main",
            "GITHUB_REPOSITORY_ID": "401", "GITHUB_REPOSITORY_OWNER_ID": "502",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "RUNNER_TEMP": directory.name, "GITHUB_SHA": "a" * 40,
            "GITHUB_RUN_ID": "10", "GITHUB_RUN_ATTEMPT": "2", "CODEXIA_BOOTSTRAP_HOST": self.host,
            "CODEXIA_BOOTSTRAP_SSH_USER": "admin", "CODEXIA_BOOTSTRAP_MODE": "preflight",
            "CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY": (self.tmp / "admin").read_text(),
            "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS": self.host + " " + (self.tmp / "host.pub").read_text(),
            "CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED": "false",
        }
        self.image = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "b" * 64
        self.binding = {"repository": self.env["GITHUB_REPOSITORY"], "repositoryId": 401, "ownerId": 502}
        self.env["CODEXIA_PUBLIC_ORIGIN"] = json.loads(Path(__file__).resolve().parents[1]
                                                        .joinpath("production.json").read_text())["publicOrigin"]
        self.target = {**self.binding, "origin": self.env["CODEXIA_PUBLIC_ORIGIN"],
                       "accountId": "a" * 32, "tunnelId": "eb001547-7cb9-4f78-8742-789d122e65f3"}
        self.tunnel_token = base64.b64encode(json.dumps({"a": self.target["accountId"], "t": self.target["tunnelId"],
                                                       "s": "fixture"}).encode()).decode()
        self.receipt = {**self.binding, "sourceSha": self.env["GITHUB_SHA"], "runId": 10, "attempt": 2,
                        "candidateBackend": {"identity": {"profile": "full"}, "verifyRun": self.binding, "image": self.image}}

    def mutation(self, mode="bootstrap"):
        self.env["CODEXIA_BOOTSTRAP_MODE"] = mode
        if mode == "bootstrap":
            self.env["CODEXIA_RUNTIME_SSH_PUBLIC_KEY"] = " ".join((self.tmp / "runtime.pub").read_text().split()[:2])
            self.env["CODEXIA_TUNNEL_TOKEN"] = self.tunnel_token
            self.env["CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET"] = json.dumps(self.target)
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

    def test_access_only_needs_connection(self):
        target, values, runtime = self.prepare()
        self.assertEqual(runtime["codexia_stage"], "inspect")
        self.assertFalse((target / "tunnel-token").exists())
        self.assertNotIn("codexia_secrets_approved", values)

    def test_bootstrap_generates_inventory_and_binds_certified_image(self):
        self.mutation()
        self.env["CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED"] = "true"
        target, values, runtime = self.prepare()
        self.assertIs(values["codexia_managed_bootstrap_secrets"], True)
        self.assertIs(runtime["codexia_database_initialization_approved"], True)
        self.assertNotIn("codexia_owner_setup_age_recipient", values)
        self.assertEqual(runtime["codexia_auth_bootstrap_image"], self.image)
        token = Path(values["codexia_tunnel_token_file"])
        self.assertEqual(stat.S_IMODE(token.stat().st_mode), 0o600)
        self.assertEqual(token.read_text(), self.tunnel_token)
        self.assertEqual(sorted(f.name for f in target.iterdir()), ["inventory.yml", "runtime-vars.json", "tunnel-token"])
        self.assertNotIn(self.tunnel_token, (target / "inventory.yml").read_text())

    def test_existing_installation_can_adopt_its_tunnel_without_resupply(self):
        self.mutation()
        self.env.pop("CODEXIA_TUNNEL_TOKEN")
        _, values, _ = self.prepare()
        self.assertNotIn("codexia_tunnel_token_file", values)

    def test_preparation_does_not_need_r4_or_handoff_secrets(self):
        self.mutation("prepare-activation")
        _, values, _ = self.prepare()
        self.assertFalse(values["codexia_owner_setup_edge_approved"])
        self.assertNotIn("codexia_tunnel_token_file", values)

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

    def test_refuses_token_for_another_cloudflare_target(self):
        self.mutation()
        self.env["CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET"] = json.dumps({**self.target, "accountId": "b" * 32})
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "Cloudflare target"):
            self.prepare()

    def test_refuses_same_name_certificate_for_another_repository_id(self):
        self.mutation()
        self.env["GITHUB_REPOSITORY_ID"] = "818"
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "different repository"):
            self.prepare()

    def test_refuses_cloudflare_target_from_another_repository(self):
        self.mutation()
        self.env["CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET"] = json.dumps({**self.target, "repositoryId": 818})
        with self.assertRaisesRegex(bootstrap.InvalidBootstrapInput, "Cloudflare target"):
            self.prepare()
