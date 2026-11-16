#!/usr/bin/env python3
import tempfile
import unittest
from pathlib import Path

from check_postgres_volume import inspect_volume


class PostgresVolumeLayoutTests(unittest.TestCase):
    def test_empty_volume_is_safe_for_fresh_initialization(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.assertEqual(inspect_volume(Path(temporary)), {"state": "empty"})

    def test_lost_found_does_not_make_a_new_filesystem_look_adopted(self):
        with tempfile.TemporaryDirectory() as temporary:
            (Path(temporary) / "lost+found").mkdir()
            self.assertEqual(inspect_volume(Path(temporary)), {"state": "empty"})

    def test_postgres_17_cluster_is_adoptable(self):
        with tempfile.TemporaryDirectory() as temporary:
            pgdata = Path(temporary) / "pgdata"
            pgdata.mkdir()
            (pgdata / "PG_VERSION").write_text("17\n", encoding="ascii")
            (pgdata / "global").mkdir()
            self.assertEqual(
                inspect_volume(Path(temporary)),
                {"state": "ready", "version": "17"},
            )

    def test_other_postgres_major_is_rejected_without_rewriting_the_volume(self):
        with tempfile.TemporaryDirectory() as temporary:
            pgdata = Path(temporary) / "pgdata"
            pgdata.mkdir()
            (pgdata / "PG_VERSION").write_text("16\n", encoding="ascii")
            before = (pgdata / "PG_VERSION").read_bytes()
            self.assertEqual(
                inspect_volume(Path(temporary)),
                {"state": "mismatch", "reason": "postgres-major-version", "version": "16"},
            )
            self.assertEqual((pgdata / "PG_VERSION").read_bytes(), before)

    def test_nonempty_cluster_without_pg_version_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            pgdata = Path(temporary) / "pgdata"
            pgdata.mkdir()
            (pgdata / "global").mkdir()
            self.assertEqual(
                inspect_volume(Path(temporary)),
                {"state": "mismatch", "reason": "missing-pg-version"},
            )

    def test_data_outside_the_canonical_pgdata_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            (Path(temporary) / "PG_VERSION").write_text("17\n", encoding="ascii")
            self.assertEqual(
                inspect_volume(Path(temporary)),
                {"state": "mismatch", "reason": "unexpected-volume-layout"},
            )

    def test_symlinked_pgdata_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "volume"
            root.mkdir()
            pgdata = root / "pgdata"
            outside = Path(temporary) / "outside"
            outside.mkdir()
            (outside / "PG_VERSION").write_text("17\n", encoding="ascii")
            pgdata.symlink_to(outside, target_is_directory=True)
            self.assertEqual(
                inspect_volume(root),
                {"state": "mismatch", "reason": "symlinked-pgdata"},
            )


if __name__ == "__main__":
    unittest.main()
