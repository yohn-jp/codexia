"""Exercise the owner setup host checkpoints without production credentials."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


IMAGE = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "a" * 64
OWNER = "048058ad-f594-4fe4-bf67-f5793f99f0ce"
SCRIPT = Path(__file__).with_name("owner-setup.sh")
AUTH_BOOTSTRAP = Path(__file__).with_name("provision-auth-database.sh")
OBSERVER = Path(__file__).with_name("preflight-observe.py").resolve()
LEDGER = "sha256:" + "b" * 64
BINDING = "a" * 64


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
        self.state.chmod(0o700)
        self.runtime = self.config / "runtime.env"
        self.private_file(self.runtime, "CODEXIA_PUBLIC_ORIGIN=https://setup.example.test\n")
        self.private_file(self.config / "owner-setup.env", "CODEXIA_OWNER_SETUP_WEB_REDIRECT_URIS=https://setup.example.test/desktop\n")
        self.private_file(self.config / "owner-setup.container", f"Image={IMAGE}\n")
        self.private_file(self.state / "owner-setup.installation", "123\n")
        self.private_file(self.state / "owner-setup.intent", f"yohn-jp/codexia:401:502:123:456:{IMAGE}\n")
        self.unit = self.units / "codexia-api.container"
        self.trace = self.home / "trace"
        self.gate_state = self.home / "gate-state"
        self.gate_state.write_text("closed\n")
        self.environment = {
            **os.environ, "CODEXIA_IMAGE_REPOSITORY": "ghcr.io/yohn-jp/codexia-backend",
            "CODEXIA_TARGET_REPOSITORY": "yohn-jp/codexia", "CODEXIA_TARGET_REPOSITORY_ID": "401",
            "CODEXIA_TARGET_OWNER_ID": "502", "HOME": str(self.home),
            "PATH": f"{self.bin}:/usr/bin:/bin:{os.environ.get('PATH', '')}",
            "TRACE": str(self.trace), "OWNER": OWNER, "DESCRIPTION": json.dumps({"state": "BLOCKED"}),
            "GRANT_BINDING": BINDING, "GATE_STATE_FILE": str(self.gate_state),
        }
        self.executable("podman", r'''#!/usr/bin/env bash
set -eu
case "$1" in
    secret)
        if [[ "$2" == exists ]]; then exit 1; fi
        [[ "$2" == inspect ]] && shift 2
        python3 -c 'import json, sys; print(json.dumps([{"ID": name + "-id", "Spec": {"Name": name}} for name in sys.argv[1:]]))' "$@"
        ;;
    exec)
        if [[ "$2" == codexia-api ]]; then
            echo probe >>"$TRACE"
            exit "${PROBE_STATUS:-0}"
        fi
        case "${*: -1}" in
            *pg_database*) printf '%s\n' '123:456' ;;
            *json_build_array*)
                if [[ "${*: -1}" != *"expires_at > now()"* || "${GRANT_LIVE:-t}" == t ]]; then
                    printf '%s\n' "${GRANT_BINDING:-}"
                fi
                ;;
            *) printf '%s\n' "${GRANT_LIVE:-t}" ;;
        esac
        ;;
    run)
        if [[ "${*: -2:1}" == --replace-explicitly-approved ]]; then
            echo replaced >>"$TRACE"
            printf '%s\n' fixture-grant
            exit 0
        fi
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
        self.executable("age", '#!/usr/bin/env bash\ncat >/dev/null\n'
                        'case "$3" in\nage1fixture) printf %s encrypted-fixture ;;\n'
                        'age1other) printf %s encrypted-other-fixture ;;\n*) exit 72 ;;\nesac\n')
        self.executable("python3", f'#!/usr/bin/env bash\nexec {sys.executable!r} "$@"\n')
        self.executable("codexia-preflight-observe", f'''#!/usr/bin/env python3
import importlib.util
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("preflight_observe", {str(OBSERVER)!r})
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)
try:
    operation, descriptor, recipient, binding = sys.argv[1:]
    if descriptor != "9" or operation not in ("check-owner-handoff", "export-owner-handoff"):
        raise ValueError("unexpected selector")
    envelope = observer.read_owner_handoff(Path(os.environ["HOME"]), 9, recipient, binding)
    if operation == "export-owner-handoff":
        sys.stdout.buffer.write(envelope)
except (ValueError, OSError):
    sys.exit(1)
''')
        self.executable("systemctl", '#!/usr/bin/env bash\necho "$*" >>"$TRACE"\n'
                        'if [[ "$*" == "is-active codexia-cloudflared.service" ]]; then echo active; fi\n')
        self.executable("curl", '#!/usr/bin/env bash\necho "curl $*" >>"$TRACE"\nprintf 200\n')
        self.executable("sudo", '#!/usr/bin/env bash\necho "sudo $*" >>"$TRACE"\n'
                        '[[ "$1" == -n && "$2" == /usr/local/sbin/codexia-api-gate ]] || exit 90\n'
                        'case "$3" in\n'
                        ' status) cat "$GATE_STATE_FILE";;\n'
                        ' close) printf "closed\\n" >"$GATE_STATE_FILE";;\n'
                        ' open) printf "open\\n" >"$GATE_STATE_FILE";;\n'
                        ' *) exit 91;;\n'
                        'esac\n')
        self.executable("codexia-require-clean-api-target", '#!/usr/bin/env bash\necho clean >>"$TRACE"\n')

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

    def bound_handoff(self, recipient="age1fixture"):
        ciphertext = "encrypted-fixture"
        self.private_file(self.state / "owner-setup.age", ciphertext)
        self.private_file(self.state / "owner-setup.age.receipt.json", json.dumps({
            "format": "codexia-owner-handoff/v1", "recipient": recipient,
            "grantBindingSha256": self.environment["GRANT_BINDING"],
            "envelopeSha256": hashlib.sha256(ciphertext.encode()).hexdigest(),
        }))

    def test_locked_application_resume_rejects_changed_binding_or_ledger(self):
        self.executable("podman", r'''#!/usr/bin/env bash
set -eu
case "$1" in
    exec)
        query=$(cat)
        [[ "$query" == *pg_control_system* && "$query" == *codexia_auth* &&
           "$query" == *codexia_schema_migrations* && "$query" == *"NOT EXISTS"* ]] || exit 72
        printf '%s\n' "${LIVE_DATABASE:-123:456}"
        ;;
    run)
        [[ "${*: -2:1}" == require-ledger && "${*: -1}" == "$LEDGER" ]] || exit 73
        echo ledger >>"$TRACE"
        exit "${LEDGER_STATUS:-0}"
        ;;
    *) exit 74 ;;
esac
''')
        (self.state / "owner-setup.installation").unlink()
        intent = self.state / "owner-setup.intent"
        self.private_file(intent, f"yohn-jp/codexia:401:502:123:456:{IMAGE}\n")
        self.environment["LEDGER"] = LEDGER
        lock = self.state / "host.lock"

        def verify():
            return subprocess.run(
                ["bash", str(AUTH_BOOTSTRAP), "verify-bootstrap-resume", str(lock), IMAGE, "123:456", LEDGER],
                env=self.environment, text=True, capture_output=True, check=False,
            )

        with lock.open("w") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertNotEqual(verify().returncode, 0)
            self.assertFalse(self.trace.exists())
        self.environment["LIVE_DATABASE"] = "123:654"
        result = verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("current database", result.stderr)
        self.assertEqual(self.trace.read_text().splitlines(), ["clean"])
        self.environment["LIVE_DATABASE"] = "123:456"
        self.environment["LEDGER_STATUS"] = "1"
        self.assertNotEqual(verify().returncode, 0)
        self.assertIn("ledger", self.trace.read_text())
        self.environment["LEDGER_STATUS"] = "0"
        result = verify()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_empty_auth_resume_rechecks_catalog_under_the_lock_before_migrating(self):
        self.executable("codexia-auth-runtime-bootstrap", AUTH_BOOTSTRAP.read_text())
        self.executable("codexia-require-clean-api-target", '''#!/usr/bin/env bash
if flock --exclusive --nonblock "$HOME/.local/state/codexia-deploy/host.lock" true; then exit 75; fi
echo clean >>"$TRACE"
''')
        self.executable("podman", r'''#!/usr/bin/env bash
set -eu
case "$1" in
    exec)
        if [[ "${*: -1}" == *pg_control_system* ]]; then
            printf '%s\n' '123:456'
        else
            query=$(cat)
            if [[ "$query" == *pg_control_system* ]]; then
                [[ "$query" == *pg_namespace* && "$query" == *pg_depend* && "$query" == *pg_default_acl* ]] || exit 76
                printf '%s' "${EMPTY_AUTH_DATABASE:-}"
            else
                [[ "$query" == *codexia_auth_check* ]]
            fi
        fi
        ;;
    run)
        case "${*: -1}" in
            sha256:*) [[ "${*: -2:1}" == require-ledger && "${*: -1}" == "$LEDGER" ]]; echo ledger >>"$TRACE" ;;
            --apply) echo migrated >>"$TRACE" ;;
            --describe) printf '%s\n' "$DESCRIPTION" ;;
            *) exit 77 ;;
        esac
        ;;
    *) exit 78 ;;
esac
''')
        marker = self.state / "owner-setup.installation"
        marker.unlink()
        self.private_file(self.state / "owner-setup.intent", f"yohn-jp/codexia:401:502:123:456:{IMAGE}\n")
        self.private_file(self.state / "host.lock", "")
        self.environment["LEDGER"] = LEDGER
        rejected = self.run_setup("--initialize", "--resume-bootstrap", "123:456", LEDGER)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertEqual(self.trace.read_text().splitlines(), ["clean"])
        self.environment["EMPTY_AUTH_DATABASE"] = "123:456"
        resumed = self.run_setup("--initialize", "--resume-bootstrap", "123:456", LEDGER)
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(self.trace.read_text().splitlines(), ["clean", "clean", "ledger", "migrated"])
        self.assertEqual(marker.read_text(), "123\n")

    def test_protected_owner_operation_revalidates_observed_credentials_under_host_lock(self):
        self.private_file(self.state / "owner-setup.intent", f"yohn-jp/codexia:401:502:123:456:{IMAGE}\n")
        self.environment["CODEXIA_OWNER_SETUP_EXPECTED_SECRET_SET_SHA256"] = "a" * 64
        observer = self.home / ".local/bin/codexia-preflight-observe"
        observer.write_text('#!/usr/bin/env bash\n'
                            '[[ "$1" == verify-secret-identities && "$2" == "$FIXTURE_SECRET_SET" ]] && '
                            '[[ /proc/$$/fd/9 -ef "$HOME/.local/state/codexia-deploy/host.lock" ]]\n')
        observer.chmod(0o700)
        self.environment["FIXTURE_SECRET_SET"] = "b" * 64
        denied = self.run_setup("--converge", "NEW_APPROVED", "age1fixture")
        self.assertNotEqual(denied.returncode, 0)
        self.assertIn("Podman credential identities changed after approval", denied.stderr)
        self.assertFalse((self.state / "owner-setup.age").exists())
        self.environment["FIXTURE_SECRET_SET"] = "a" * 64
        allowed = self.run_setup("--converge", "NEW_APPROVED", "age1fixture")
        self.assertEqual(allowed.returncode, 0, allowed.stderr)

    def test_initialized_schema_with_matching_intent_can_issue_only_first_grant(self):
        self.private_file(self.state / "owner-setup.intent", f"yohn-jp/codexia:401:502:123:456:{IMAGE}\n")
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

    def test_issued_grant_exports_only_for_original_recipient_until_approved_reissue(self):
        self.private_file(self.state / "owner-setup.intent", f"yohn-jp/codexia:401:502:123:456:{IMAGE}\n")
        issued = self.run_setup("--converge", "NEW_APPROVED", "age1fixture")
        self.assertEqual(issued.returncode, 0, issued.stderr)
        self.environment["DESCRIPTION"] = json.dumps({"state": "SETUP_PENDING", "grantId": OWNER})
        original = self.run_setup("--export-handoff", "age1fixture", BINDING)
        self.assertEqual(original.returncode, 0, original.stderr)
        self.assertEqual(original.stdout, "encrypted-fixture")
        changed = self.run_setup("--export-handoff", "age1other", BINDING)
        self.assertNotEqual(changed.returncode, 0)
        self.assertEqual(changed.stdout, "")
        self.assertIn("reviewed recipient", changed.stderr)
        converged = self.run_setup("--converge", "NEW_APPROVED", "age1other")
        self.assertNotEqual(converged.returncode, 0)
        self.assertEqual(self.trace.read_text().splitlines().count("issued"), 1)
        self.assertEqual((self.state / "owner-setup.age").read_text(), original.stdout)

        # An older envelope may stay valid for the original Owner. The CLI
        # exporter refuses it because its recipient has no protected binding.
        (self.state / "owner-setup.age.receipt.json").unlink()
        legacy = self.run_setup("--export-handoff", "age1fixture", BINDING)
        self.assertNotEqual(legacy.returncode, 0)
        self.assertEqual(legacy.stdout, "")
        self.assertIn("independently approving reissue", legacy.stderr)

        replacement_binding = "c" * 64
        self.environment["GRANT_BINDING"] = replacement_binding
        replacement = self.run_setup("--replace-explicitly-approved", OWNER, "age1other")
        self.assertEqual(replacement.returncode, 0, replacement.stderr)
        stale = self.run_setup("--export-handoff", "age1other", BINDING)
        self.assertNotEqual(stale.returncode, 0)
        self.assertEqual(stale.stdout, "")
        current = self.run_setup("--export-handoff", "age1other", replacement_binding)
        self.assertEqual(current.returncode, 0, current.stderr)
        self.assertEqual(current.stdout, "encrypted-other-fixture")

    def test_interrupted_replacement_with_ciphertext_but_no_new_receipt_cannot_export(self):
        self.private_file(self.state / "owner-setup.intent", f"yohn-jp/codexia:401:502:123:456:{IMAGE}\n")
        issued = self.run_setup("--converge", "NEW_APPROVED", "age1fixture")
        self.assertEqual(issued.returncode, 0, issued.stderr)
        receipt = self.state / "owner-setup.age.receipt.json"
        original_receipt = receipt.read_bytes()
        self.executable("mv", '#!/usr/bin/env bash\n'
                        'if [[ "${*: -1}" == */owner-setup.age.receipt.json ]]; then exit 1; fi\n'
                        f'exec {shutil.which("mv")!r} "$@"\n')
        self.environment["GRANT_BINDING"] = "c" * 64
        replacement = self.run_setup("--replace-explicitly-approved", OWNER, "age1other")
        self.assertNotEqual(replacement.returncode, 0)
        self.assertTrue((self.state / "owner-setup.age.pending").exists())
        self.assertEqual((self.state / "owner-setup.age").read_text(), "encrypted-other-fixture")
        self.assertEqual(receipt.read_bytes(), original_receipt)
        delivery = self.run_setup("--export-handoff", "age1other", self.environment["GRANT_BINDING"])
        self.assertNotEqual(delivery.returncode, 0)
        self.assertEqual(delivery.stdout, "")

    def test_replaced_grant_requires_a_fresh_r5_approval_before_gate_open(self):
        self.environment["DESCRIPTION"] = json.dumps({"state": "SETUP_PENDING", "grantId": OWNER})
        self.environment["GRANT_BINDING"] = "b" * 64
        self.bound_handoff()
        expected = {
            "setupMarkerPresent": True, "grantBindingSha256": "a" * 64,
            "pendingHandoff": False, "encryptedHandoffPresent": True, "settingsSha256": None,
        }
        self.environment["CODEXIA_OWNER_SETUP_EXPECTED_CHECKPOINT"] = json.dumps(expected)
        result = self.run_setup("--converge", "NEW_APPROVED", "age1fixture")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checkpoint changed", result.stderr)
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.trace.exists())

        expected["grantBindingSha256"] = "b" * 64
        self.environment["CODEXIA_OWNER_SETUP_EXPECTED_CHECKPOINT"] = json.dumps(expected)
        result = self.run_setup("--converge", "NEW_APPROVED", "age1fixture")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("sudo -n /usr/local/sbin/codexia-api-gate open", self.trace.read_text())

    def test_prepare_requires_reapproval_if_subject_settings_committed_after_preflight(self):
        self.environment["GRANT_BINDING"] = "a" * 64
        self.private_file(self.runtime, f"CODEXIA_OAUTH_OWNER_SUBJECT={OWNER}\n")
        expected = {
            "setupMarkerPresent": True, "grantBindingSha256": "a" * 64,
            "pendingHandoff": False, "encryptedHandoffPresent": False, "settingsSha256": None,
        }
        self.environment["CODEXIA_OWNER_SETUP_EXPECTED_CHECKPOINT"] = json.dumps(expected)
        result = self.run_setup("--prepare-activation")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checkpoint changed", result.stderr)
        self.assertFalse(self.trace.exists())

        expected["settingsSha256"] = hashlib.sha256(self.runtime.read_bytes()).hexdigest()
        self.environment["CODEXIA_OWNER_SETUP_EXPECTED_CHECKPOINT"] = json.dumps(expected)
        result = self.run_setup("--prepare-activation")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified", self.trace.read_text())

    def test_setup_readiness_verification_precedes_gate_open(self):
        self.environment["DESCRIPTION"] = json.dumps({"state": "SETUP_PENDING", "grantId": OWNER})
        self.bound_handoff()
        self.environment["PROBE_STATUS"] = "1"
        result = self.run_setup("--converge", "OBSERVE_ONLY", "age1fixture")
        self.assertNotEqual(result.returncode, 0)
        commands = self.trace.read_text().splitlines()
        self.assertLess(commands.index("--user start codexia-api.service"), commands.index("probe"))
        self.assertLess(commands.index("probe"), commands.index("sudo -n /usr/local/sbin/codexia-api-gate close"))
        self.assertLess(commands.index("sudo -n /usr/local/sbin/codexia-api-gate close"),
                        commands.index("--user stop codexia-api.service"))
        self.assertNotIn("sudo -n /usr/local/sbin/codexia-api-gate open", commands)

    def test_staged_public_config_must_match_certified_frontend(self):
        self.environment.update({
            "CODEXIA_OWNER_SETUP_EXPECTED_ORIGIN": "https://setup.example.test",
            "CODEXIA_OWNER_SETUP_EXPECTED_WEB_CLIENT_ID": "fixture-web",
            "CODEXIA_OWNER_SETUP_EXPECTED_WEB_REDIRECT_URIS": (
                "https://setup.example.test/desktop,https://setup.example.test/mobile"
            ),
            "DESCRIPTION": json.dumps({"state": "SETUP_PENDING", "grantId": OWNER}),
        })
        self.private_file(self.runtime, self.runtime.read_text() + "CODEXIA_OAUTH_OWNER_CLIENT_IDS=fixture-web,fixture-ios\n")
        self.bound_handoff()
        result = self.run_setup("--converge", "OBSERVE_ONLY", "age1fixture")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from the certified frontend", result.stderr)
        self.assertFalse(self.trace.exists())
        self.private_file(self.config / "owner-setup.env",
                          "CODEXIA_OWNER_SETUP_WEB_REDIRECT_URIS=https://setup.example.test/mobile,https://setup.example.test/desktop\n")
        result = self.run_setup("--converge", "OBSERVE_ONLY", "age1fixture")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_expired_grant_and_interrupted_reissue_stop_even_with_an_envelope(self):
        self.environment["DESCRIPTION"] = json.dumps({"state": "SETUP_PENDING", "grantId": OWNER})
        self.bound_handoff()
        self.environment["GRANT_LIVE"] = "f"
        self.assertNotEqual(self.run_setup("--converge", "NEW_APPROVED", "age1fixture").returncode, 0)
        self.environment["GRANT_LIVE"] = "t"
        self.private_file(self.state / "owner-setup.age.pending", "handoff-in-progress")
        self.assertNotEqual(self.run_setup("--converge", "NEW_APPROVED", "age1fixture").returncode, 0)
        self.assertNotIn("start", self.trace.read_text())

    def test_marker_loss_resumes_only_against_the_bound_fresh_database(self):
        (self.state / "owner-setup.installation").unlink()
        intent = self.state / "owner-setup.intent"
        self.private_file(intent, f"yohn-jp/codexia:401:502:123:999:{IMAGE}\n")
        self.assertNotEqual(self.run_setup("--converge", "NEW_APPROVED", "age1fixture").returncode, 0)
        self.assertNotIn("issued", self.trace.read_text())
        self.private_file(intent, f"yohn-jp/codexia:401:502:123:456:{IMAGE}\n")
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

    def test_prepare_does_not_mark_ready_while_publication_gate_is_open(self):
        self.gate_state.write_text("open\n")
        result = self.run_setup("--prepare-activation")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.state / "owner-setup.promoted").exists())

    def test_existing_setup_unit_is_regenerated_and_stopped_before_marking_ready(self):
        self.private_file(self.unit, f"Image={IMAGE}\n")
        result = self.run_setup("--prepare-activation")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.unit.exists())
        commands = self.trace.read_text().splitlines()
        self.assertLess(commands.index("sudo -n /usr/local/sbin/codexia-api-gate close"), commands.index("--user stop codexia-api.service"))
        self.assertLess(commands.index("--user stop codexia-api.service"), commands.index("clean"))
        self.assertIn(f"CODEXIA_OAUTH_OWNER_SUBJECT={OWNER}", self.runtime.read_text())


if __name__ == "__main__":
    unittest.main()
