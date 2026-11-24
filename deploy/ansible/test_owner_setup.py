"""Exercise the owner setup host checkpoints without production credentials."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


IMAGE = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "a" * 64
OWNER = "048058ad-f594-4fe4-bf67-f5793f99f0ce"
SCRIPT = Path(__file__).with_name("owner-setup.sh")


class OwnerSetupTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.home = Path(self.scratch.name)
        self.state = self.home / ".local/state/codexia-deploy"
        self.config = self.home / ".config/codexia-auth"
        self.units = self.home / ".config/containers/systemd"
        self.bin = self.home / ".local/bin"
        for directory in (self.state, self.config, self.units, self.bin):
            directory.mkdir(parents=True)
        self.runtime = self.config / "runtime.env"
        self.private_file(self.runtime, "CODEXIA_PUBLIC_ORIGIN=https://setup.example.test\n")
        self.private_file(self.config / "owner-setup.env", "CODEXIA_OWNER_SETUP_WEB_REDIRECT_URIS=https://setup.example.test/desktop\n")
        self.private_file(self.config / "owner-setup.container", f"Image={IMAGE}\n")
        self.private_file(self.state / "owner-setup.installation", "123\n")
        self.unit = self.units / "codexia-api.container"
        self.trace = self.home / "trace"
        self.environment = {
            **os.environ, "HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin",
            "TRACE": str(self.trace), "OWNER": OWNER, "DESCRIPTION": json.dumps({"state": "BLOCKED"}),
        }
        self.executable("podman", r'''#!/bin/bash
set -eu
case "$1" in
    exec) case "${*: -1}" in *pg_database*) printf '%s\n' '123:456' ;; *) printf '%s\n' "${GRANT_LIVE:-t}" ;; esac ;;
    run)
        case "${*: -1}" in
            --describe) printf '%s\n' "$DESCRIPTION" ;;
            --issue-new-approved) echo issued >>"$TRACE"; printf '%s\n' fixture-grant ;;
            --prepare-activation) echo prepared >>"$TRACE"; printf '%s\n' "$OWNER" ;;
            */verify-auth-clients.js) echo verified >>"$TRACE" ;;
            --apply) echo migrated >>"$TRACE" ;;
            *) exit 70 ;;
        esac ;;
    *) exit 70 ;;
esac
''')
        self.executable("age", '#!/bin/bash\ncat >/dev/null\nprintf %s encrypted-fixture\n')
        self.executable("systemctl", '#!/bin/bash\necho "$*" >>"$TRACE"\n'
                        'if [[ "$2" == show ]]; then printf "%s\\n" "${TUNNEL_STATE:-inactive}"; fi\n')
        self.executable("codexia-require-clean-api-target", '#!/bin/bash\necho clean >>"$TRACE"\n')

    def executable(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o700)

    @staticmethod
    def private_file(path, content):
        path.write_text(content)
        path.chmod(0o600)

    def run_setup(self, operation, *args):
        return subprocess.run(["bash", str(SCRIPT), operation, IMAGE, *args], env=self.environment,
                              text=True, capture_output=True, check=False)

    def test_initialized_schema_with_matching_intent_can_issue_only_first_grant(self):
        self.private_file(self.state / "owner-setup.intent", f"123:456:{IMAGE}\n")
        result = self.run_setup("--converge", "NEW_APPROVED", "age1fixture")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.state / "owner-setup.age").read_text(), "encrypted-fixture")
        self.assertEqual(self.trace.read_text().splitlines().count("issued"), 1)
        self.assertNotIn("migrated", self.trace.read_text())
        self.environment["DESCRIPTION"] = json.dumps({"state": "SETUP_PENDING", "grantId": OWNER})
        result = self.run_setup("--converge", "NEW_APPROVED", "age1fixture")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.trace.read_text().splitlines().count("issued"), 1)

    def test_pending_grant_with_missing_ciphertext_stops_before_setup_start(self):
        self.environment["DESCRIPTION"] = json.dumps({"state": "SETUP_PENDING", "grantId": OWNER})
        result = self.run_setup("--converge", "OBSERVE_ONLY", "age1fixture")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("start", self.trace.read_text())
        self.assertFalse(self.unit.exists())

    def test_expired_grant_and_interrupted_reissue_stop_even_with_an_envelope(self):
        self.environment["DESCRIPTION"] = json.dumps({"state": "SETUP_PENDING", "grantId": OWNER})
        self.private_file(self.state / "owner-setup.age", "encrypted-fixture")
        self.environment["GRANT_LIVE"] = "f"
        self.assertNotEqual(self.run_setup("--converge", "NEW_APPROVED", "age1fixture").returncode, 0)
        self.environment["GRANT_LIVE"] = "t"
        self.private_file(self.state / "owner-setup.age.pending", "handoff-in-progress")
        self.assertNotEqual(self.run_setup("--converge", "NEW_APPROVED", "age1fixture").returncode, 0)
        self.assertNotIn("start", self.trace.read_text())

    def test_marker_loss_resumes_only_against_the_bound_fresh_database(self):
        (self.state / "owner-setup.installation").unlink()
        intent = self.state / "owner-setup.intent"
        self.private_file(intent, f"123:999:{IMAGE}\n")
        self.assertNotEqual(self.run_setup("--converge", "NEW_APPROVED", "age1fixture").returncode, 0)
        self.assertNotIn("issued", self.trace.read_text())
        self.private_file(intent, f"123:456:{IMAGE}\n")
        result = self.run_setup("--converge", "NEW_APPROVED", "age1fixture")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.state / "owner-setup.installation").read_text(), "123\n")
        self.assertIn("issued", self.trace.read_text())

    def test_runtime_commit_without_promotion_marker_reuses_normal_verifier(self):
        self.private_file(self.runtime, f"CODEXIA_OAUTH_OWNER_SUBJECT={OWNER}\n")
        result = self.run_setup("--prepare-activation")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.state / "owner-setup.promoted").exists())
        self.assertIn("verified", self.trace.read_text())
        self.assertNotIn("prepared", self.trace.read_text())

    def test_prepare_does_not_mark_ready_while_tunnel_without_setup_unit_is_active(self):
        self.environment["TUNNEL_STATE"] = "active"
        result = self.run_setup("--prepare-activation")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.state / "owner-setup.promoted").exists())

    def test_existing_setup_unit_is_regenerated_and_stopped_before_marking_ready(self):
        self.private_file(self.unit, f"Image={IMAGE}\n")
        result = self.run_setup("--prepare-activation")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.unit.exists())
        commands = self.trace.read_text().splitlines()
        self.assertLess(commands.index("--user stop codexia-tunnel.service codexia-api.service"), commands.index("clean"))
        self.assertIn(f"CODEXIA_OAUTH_OWNER_SUBJECT={OWNER}", self.runtime.read_text())


if __name__ == "__main__":
    unittest.main()
