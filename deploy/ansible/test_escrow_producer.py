"""Execute the actual composite-action predicates against read-only GitHub fixtures."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
STEPS = yaml.safe_load((ROOT / ".github/actions/reviewed-preflight/action.yml").read_text())["runs"]["steps"]


class EscrowProducerTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        (self.temp / "reviewed-preflight").mkdir()
        gh = self.temp / "gh"
        gh.write_text('#!/bin/sh\ncat "$RUNNER_TEMP/run.json"\n')
        gh.chmod(0o700)
        self.env = {**os.environ, "PATH": str(self.temp) + os.pathsep + os.environ["PATH"],
                    "PREFLIGHT_RUN": "9", "GITHUB_SHA": "a" * 40, "GITHUB_REPOSITORY": "yohn-jp/codexia",
                    "GITHUB_OUTPUT": str(self.temp / "out"), "RUNNER_TEMP": str(self.temp), "MANAGEMENT": "bootstrap"}
        self.run_record = {"id": 9, "repository": {"full_name": "yohn-jp/codexia"},
                           "head_repository": {"full_name": "yohn-jp/codexia"}, "event": "workflow_dispatch",
                           "head_branch": "main", "head_sha": self.env["GITHUB_SHA"],
                           "path": ".github/workflows/production-preflight.yml", "status": "completed",
                           "conclusion": "failure", "run_attempt": 1}
        self.receipt = {"sourceSha": self.env["GITHUB_SHA"], "runId": 9, "attempt": 1, "management": "bootstrap",
                        "request": {"intent": "install", "window": None}, "planSha256": "a" * 64,
                        "plan": {"format": "codexia-deployment-plan/v1", "intent": "install", "candidateRoute": "R6",
                                 "route": "R0", "window": None,
                                 "blockers": ["missing-preservation-evidence", "approval-required"]}}

    def accepts(self, escrow):
        (self.temp / "run.json").write_text(json.dumps(self.run_record))
        (self.temp / "reviewed-preflight/codexia-lifecycle-preflight.json").write_text(json.dumps(self.receipt))
        env = {**self.env, "ESCROW": "true" if escrow else "false"}
        producer = subprocess.run(["bash", "-c", STEPS[0]["run"]], env=env, capture_output=True)
        if producer.returncode:
            return False
        outputs = dict(line.split("=", 1) for line in (self.temp / "out").read_text().splitlines())
        return subprocess.run(["bash", "-c", STEPS[2]["run"]], capture_output=True,
                              env={**env, "CONCLUSION": outputs["conclusion"]}).returncode == 0

    def test_missing_r6_preservation_is_inspectable_only_for_existing_set_escrow(self):
        self.assertTrue(self.accepts(True))
        self.assertFalse(self.accepts(False))
        self.receipt["plan"]["blockers"].append("incomplete-state-evidence")
        self.assertFalse(self.accepts(True))
        self.receipt["plan"]["blockers"] = ["approval-required"]
        self.assertFalse(self.accepts(True))
        self.run_record["conclusion"] = "success"
        self.assertTrue(self.accepts(False))

    def test_foreign_cancelled_and_wrong_stage_never_authorize_adoption(self):
        for field, invalid in (("repository", {"full_name": "example/fork"}), ("event", "pull_request"),
                               ("conclusion", "cancelled"), ("run_attempt", 2), ("head_sha", "b" * 40)):
            with self.subTest(field=field):
                previous = self.run_record[field]
                self.run_record[field] = invalid
                self.assertFalse(self.accepts(True))
                self.run_record[field] = previous
        self.receipt["plan"]["candidateRoute"] = "R5"
        self.assertFalse(self.accepts(True))
