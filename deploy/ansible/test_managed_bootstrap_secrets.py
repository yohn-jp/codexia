import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location("managed", Path(__file__).with_name("managed-bootstrap-secrets.py"))
managed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(managed)


class ManagedSecretsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.state = self.home / ".local/state/codexia-deploy"
        self.state.mkdir(parents=True)
        self.store = {}
        self.resources = set()
        self.fail = None
        self.host = hashlib.sha256(Path("/etc/machine-id").read_text().strip().encode()).hexdigest()
        mock = patch.object(managed, "podman", side_effect=self.podman)
        mock.start()
        self.addCleanup(mock.stop)

    def podman(self, kind, operation, *args, data=None, allowed=(0,)):
        if kind == "info":
            return SimpleNamespace(stdout="true\n")
        if operation == "exists":
            name, = args
            present = name in self.store if kind == "secret" else (kind, name) in self.resources
            return SimpleNamespace(returncode=0 if present else 1)
        if (kind, operation) == ("secret", "inspect"):
            flag, name = args
            assert flag == "--showsecret"
            ident, contents = self.store[name]
            return SimpleNamespace(stdout=json.dumps([{"ID": ident, "Spec": {"Name": name}, "SecretData": contents}]))
        if (kind, operation) == ("secret", "create"):
            name, source = args
            assert source == "-" and name not in self.store
            if self.fail == name:
                raise ValueError("synthetic interruption")
            self.store[name] = ("synthetic-id-" + name, data)
            return SimpleNamespace(stdout="created")
        self.failTest((kind, operation))

    def admit(self):
        return {"host": self.host, "hashes": {name: managed.inspect(name)[0] for name in self.store}}

    def run_bootstrap(self, *, installing=True, admitted=None):
        return managed.converge(self.home, admitted if admitted is not None else self.admit(), installing)

    def test_fresh_idempotence_and_existing_adoption(self):
        self.assertTrue(self.run_bootstrap())
        saved = self.store.copy()
        self.assertEqual(set(saved), set(managed.NAMES))
        self.assertEqual(len({saved[k][1] for k in saved}), len(saved))
        self.assertRegex(managed.auth_password(saved[managed.AUTH_URL][1]), "^[a-f0-9]{64}$")
        self.assertNotIn(saved[managed.APP][1], (self.state / "bootstrap-secret-ids.json").read_text())
        self.resources.add(("volume", "codexia-postgres"))
        self.assertFalse(self.run_bootstrap(installing=False))
        self.assertEqual(self.store, saved)
        (self.state / "bootstrap-secret-ids.json").unlink()
        self.assertTrue(self.run_bootstrap(installing=False))
        self.assertEqual(self.store, saved)

    def test_interrupted_creation_reuses_exact_values(self):
        self.fail = managed.AUTH_URL
        old = self.admit()
        with self.assertRaises(ValueError):
            self.run_bootstrap(admitted=old)
        partial = self.store.copy()
        self.assertEqual(set(partial), {managed.ADMIN, managed.APP})
        self.fail = None
        with self.assertRaisesRegex(ValueError, "changed since admission"):
            self.run_bootstrap(admitted=old)
        self.run_bootstrap()
        self.assertEqual({k: self.store[k] for k in partial}, partial)

    def test_missing_live_credentials_or_durable_checkpoint_require_recovery(self):
        self.resources.add(("volume", "codexia-history"))
        with self.assertRaisesRegex(ValueError, "requires independent recovery"):
            self.run_bootstrap()
        self.assertFalse(self.store)
        self.resources.clear()
        self.run_bootstrap()
        del self.store[managed.AUTH]
        with self.assertRaisesRegex(ValueError, "require independent recovery"):
            self.run_bootstrap()
        self.assertNotIn(managed.AUTH, self.store)

    def test_legacy_tunnel_container_or_credential_requires_owner_cleanup(self):
        self.resources.add(("container", managed.LEGACY_TUNNEL_CONTAINER))
        with self.assertRaisesRegex(ValueError, "owner-approved one-time retirement"):
            self.run_bootstrap()
        self.assertFalse(self.store)
        self.resources.clear()
        self.store[managed.LEGACY_TUNNEL_SECRET] = ("legacy-id", "unread legacy credential")
        with self.assertRaisesRegex(ValueError, "owner-approved one-time retirement"):
            self.run_bootstrap(installing=False)
        self.assertEqual(set(self.store), {managed.LEGACY_TUNNEL_SECRET})

    def test_refuses_mismatch_before_writing_any_secret(self):
        self.store[managed.APP] = ("application", "invalid-password")
        invalid = self.store.copy()
        with self.assertRaisesRegex(ValueError, "Invalid base database credential"):
            self.run_bootstrap()
        self.assertEqual(self.store, invalid)

    def test_requires_current_host_and_exclusive_lock_and_no_recovery_journal(self):
        with self.assertRaisesRegex(ValueError, "host identity changed"):
            self.run_bootstrap(admitted={"host": "0" * 64, "hashes": {}})
        with (self.state / "host.lock").open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.run_bootstrap()
        (self.state / "deploy-transaction.json").touch()
        with self.assertRaisesRegex(ValueError, "transaction requires recovery"):
            self.run_bootstrap()
        self.assertFalse(self.store)


if __name__ == "__main__":
    unittest.main()
