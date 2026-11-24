"""Read-only lifecycle observer contract tests (no VM or Podman required)."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("preflight_observe", Path(__file__).with_name("preflight-observe.py"))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserveDatabaseTests(unittest.TestCase):
    def observe(self, *, volume=True, container=True, layout="ready", writer=None, directory=Path("/unused")):
        return observer.observe_database(
            {"codexia-postgres": volume}, {"codexia-db": container},
            directory, directory, writer, "", layout)

    def test_positive_absence_and_empty_volume_need_no_sql_or_container_start(self):
        with patch.object(observer, "command") as command:
            self.assertEqual(self.observe(volume=False, container=False)["state"], "absent")
            self.assertEqual(self.observe(container=False, layout="empty")["state"], "pristine")
            self.assertEqual(self.observe(container=False, layout="ready")["state"], "unknown")
            with self.assertRaises(ValueError):
                self.observe(volume=False, container=True)
            command.assert_not_called()

    def test_stopped_database_is_unknown(self):
        with patch.object(observer, "command", return_value=(0, "false")):
            self.assertEqual(self.observe()["state"], "unknown")

    def test_missing_database_and_legacy_writer(self):
        cluster = {"clusterId": "123", "appExists": True, "rolesValid": True}
        ledger = [{"version": "0001-initial.sql", "checksum": "a" * 64}]
        with patch.object(observer, "command", return_value=(0, "true")):
            with patch.object(observer, "json_sql", return_value={**cluster, "appExists": False}):
                self.assertEqual(self.observe()["state"], "missing")
            with patch.object(observer, "json_sql", side_effect=[
                cluster, {"ledgerExists": True, "authExists": False, "appRelations": 5}, ledger
            ]):
                result = self.observe(writer={"authMode": "legacy"})
                self.assertEqual(result["authState"], "legacy")
                self.assertEqual(result["ledger"], ledger)

    def test_unrecognized_objects_do_not_establish_pristine_database(self):
        with patch.object(observer, "command", return_value=(0, "true")):
            with patch.object(observer, "json_sql", side_effect=[
                {"clusterId": "123", "appExists": True, "rolesValid": True},
                {"ledgerExists": False, "authExists": False, "appRelations": 1}
            ]):
                with self.assertRaises(ValueError):
                    self.observe()

    def test_bootstrap_resume_evidence_requires_bound_installation_and_no_auth(self):
        cluster = {"clusterId": "123", "databaseOid": "456", "appExists": True, "rolesValid": True}
        ledger = [{"version": "0001-initial.sql", "checksum": "a" * 64}]
        image = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "a" * 64
        db = {"ledgerExists": True, "authExists": False, "appRelations": 5}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            intent = directory / "owner-setup.intent"

            def observe_initialized(**kwargs):
                with patch.object(observer, "command", return_value=(0, "true")), \
                        patch.object(observer, "json_sql", side_effect=[cluster, db, ledger]):
                    return self.observe(directory=directory, **kwargs)

            self.assertNotIn("bootstrapIntent", observe_initialized())
            intent.write_text(f"123:456:{image}\n")
            intent.chmod(0o600)
            result = observe_initialized()
            self.assertEqual(result["authState"], "absent")
            self.assertEqual(result["databaseOid"], "456")
            self.assertEqual(result["bootstrapIntent"], {"clusterId": "123", "databaseOid": "456", "image": image})
            self.assertEqual(result["ledger"], ledger)
            self.assertNotIn("bootstrapIntent", observe_initialized(writer={"authMode": "legacy"}))
            handoff = directory / "owner-setup.age"
            handoff.write_text("fixture-ciphertext")
            self.assertNotIn("bootstrapIntent", observe_initialized())
            handoff.unlink()
            for cluster_id, database_oid in [("321", "456"), ("123", "654")]:
                intent.write_text(f"{cluster_id}:{database_oid}:{image}\n")
                with self.subTest(cluster=cluster_id, database=database_oid), self.assertRaises(ValueError):
                    observe_initialized()

    def test_sql_forces_read_only_and_never_exports_password(self):
        with patch.object(observer, "command", return_value=(0, "ok")) as command:
            self.assertEqual(observer.sql("codexia", "SELECT 1;"), "ok")
            args = command.call_args.args[0]
            self.assertIn("default_transaction_read_only=on", args[6])
            self.assertEqual(command.call_args.kwargs["stdin"], "SELECT 1;\n")

    def test_initialized_setup_without_grant_needs_matching_fresh_intent(self):
        cluster = {"clusterId": "123", "databaseOid": "456", "appExists": True, "rolesValid": True}
        ledger = [{"version": "0001-initial.sql", "checksum": "a" * 64}]
        image = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "a" * 64
        no_grant = {"grant": False, "hasGrant": False, "consumed": False,
                    "ownerCount": 0, "ownerBinding": None, "pristine": True}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            intent = directory / "owner-setup.intent"
            (directory / "owner-setup.installation").write_text("123\n")
            (directory / "owner-setup.container").write_text(f"Image={image}\n")
            for intent_database, expected in [(None, "recovery"), ("456", "pending")]:
                if intent_database:
                    intent.write_text(f"123:{intent_database}:{image}\n")
                    intent.chmod(0o600)
                with self.subTest(intent_database=intent_database):
                    with patch.object(observer, "command", return_value=(0, "true")), \
                            patch.object(observer, "sql", return_value="t"), \
                            patch.object(observer, "json_sql", side_effect=[
                                cluster, {"ledgerExists": True, "authExists": True, "appRelations": 10}, ledger, no_grant
                            ]):
                        result = self.observe(directory=directory)
                        self.assertEqual(result["authState"], expected)
            intent.write_text(f"123:999:{image}\n")
            with patch.object(observer, "command", return_value=(0, "true")), \
                    patch.object(observer, "sql", return_value="t"), \
                    patch.object(observer, "json_sql", side_effect=[
                        cluster, {"ledgerExists": True, "authExists": True, "appRelations": 10}, ledger, no_grant
                    ]):
                with self.assertRaises(ValueError):
                    self.observe(directory=directory)


class TransactionTests(unittest.TestCase):
    def test_journal_binding_and_orphan_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.assertIsNone(observer.observe_transaction(directory))
            path = directory / "deploy-transaction.json"
            data = {"format": "codexia-deploy-transaction/v1", "phase": "pending",
                    **{k: False for k in ("hadUnit", "tunnelWasActive", "apiLinkCreated", "tunnelLinkCreated", "releasePresent")}}
            path.write_text(json.dumps(data))
            self.assertEqual(observer.observe_transaction(directory)["sha256"], observer.digest(data))
            path.write_text("{}")
            with self.assertRaises(ValueError):
                observer.observe_transaction(directory)
            path.unlink()
            (directory / "rollback-api.container").touch()
            with self.assertRaises(ValueError):
                observer.observe_transaction(directory)


if __name__ == "__main__":
    unittest.main()
