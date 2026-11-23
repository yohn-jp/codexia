import hashlib
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("cutover-host.sh")
IMAGE = "ghcr.io/yohn-jp/codexia-backend@sha256:"
PRIOR, CANDIDATE = IMAGE + "1" * 64, IMAGE + "2" * 64
DATABASE, HISTORY, MANIFEST = "d" * 64, "e" * 64, "b" * 64


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(epoch):
    return {
        "format": "codexia-backend-identity/v1",
        "sourceSha": str(epoch) * 40,
        "profile": "full",
        "platform": "linux/amd64",
        "version": f"1.0.{epoch}",
        "apiEpoch": epoch,
        "persistenceFormat": epoch,
        "migrationFingerprint": f"sha256:{'a' * 64}",
    }


FAKE = r'''
import json
import os
from pathlib import Path
import signal
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
root = Path(os.environ["CUTOVER_FIXTURE"])
state_path = root / "runtime.json"
s = json.loads(state_path.read_text())
api = "codexia-api"
tunnel = "codexia-tunnel"

def save():
    state_path.write_text(json.dumps(s))

if name == "systemctl":
    cmd, *args = args[1:]
    service = args[-1].removesuffix(".service") if args else ""
    if cmd == "show":
        if any("SourcePath" in arg for arg in args):
            print(root / "quadlet" / (service + ".container"))
        elif any("DropInPaths" in arg for arg in args):
            dropin = root / "home/.config/systemd/user" / (service + ".service.d") / "95-codexia-cutover.conf"
            if dropin.exists():
                print(dropin)
        elif any("ActiveState" in arg for arg in args):
            print("active" if s.get(service, False) else "inactive")
        else:
            print("loaded")
    elif cmd == "is-active":
        sys.exit(0 if s.get(service, False) else 3)
    elif cmd == "start":
        guard = root / "home/.config/systemd/user" / (service + ".service.d") / "95-codexia-cutover.conf"
        if guard.exists():
            sys.exit(0)
        s[service] = True
        if service == api:
            unit = (root / "quadlet/codexia-api.container").read_text()
            s["image"] = next(line[6:] for line in unit.splitlines() if line.startswith("Image="))
        save()
    elif cmd == "stop":
        s[service] = False
        save()
    elif cmd not in ("daemon-reload", "reset-failed"):
        sys.exit(90)
elif name == "backup":
    if args[0] == "validate-destination":
        sys.exit(0)
    if args[0] == "validate-artifact":
        print("b" * 64)
        sys.exit(0)
    if not args[args.index("--lock-fd") + 1] == "9" or not Path("/proc/self/fd/9").exists():
        sys.exit(91)
    if s[api] or s[tunnel]:
        sys.exit(92)
    if args[0] == "backup-locked":
        if s.get("failBackup"):
            sys.exit(93)
        print("Encrypted backup committed:", root / "backups/codexia-test")
        print("Published checksum manifest sha256:", "b" * 64)
    elif args[0] == "fingerprint-locked":
        print(json.dumps({"databaseFingerprint": s["database"], "historyFingerprint": s["history"]}))
    else:
        sys.exit(93)
elif name == "podman":
    cmd, *args = args
    if cmd == "info":
        print("true")
    elif cmd == "exec" and args[0] == "codexia-db":
        if "pg_control_system()" in args[-1]:
            print("1234567890")
        elif "pg_stat_activity" in args[-1]:
            print("f" if s.get("extraDatabaseSession") else "t")
        else:
            sys.exit(94)
    elif cmd == "exec" and args[0] == api:
        image_epoch = 1 if s["image"].endswith("1" * 64) else 2
        print(json.dumps(s["identities"][image_epoch - 1]))
    elif cmd == "inspect":
        fields, target = args[1:]
        active = s.get(target, True)
        if "Id" in fields:
            print("c" * 64)
        elif "Health" in fields:
            print("healthy")
        elif "Running" in fields:
            print(str(active).lower())
        elif "ImageName" in fields:
            print(s["image"])
        elif fields == "{{.Image}}":
            print(s["image"])
        elif fields == "{{json .Mounts}}":
            volumes = (
                [("codexia-postgres", "/var/lib/postgresql/data")]
                if target == "codexia-db"
                else [("codexia-data", "/data"), ("codexia-history", "/history")]
            )
            print(json.dumps([{"Type": "volume", "Name": vol, "Destination": dest, "RW": True}
                              for vol, dest in volumes]))
        else:
            sys.exit(95)
    elif cmd == "container" and args[0] == "exists":
        sys.exit(0 if args[1] in s else 1)
    elif cmd == "volume" and args[0] == "exists":
        sys.exit(0)
    elif cmd == "ps":
        if s[api]:
            print(api)
    elif cmd == "image":
        print(json.dumps([args[-1]]))
    elif cmd == "run":
        if not s[api] and not s[tunnel] and "--apply" in args:
            s["database"] = "f" * 64
            save()
            if s.get("killDuringApply"):
                os.kill(os.getppid(), signal.SIGKILL)
                sys.exit(0)
            if s.get("failApply"):
                sys.exit(1)
            s["converted"] = True
            save()
        elif "--check" in args and not s.get("converted") and any("snapshot" in arg for arg in args):
            sys.exit(2)
        elif any("update-identity.json" in arg for arg in args):
            is_candidate = any(arg.endswith("2" * 64) for arg in args)
            print(json.dumps(s["identities"][int(is_candidate)]))
        elif "--input-type=module" in args:
            print("sha256:" + "a" * 64)
        elif not (any("verify-auth" in arg for arg in args) or "--check" in args or "--apply" in args):
            sys.exit(96)
    else:
        sys.exit(97)
else:
    sys.exit(98)
'''


class CutoverHostTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for directory in ("state", "quadlet", "backups", "bin", "home/.config/codexia-auth"):
            (self.root / directory).mkdir(parents=True)
        for command in ("systemctl", "podman", "backup"):
            program = self.root / "bin" / command
            program.write_text("#!/usr/bin/env python3\n" + FAKE)
            program.chmod(0o700)
        self.state = self.root / "state"
        (self.state / "host.lock").touch()
        self.journal = self.state / "cutover-transaction.json"
        settings = self.root / "home/.config/codexia-auth" / f"runtime-{digest(b'settings')}.env"
        settings.write_bytes(b"settings")
        settings.chmod(0o600)
        prior_unit = self.root / "quadlet/codexia-api.container"
        candidate_unit = self.state / "candidate-test.container"
        for image, unit in ((PRIOR, prior_unit), (CANDIDATE, candidate_unit)):
            unit.write_text(
                f"[Container]\nImage={image}\nEnvironmentFile={settings}\n"
                f"Environment=CODEXIA_AUTH_SETTINGS_SHA256={digest(b'settings')}\n"
                "Environment=CODEXIA_AUTH_MODE=better-auth\nEnvironment=CODEXIA_DATABASE_MIGRATE_ON_START=0\n"
            )
            unit.chmod(0o600)
        self.release = self.state / "deployed-release.json"
        self.release.write_text(json.dumps({
            "format": "codexia-push-deployment/v1", "image": PRIOR, "identity": identity(1),
            "authMode": "better-auth", "authSettingsSha256": digest(b"settings"),
        }))
        self.release.chmod(0o600)
        self.runtime = self.root / "runtime.json"
        self.runtime.write_text(json.dumps({
            "codexia-api": True, "codexia-tunnel": True, "codexia-db": True, "image": PRIOR,
            "database": DATABASE, "history": HISTORY, "identities": [identity(1), identity(2)],
        }))
        self.env = dict(os.environ, CUTOVER_FIXTURE=str(self.root), HOME=str(self.root / "home"),
                        XDG_CONFIG_HOME=str(self.root / "home/.config"),
                        CODEXIA_PUSH_STATE_DIR=str(self.state), CODEXIA_PUSH_QUADLET_DIR=str(self.root / "quadlet"),
                        CODEXIA_BACKUP_DESTINATION=str(self.root / "backups"), CODEXIA_BACKUP_RECIPIENT="age1fixture",
                        CODEXIA_BACKUP_PROGRAM=str(self.root / "bin/backup"),
                        PATH=f"{self.root / 'bin'}:{os.environ['PATH']}")
        self.input = {
            "planSha256": "a" * 64,
            "notAfter": "2099-01-01T00:00:00.000Z",
            "sourceHostId": digest(Path("/etc/machine-id").read_text().strip().encode()),
            "databaseSystemIdentifier": "1234567890",
            "priorImage": PRIOR,
            "candidateImage": CANDIDATE,
            "priorIdentity": identity(1),
            "candidateIdentity": identity(2),
            "priorUnitSha256": digest(prior_unit.read_bytes()),
            "priorContainerId": "c" * 64,
            "candidateUnit": str(candidate_unit),
            "candidateUnitSha256": digest(candidate_unit.read_bytes()),
        }

    def invoke(self, action, *, success=True, **extra):
        args = ["bash", str(SCRIPT), action]
        if action != "observe":
            request = self.root / "input.json"
            request.write_text(json.dumps(self.input | extra))
            args.append(str(request))
        result = subprocess.run(args, env=self.env, capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return result.stderr

    def live(self):
        return json.loads(self.runtime.read_text())

    def checkpoint(self):
        checkpoint = self.invoke("checkpoint")
        self.assertEqual(checkpoint["checksumManifestSha256"], MANIFEST)
        self.assertFalse(self.live()["codexia-api"])
        self.assertFalse(self.live()["codexia-tunnel"])
        self.input.update(checksumManifestSha256=MANIFEST, recoveryReceiptSha256="a" * 64,
                          databaseFingerprint=DATABASE, historyFingerprint=HISTORY)

    def test_new_plan_refuses_normal_pending_transaction(self):
        (self.state / "deploy-transaction.json").write_text("{}")
        self.assertIn("ordinary deployment", self.invoke("checkpoint", success=False))
        self.assertTrue(self.live()["codexia-api"])
        self.assertFalse(self.journal.exists())

    def test_competing_host_lock_leaves_existing_services_and_journal_untouched(self):
        with (self.state / "host.lock").open() as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            self.assertIn("holds the deployment host lock", self.invoke("checkpoint", success=False))
        self.assertTrue(self.live()["codexia-api"])
        self.assertFalse(self.journal.exists())

    def test_expired_maintenance_window_cannot_stop_the_prior_release(self):
        self.invoke("checkpoint", success=False, notAfter="2000-01-01T00:00:00.000Z")
        self.assertTrue(self.live()["codexia-api"])

    def test_checkpoint_and_independent_binding_before_candidate(self):
        observed = self.invoke("observe")
        self.assertEqual(observed["priorUnitSha256"], self.input["priorUnitSha256"])
        self.checkpoint()
        for service in ("codexia-api", "codexia-tunnel"):
            subprocess.run(["systemctl", "--user", "start", f"{service}.service"], env=self.env, check=True)
            self.assertFalse(self.live()[service])
        self.assertEqual(self.invoke("checkpoint")["checksumManifestSha256"], MANIFEST)
        self.invoke("apply", success=False, checksumManifestSha256="0" * 64)
        self.invoke("apply", success=False, planSha256="0" * 64)
        self.assertEqual(self.live()["database"], DATABASE)
        self.invoke("apply")
        self.invoke("apply")
        self.assertEqual(self.live()["image"], CANDIDATE)
        self.assertFalse(self.live()["codexia-tunnel"])
        opened = self.invoke("open-tunnel", outcome="candidate")
        self.assertEqual(self.invoke("open-tunnel", outcome="candidate"), opened)
        self.invoke("finish", outcome="candidate")
        self.invoke("finish", outcome="candidate")
        self.assertFalse(self.journal.exists())
        self.assertEqual(self.invoke("observe")["phaseChangedAt"], opened["phaseChangedAt"])
        self.assertEqual(json.loads(self.release.read_text())["image"], CANDIDATE)

    def test_failed_conversion_retains_intent_and_requires_actual_restore(self):
        self.checkpoint()
        self.runtime.write_text(json.dumps(self.live() | {"failApply": True}))
        self.invoke("apply", success=False)
        self.assertTrue(self.journal.exists())
        recovery = self.invoke("recover-quiesce")
        self.invoke("recover", success=False)
        self.input["restoreReceiptSha256"] = "9" * 64
        self.invoke("recover", success=False)
        self.assertFalse(self.live()["codexia-api"])
        self.runtime.write_text(json.dumps(self.live() | {"database": DATABASE}))
        self.invoke("recover")
        self.assertEqual(self.invoke("observe")["recoveryStartedAt"], recovery["recoveryStartedAt"])
        self.assertEqual(self.live()["image"], PRIOR)
        self.assertFalse(self.live()["codexia-tunnel"])
        self.invoke("open-tunnel", outcome="prior")
        self.invoke("finish", outcome="prior")
        self.assertEqual(json.loads(self.release.read_text())["image"], PRIOR)

    def test_interrupted_backup_allows_verified_prior_recovery_before_any_mutation(self):
        self.runtime.write_text(json.dumps(self.live() | {"failBackup": True}))
        self.invoke("checkpoint", success=False)
        with self.journal.open() as intent:
            self.assertEqual(json.load(intent)["phase"], "intent")
        self.assertFalse(self.live()["codexia-api"])
        self.assertFalse(self.invoke("recover-quiesce")["requiresRestore"])
        self.invoke("recover")
        self.assertEqual(self.live()["image"], PRIOR)
        self.assertFalse(self.live()["codexia-tunnel"])

    def test_another_database_session_blocks_checkpoint_after_stopping_services(self):
        self.runtime.write_text(json.dumps(self.live() | {"extraDatabaseSession": True}))
        self.assertIn("PostgreSQL sessions remain", self.invoke("checkpoint", success=False))
        self.assertFalse(self.live()["codexia-api"])
        self.assertFalse(self.live()["codexia-tunnel"])
        self.assertNotIn("checksumManifestSha256", json.loads(self.journal.read_text()))

    def test_abrupt_conversion_exit_cannot_repeat_mutation_or_start_writers(self):
        self.checkpoint()
        self.runtime.write_text(json.dumps(self.live() | {"killDuringApply": True}))
        self.invoke("apply", success=False)
        subprocess.run(["flock", "--wait", "5", self.state / "host.lock", "true"], check=True)
        self.assertEqual(self.invoke("observe")["phase"], "converting")
        self.invoke("apply", success=False)
        self.assertTrue(self.invoke("recover-quiesce")["requiresRestore"])
        self.invoke("recover", success=False, restoreReceiptSha256="9" * 64)
        self.assertFalse(self.live()["codexia-api"])
        self.assertFalse(self.live()["codexia-tunnel"])


if __name__ == "__main__":
    unittest.main()
