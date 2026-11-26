"""Exercise real age sealing and independent recovery against a bounded S3 fixture."""

import base64
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import bootstrap_escrow as escrow
import bootstrap_snapshot as snapshot
from test_s3_transfer import FakeClientError, FakeS3Client


@unittest.skipUnless(shutil.which("age") and shutil.which("age-keygen"), "age tools required")
class BootstrapEscrowTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.host_id = snapshot.sha(Path("/etc/machine-id").read_text().strip().encode())
        self.identity = self.root / "age.key"
        subprocess.run(["age-keygen", "-o", str(self.identity)], check=True, capture_output=True)
        self.recipient = subprocess.check_output(["age-keygen", "-y", str(self.identity)]).decode().strip()
        self.profile = escrow.validate_profile({"schemaVersion": 1, "provider": "aws-s3",
                                                "region": "us-east-1", "bucket": "test-bucket", "prefix": "escrow"})
        self.client = FakeS3Client()
        self.values = {name: "fixture-" + name for name in snapshot.REQUIRED}
        self.values["codexia-tunnel-token"] += "\n"
        self.env = {"HOME": str(self.root), "PATH": str(self.root) + os.pathsep + os.environ["PATH"]}
        self.state = self.root / ".local/state/codexia-deploy"
        self.state.mkdir(mode=0o700, parents=True)
        (self.state / "host.lock").touch(mode=0o600)
        fake = self.root / "podman"
        fake.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
if sys.argv[1:4] == ["secret", "exists", "codexia-oidc-client-secret"]:
    sys.exit(1)
if sys.argv[1:4] != ["secret", "inspect", "--showsecret"]:
    sys.exit(125)
values = json.loads((Path(os.environ["HOME"]) / "values.json").read_text())
print(json.dumps([{"ID": name + "-id", "Spec": {"Name": name}, "SecretData": values[name]}
                  for name in sys.argv[4:]]))
""")
        fake.chmod(0o700)
        (self.root / "values.json").write_text(json.dumps(self.values))
        ids = {name: snapshot.sha(json.dumps(name + "-id").encode()) for name in self.values}
        marker = self.state / "bootstrap-secret-ids.json"
        marker.write_text(json.dumps(ids))
        marker.chmod(0o600)

    def capture(self, seal=True):
        with patch.dict(os.environ, self.env):
            return snapshot.snapshot(self.recipient, self.host_id, seal)

    def test_round_trip_retry_and_selective_restore(self):
        sealed = self.capture()
        self.assertNotIn("fixture-", json.dumps(sealed))
        self.assertEqual(self.capture(), sealed)
        receipt = escrow.upload(self.client, self.profile, sealed)
        self.assertEqual(receipt, escrow.upload(self.client, self.profile, sealed))
        fresh = self.capture(False)
        self.assertNotIn("ciphertext", fresh)
        with self.assertRaises(FakeClientError):
            escrow.check(self.client, self.profile, fresh)
        escrow.recover(self.client, self.profile, receipt, self.identity)
        escrow.check(self.client, self.profile, fresh)
        restored = self.root / "restored"
        escrow.recover(self.client, self.profile, receipt, self.identity, restored)
        self.assertEqual({p.name: p.read_bytes().decode() for p in restored.iterdir()}, self.values)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in restored.iterdir()))
        # An isolated restoration after the Actions receipt expires only needs S3 reads.
        self.client.events.clear()
        proof = escrow.verified_receipt(self.client, self.profile, fresh)
        self.assertEqual(proof, receipt)
        escrow.recover_files(self.client, self.profile, proof, self.identity, self.root / "reader-restore")
        self.assertEqual({event[0] for event in self.client.events}, {"get"})
        with self.assertRaises(FileExistsError):
            escrow.recover(self.client, self.profile, receipt, self.identity, restored)
        self.assertEqual(len(self.client.objects), 2)

    def test_wrong_host_recipient_and_ciphertext_fail_before_verification(self):
        sealed = self.capture()
        receipt = escrow.upload(self.client, self.profile, sealed)
        other = self.root / "wrong-key"
        subprocess.run(["age-keygen", "-o", str(other)], check=True, capture_output=True)
        with self.assertRaises(ValueError):
            escrow.recover(self.client, self.profile, receipt, other)
        for field in ("hostId", "sha256", "generation"):
            with self.assertRaises((FakeClientError, ValueError)):
                escrow.recover(self.client, self.profile, {**receipt, field: "a" * 64}, self.identity)
        with self.assertRaises(ValueError):
            escrow.recover(self.client, {**self.profile, "bucket": "wrong-bucket"}, receipt, self.identity)
        self.assertEqual(len(self.client.objects), 1)
        self.client.corrupt_readback_for = escrow.key(self.profile, sealed, "envelopes")
        with self.assertRaises(ValueError):
            escrow.upload(self.client, self.profile, sealed)
        with self.assertRaises(ValueError):
            escrow.recover(self.client, self.profile, receipt, self.identity)
        self.assertEqual(len(self.client.objects), 1)

    def test_changed_live_set_and_conflicting_remote_proof_are_rejected(self):
        sealed = self.capture()
        receipt = escrow.upload(self.client, self.profile, sealed)
        escrow.recover(self.client, self.profile, receipt, self.identity)
        values = {**self.values, "codexia-auth-secret": "different-existing-secret"}
        (self.root / "values.json").write_text(json.dumps(values))
        with self.assertRaises(FakeClientError):
            escrow.check(self.client, self.profile, self.capture(False))
        self.client.objects[(self.profile["bucket"], escrow.key(self.profile, sealed, "verified"))]["Body"] = b"{}"
        with self.assertRaises(ValueError):
            escrow.check(self.client, self.profile, sealed)
        with self.assertRaises(ValueError):
            escrow.recover(self.client, self.profile, receipt, self.identity)

    def test_missing_target_lock_and_substituted_identity_refuse_to_seal(self):
        marker = self.state / "bootstrap-secret-ids.json"
        marker.write_text("{}")
        with self.assertRaises(ValueError):
            self.capture()
        with (self.state / "host.lock").open() as locked:
            fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.capture(False)
        with self.assertRaises(ValueError), patch.dict(os.environ, self.env):
            snapshot.snapshot(self.recipient, "0" * 64, False)

    @unittest.skipUnless(shutil.which("ansible-playbook"), "pinned Ansible controller required")
    def test_real_playbook_delegates_only_ciphertext_to_the_controller(self):
        ansible = self.root / "ansible"
        ansible.mkdir()
        backup = Path(__file__).resolve().parent
        (self.root / "backup").symlink_to(backup)
        control = self.root / "control"
        control.mkdir(mode=0o700)
        play = ansible / "fixture.yml"
        play.write_text(f"""- hosts: localhost
  gather_facts: false
  vars:
    codexia_stage: bootstrap
  tasks:
    - include_tasks:
        file: "{backup.parent / 'ansible/bootstrap-secret-escrow.yml'}"
        apply:
          environment:
            HOME: "{self.root}"
            PATH: "{self.env['PATH']}"
""")
        transport = self.root / "bootstrap-s3/bin/python"
        transport.parent.mkdir(parents=True)
        transport.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
result = json.load(sys.stdin)
assert result['hostId'] == os.environ['CODEXIA_BOOTSTRAP_ESCROW_HOST_ID']
assert result['recipient'] == os.environ['CODEXIA_BOOTSTRAP_ESCROW_RECIPIENT']
assert set(result) == {'generation', 'hostId', 'recipient', 'ciphertext'}
assert sys.argv[2:4] == ['upload', '--receipt']
Path(sys.argv[4]).touch()
""")
        transport.chmod(0o700)
        result = subprocess.run(["ansible-playbook", "-c", "local", "-i", "localhost,", str(play)], capture_output=True,
                                env={**os.environ, "CONTROL": str(control), "RUNNER_TEMP": str(self.root),
                                     "CODEXIA_BOOTSTRAP_ESCROW_RECIPIENT": self.recipient,
                                     "CODEXIA_BOOTSTRAP_ESCROW_HOST_ID": self.host_id})
        self.assertEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())
        self.assertTrue((control / "escrow-receipt.json").is_file())
        self.assertNotIn(b"fixture-codexia-", result.stdout + result.stderr)

    def test_refuses_incomplete_recovered_payload(self):
        source = self.capture(False)
        values = dict(self.values)
        values.pop("codexia-auth-secret")
        payload = snapshot.canonical({"format": snapshot.FORMAT, "hostId": self.host_id, "recipient": self.recipient, "secrets": values})
        cipher = subprocess.run(["age", "-r", self.recipient], input=payload, capture_output=True, check=True).stdout
        sealed = {**source, "generation": snapshot.sha(payload), "ciphertext": base64.b64encode(cipher).decode()}
        receipt = escrow.upload(self.client, self.profile, sealed)
        with self.assertRaises(ValueError):
            escrow.recover(self.client, self.profile, receipt, self.identity)
        self.assertEqual(len(self.client.objects), 1)


if __name__ == "__main__":
    unittest.main()
