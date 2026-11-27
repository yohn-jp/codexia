"""Read-only lifecycle observer contract tests (no VM or Podman required)."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("preflight_observe", Path(__file__).with_name("preflight-observe.py"))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class OwnerHandoffTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.state = self.home / ".local/state/codexia-deploy"
        self.state.mkdir(mode=0o700, parents=True)
        self.handoff = self.state / "owner-setup.age"
        self.handoff.write_bytes(b"encrypted envelope")
        self.handoff.chmod(0o600)
        self.lock = self.state / "host.lock"
        self.lock.touch(mode=0o600)

    def read_handoff(self):
        with self.lock.open("rb") as lock:
            return observer.read_owner_handoff(self.home, lock.fileno())

    def test_export_requires_locked_complete_handoff(self):
        self.assertEqual(self.read_handoff(), b"encrypted envelope")
        with self.handoff.open("rb") as wrong_lock:
            with self.assertRaises(ValueError):
                observer.read_owner_handoff(self.home, wrong_lock.fileno())
        with self.lock.open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.read_handoff()
        for name in ("owner-setup.age.pending", "owner-setup.promoted"):
            marker = self.state / name
            marker.symlink_to(self.state / "missing")
            with self.assertRaises(ValueError):
                self.read_handoff()
            marker.unlink()

    def test_export_rejects_symlinks_links_unbounded_and_nonregular_files(self):
        self.handoff.chmod(0o644)
        with self.assertRaises(ValueError):
            self.read_handoff()
        self.handoff.chmod(0o600)
        linked = self.state / "hardlink"
        linked.hardlink_to(self.handoff)
        with self.assertRaises(ValueError):
            self.read_handoff()
        self.handoff.unlink()
        self.handoff.symlink_to(linked)
        with self.assertRaises(OSError):
            self.read_handoff()
        self.handoff.unlink()
        os.mkfifo(self.handoff, 0o600)
        with self.assertRaises(ValueError):
            self.read_handoff()
        self.handoff.unlink()
        self.handoff.write_bytes(b"x" * (16 * 1024 + 1))
        self.handoff.chmod(0o600)
        with self.assertRaises(ValueError):
            self.read_handoff()
        self.handoff.unlink()
        self.state.rename(self.state.with_name("redirect"))
        self.state.symlink_to(self.state.with_name("redirect"))
        with self.assertRaises(OSError):
            self.read_handoff()


def recovery_record():
    sha = "a" * 64
    return {
        "format": "codexia-recovery-handoff/v1",
        "operationId": "restore-20261124-01",
        "environment": "codexia-production",
        "backup": {
            "id": "codexia-20261123T220000Z-00000000-0000-4000-8000-000000000001",
            "sourceHostId": "b" * 64,
            "manifestSha256": sha, "transferReceiptSha256": sha, "restoreReceiptSha256": sha,
            "databaseFingerprint": sha, "historyFingerprint": sha,
        },
        "target": {
            "hostId": "c" * 64, "clusterId": "123", "databaseOid": "456",
            "ledgerSha256": sha, "authSchemaSha256": f"sha256:{sha}",
            "ownerBindingSha256": f"sha256:{sha}", "settingsSha256": sha, "secretSetSha256": sha,
        },
        "release": {
            "image": f"ghcr.io/yohn-jp/codexia-backend@sha256:{sha}", "sourceSha": "a" * 40,
            "frontendArtifactSha256": sha,
        },
        "window": {"id": "recovery", "notBefore": "2026-11-23T23:00:00.000Z", "notAfter": "2026-11-24T01:00:00.000Z"},
        "writerFence": {"kind": "write-access-revoked", "recordSha256": sha},
        "executorFenceSha256": sha,
        "credentialsRecordSha256": sha,
        "postBackupWritesRecordSha256": sha,
    }


class ProtectedRecoveryTests(unittest.TestCase):
    def test_recovery_source_and_disposition_match_the_operation(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            path = directory / "recovery-handoff.json"
            record = recovery_record()
            record["backup"].update({"sourceHostId": record["target"]["hostId"],
                                     "sourceClusterId": "123", "sourceDatabaseOid": "456"})
            path.write_text(json.dumps(record))
            path.chmod(0o600)
            with self.assertRaises(ValueError):
                observer.read_recovery_handoff(directory)
            record["backup"]["sourceClusterId"] = "222"
            path.write_text(json.dumps(record))
            self.assertEqual(observer.read_recovery_handoff(directory)[0], record)
            del record["postBackupWritesRecordSha256"]
            path.write_text(json.dumps(record))
            with self.assertRaises(ValueError):
                observer.read_recovery_handoff(directory)

    def test_worker_requires_inactive_state_and_no_enabled_restart(self):
        with patch.object(observer, "command") as command:
            for state in (
                "LoadState=loaded\nUnitFileState=disabled\nActiveState=inactive",
                "LoadState=not-found\nActiveState=inactive",
            ):
                command.return_value = (0, state)
                observer.require_recovery_worker_stopped()
            for state in (
                "LoadState=loaded\nUnitFileState=disabled\nActiveState=active",
                "LoadState=loaded\nUnitFileState=enabled\nActiveState=inactive",
                "LoadState=error",
            ):
                command.return_value = (0, state)
                with self.assertRaises(ValueError):
                    observer.require_recovery_worker_stopped()

    def test_protected_record_rejects_unsafe_file_and_unknown_fields(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            path = directory / "recovery-handoff.json"
            record = recovery_record()
            self.assertIsNone(observer.read_recovery_handoff(directory))
            raw = json.dumps(record).encode()
            path.write_bytes(raw)
            path.chmod(0o600)
            self.assertEqual(observer.read_recovery_handoff(directory),
                             (record, hashlib.sha256(raw).hexdigest()))
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                observer.read_recovery_handoff(directory)
            path.chmod(0o600)
            path.write_text(json.dumps({**record, "dsn": "must-not-leave-vm"}))
            with self.assertRaises(ValueError):
                observer.read_recovery_handoff(directory)
            path.write_text('{"format": "unused", ' + raw.decode()[1:])
            with self.assertRaises(ValueError):
                observer.read_recovery_handoff(directory)
            path.unlink()
            (directory / "other").write_bytes(raw)
            path.symlink_to(directory / "other")
            with self.assertRaises(OSError):
                observer.read_recovery_handoff(directory)


class ObserveDatabaseTests(unittest.TestCase):
    def observe(self, *, volume=True, container=True, layout="ready", writer=None,
                directory=Path("/unused"), resume_clean=False, inspect_restored=False):
        return observer.observe_database(
            {"codexia-postgres": volume}, {"codexia-db": container},
            directory, directory, writer, "", layout, resume_clean=resume_clean, inspect_restored=inspect_restored)

    def test_restore_observation_reads_owner_without_fresh_installation_markers(self):
        owner = "sha256:" + "a" * 64
        settings = "b" * 64
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(observer, "command", return_value=(0, "true")), \
                    patch.object(observer, "sql", return_value="auth catalog"), \
                    patch.object(observer, "restored_owner_settings", return_value={
                        "ownerBindingSha256": owner, "settingsSha256": settings}), \
                    patch.object(observer, "json_sql", side_effect=[
                        {"clusterId": "123", "databaseOid": "456", "appExists": True, "rolesValid": True},
                        {"ledgerExists": True, "authExists": True, "appRelations": 5},
                        [{"version": "0001-initial.sql", "checksum": "a" * 64}], {"empty": False},
                    ]):
                result = self.observe(directory=Path(folder), inspect_restored=True)
            self.assertEqual(result["authState"], "ready")
            self.assertEqual(result["ownerBindingSha256"], owner)
            self.assertEqual(result["settingsSha256"], settings)
            self.assertNotIn("bootstrapIntent", result)

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
        cluster = {"clusterId": "123", "databaseOid": "456", "appExists": True, "rolesValid": True}
        ledger = [{"version": "0001-initial.sql", "checksum": "a" * 64}]
        with patch.object(observer, "command", return_value=(0, "true")):
            with patch.object(observer, "json_sql", return_value={**cluster, "appExists": False}):
                self.assertEqual(self.observe(), {"state": "missing", "authState": "absent", "clusterId": "123"})
            with patch.object(observer, "json_sql", return_value={**cluster, "appExists": False, "rolesValid": False}):
                with self.assertRaises(ValueError):
                    self.observe()
            with patch.object(observer, "json_sql", side_effect=[
                cluster, {"ledgerExists": True, "authExists": False, "appRelations": 5}, ledger
            ]):
                result = self.observe(writer={"authMode": "legacy"})
                self.assertEqual(result["authState"], "legacy")
                self.assertEqual(result["ledger"], ledger)
                self.assertEqual(result["databaseOid"], "456")

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

            self.assertNotIn("bootstrapIntent", observe_initialized(resume_clean=True))
            intent.write_text(f"123:456:{image}\n")
            intent.chmod(0o600)
            result = observe_initialized(resume_clean=True)
            self.assertEqual(result["authState"], "absent")
            self.assertEqual(result["databaseOid"], "456")
            self.assertEqual(result["bootstrapIntent"], {"clusterId": "123", "databaseOid": "456", "image": image})
            self.assertEqual(result["ledger"], ledger)
            self.assertNotIn("bootstrapIntent", observe_initialized(resume_clean=True, writer={"authMode": "legacy"}))
            handoff = directory / "owner-setup.age"
            handoff.write_text("fixture-ciphertext")
            self.assertNotIn("bootstrapIntent", observe_initialized(resume_clean=True))
            handoff.unlink()
            for cluster_id, database_oid in [("321", "456"), ("123", "654")]:
                intent.write_text(f"{cluster_id}:{database_oid}:{image}\n")
                with self.subTest(cluster=cluster_id, database=database_oid), self.assertRaises(ValueError):
                    observe_initialized(resume_clean=True)

    def test_empty_auth_schema_checkpoint_requires_locked_clean_intent(self):
        cluster = {"clusterId": "123", "databaseOid": "456", "appExists": True, "rolesValid": True}
        ledger = [{"version": "0001-initial.sql", "checksum": "a" * 64}]
        image = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            intent = directory / "owner-setup.intent"
            intent.write_text(f"123:456:{image}\n")
            intent.chmod(0o600)
            with patch.object(observer, "command", return_value=(0, "true")), \
                    patch.object(observer, "json_sql", side_effect=[cluster,
                        {"ledgerExists": True, "authExists": True, "appRelations": 5}, ledger,
                        {"empty": True}]), patch.object(observer, "sql", return_value=""):
                result = self.observe(directory=directory, resume_clean=True)
                self.assertEqual(result["authState"], "absent")
                self.assertTrue(result["emptyAuthSchema"])
                self.assertEqual(result["bootstrapIntent"],
                    {"clusterId": "123", "databaseOid": "456", "image": image})
            with patch.object(observer, "command", return_value=(0, "true")), \
                    patch.object(observer, "json_sql", side_effect=[cluster,
                        {"ledgerExists": True, "authExists": True, "appRelations": 5}, ledger,
                        {"empty": True}]), patch.object(observer, "sql", return_value=""):
                result = self.observe(directory=directory, resume_clean=False)
                self.assertNotIn("emptyAuthSchema", result)

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
        no_grant = {"grant": False, "hasGrant": False, "grantBinding": None, "consumed": False,
                    "ownerCount": 0, "ownerBinding": None, "pristine": True}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            intent = directory / "owner-setup.intent"
            marker = directory / "owner-setup.installation"
            marker.write_text("123\n")
            marker.chmod(0o600)
            (directory / "owner-setup.container").write_text(f"Image={image}\n")
            for intent_database, expected in [(None, "recovery"), ("456", "pending")]:
                if intent_database:
                    intent.write_text(f"123:{intent_database}:{image}\n")
                    intent.chmod(0o600)
                with self.subTest(intent_database=intent_database):
                    with patch.object(observer, "command", return_value=(0, "true")), \
                            patch.object(observer, "sql", return_value="t"), \
                            patch.object(observer, "json_sql", side_effect=[
                                cluster, {"ledgerExists": True, "authExists": True, "appRelations": 10}, ledger,
                                {"empty": False}, no_grant
                            ]):
                        result = self.observe(directory=directory)
                        self.assertEqual(result["authState"], expected)
            intent.write_text(f"123:999:{image}\n")
            with patch.object(observer, "command", return_value=(0, "true")), \
                    patch.object(observer, "sql", return_value="t"), \
                    patch.object(observer, "json_sql", side_effect=[
                        cluster, {"ledgerExists": True, "authExists": True, "appRelations": 10}, ledger,
                        {"empty": False}, no_grant
                    ]):
                with self.assertRaises(ValueError):
                    self.observe(directory=directory)

    def test_owner_setup_checkpoints_bind_marker_and_encrypted_grant(self):
        cluster = {"clusterId": "123", "databaseOid": "456", "appExists": True, "rolesValid": True}
        ledger = [{"version": "0001-initial.sql", "checksum": "a" * 64}]
        db = {"ledgerExists": True, "authExists": True, "appRelations": 5}
        image = "ghcr.io/yohn-jp/codexia-backend@sha256:" + "a" * 64
        no_grant = {"grant": False, "hasGrant": False, "grantBinding": None, "consumed": False,
                    "ownerCount": 0, "ownerBinding": None, "pristine": True}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            intent = directory / "owner-setup.intent"
            intent.write_text(f"123:456:{image}\n")
            intent.chmod(0o600)

            def observe_owner(owner):
                with patch.object(observer, "command", return_value=(0, "true")), \
                        patch.object(observer, "sql", return_value="t"), \
                        patch.object(observer, "json_sql", side_effect=[cluster, db, ledger, {"empty": False}, owner]):
                    return self.observe(directory=directory)

            before_marker = observe_owner(no_grant)
            self.assertEqual(before_marker["authState"], "pending")
            self.assertEqual(before_marker["ownerSetupCheckpoint"], {
                "setupMarkerPresent": False, "grantBindingSha256": None,
                "pendingHandoff": False, "encryptedHandoffPresent": False,
            })
            marker = directory / "owner-setup.installation"
            marker.write_text("123\n")
            marker.chmod(0o600)
            before_grant = observe_owner(no_grant)
            self.assertEqual(before_grant["authState"], "pending")
            self.assertTrue(before_grant["ownerSetupCheckpoint"]["setupMarkerPresent"])
            envelope = directory / "owner-setup.age"
            envelope.write_text("fixture-ciphertext")
            envelope.chmod(0o600)
            issued = {**no_grant, "grant": True, "hasGrant": True, "grantBinding": "b" * 64}
            after_grant = observe_owner(issued)
            self.assertEqual(after_grant["authState"], "pending")
            self.assertEqual(after_grant["ownerSetupCheckpoint"], {
                "setupMarkerPresent": True, "grantBindingSha256": "b" * 64,
                "pendingHandoff": False, "encryptedHandoffPresent": True,
            })
            (directory / "owner-setup.age.pending").write_text("handoff-in-progress\n")
            interrupted = observe_owner(issued)
            self.assertEqual(interrupted["authState"], "recovery")
            self.assertTrue(interrupted["ownerSetupCheckpoint"]["pendingHandoff"])

            promoted = directory / "owner-setup.promoted"
            promoted.write_text("invalid\n")
            promoted.chmod(0o600)
            with self.assertRaises(ValueError):
                observe_owner(issued)

            promoted.unlink()
            subject = "fixture-owner"
            enrolled = {**issued, "grant": False, "consumed": True, "ownerCount": 1,
                        "ownerBinding": "sha256:" + hashlib.sha256(subject.encode()).hexdigest()}
            runtime = directory / "runtime.env"
            settings = "CODEXIA_PUBLIC_ORIGIN=https://setup.example.test\n"
            runtime.write_text(settings)
            self.assertNotIn("settingsSha256", observe_owner(enrolled))
            runtime.write_text(settings + f"CODEXIA_OAUTH_OWNER_SUBJECT={subject}\n")
            preparing = observe_owner(enrolled)
            self.assertEqual(preparing["authState"], "unprepared")
            self.assertEqual(preparing["settingsSha256"], hashlib.sha256(runtime.read_bytes()).hexdigest())
            promoted.write_text("activation-ready\n")
            promoted.chmod(0o600)
            self.assertEqual(observe_owner(enrolled)["authState"], "ready")
            promoted.chmod(0o644)
            with self.assertRaises(ValueError):
                observe_owner(enrolled)


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


class AbsentDatabaseResetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "reset_absent_db", Path(__file__).with_name("reset-absent-app-database.py"))
        cls.reset = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.reset)

    def test_recheck_blocks_existing_database_before_slot_mutation(self):
        reset = self.reset
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            state = home / ".local/state/codexia-deploy"
            state.mkdir(parents=True)
            release = state / "deployed-release.json"
            release.write_text("retained")
            release.chmod(0o600)
            with patch.object(reset, "exists", return_value=True), \
                    patch.object(reset, "admin_sql", return_value="123|false|true"), \
                    patch.object(reset, "stop_slot") as stop:
                with self.assertRaises(ValueError):
                    reset.converge("123", home)
                stop.assert_not_called()
            self.assertTrue(release.exists())

    def test_verified_missing_database_cleans_only_obsolete_state_then_creates(self):
        reset = self.reset
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            state = home / ".local/state/codexia-deploy"
            auth = home / ".config/codexia-auth"
            for directory in (state, auth):
                directory.mkdir(parents=True)
            old = [state / "deployed-release.json", state / "owner-setup.promoted", auth / "runtime.env"]
            backup = state / "backup.age"
            for path in old + [backup]:
                path.write_text("fixture")
                path.chmod(0o600)
            events = []

            def sql(query, read_only=True):
                if query.startswith("CREATE"):
                    self.assertTrue(all(not path.exists() for path in old))
                    self.assertFalse(read_only)
                    events.append("create")
                    return ""
                if query.startswith("SELECT pg_get_userbyid"):
                    return "codexia"
                return "123|true|true"

            with patch.object(reset, "exists", return_value=True), \
                    patch.object(reset, "admin_sql", side_effect=sql), \
                    patch.object(reset, "verify_api_container"), \
                    patch.object(reset, "service_state", return_value=False), \
                    patch.object(reset, "command"), \
                    patch.object(reset, "stop_slot", side_effect=lambda name, _: events.append(name)):
                reset.converge("123", home)
            self.assertEqual(events, ["codexia-tunnel", "codexia-api", "create"])
            self.assertTrue(backup.exists())

    def test_unknown_or_unreachable_db_never_stops_services(self):
        reset = self.reset
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".local/state/codexia-deploy").mkdir(parents=True)
            with patch.object(reset, "exists", return_value=True), \
                    patch.object(reset, "admin_sql", side_effect=ValueError("unreachable")), \
                    patch.object(reset, "stop_slot") as stop:
                with self.assertRaises(ValueError):
                    reset.converge("123", home)
                stop.assert_not_called()

    def test_absent_cluster_is_left_to_canonical_base_creation(self):
        reset = self.reset
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".local/state/codexia-deploy").mkdir(parents=True)
            with patch.object(reset, "exists", return_value=False), \
                    patch.object(reset, "admin_sql") as sql, \
                    patch.object(reset, "service_state", return_value=False), \
                    patch.object(reset, "command"), \
                    patch.object(reset, "stop_slot") as stop:
                reset.converge("absent", home)
                sql.assert_not_called()
                self.assertEqual(stop.call_count, 2)

    def test_pending_transaction_prevents_reset(self):
        reset = self.reset
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            state = home / ".local/state/codexia-deploy"
            state.mkdir(parents=True)
            (state / "deploy-transaction.json").write_text("fixture")
            with patch.object(reset, "verify_absent"), patch.object(reset, "stop_slot") as stop:
                with self.assertRaises(ValueError):
                    reset.converge("absent", home)
                stop.assert_not_called()


class LockedCredentialTests(unittest.TestCase):
    def test_mutation_and_missing_or_new_credential_invalidate_preserved_set_under_host_lock(self):
        names = observer.BASE_SECRETS + observer.AUTH_SECRETS
        ids = {name: "initial-" + name for name in names}

        def podman(argv, *args):
            self.assertEqual(argv[:2], ["podman", "secret"])
            name = argv[-1]
            if argv[2] == "exists":
                return (0 if name in ids else 1), ""
            self.assertEqual(argv[2:-1], ["inspect", "--format", "{{.ID}}"])
            return 0, ids[name]

        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            path = Path(directory) / ".local/state/codexia-deploy/host.lock"
            path.parent.mkdir(parents=True)
            with path.open("w") as lock, patch.object(observer, "command", side_effect=podman):
                expected = observer.digest(observer.secret_identities())
                observer.verify_secret_identities(expected, lock.fileno())
                with (path.parent / "other").open("w") as other:
                    with self.assertRaises(ValueError):
                        observer.verify_secret_identities(expected, other.fileno())
                ids[observer.AUTH_SECRETS[1]] = "rotated"
                with self.assertRaises(ValueError):
                    observer.verify_secret_identities(expected, lock.fileno())
                ids[observer.AUTH_SECRETS[1]] = "initial-" + observer.AUTH_SECRETS[1]
                ids[observer.OPTIONAL_SECRET] = "new"
                with self.assertRaises(ValueError):
                    observer.verify_secret_identities(expected, lock.fileno())
                del ids[observer.OPTIONAL_SECRET]
                del ids[names[0]]
                with self.assertRaises(ValueError):
                    observer.verify_secret_identities(observer.digest(observer.secret_identities()), lock.fileno())


if __name__ == "__main__":
    unittest.main()
