#!/usr/bin/env python3
"""Read-only check for the repository's canonical PostgreSQL volume layout."""

import json
import os
import sys
from pathlib import Path


def inspect_volume(root: Path) -> dict[str, str]:
    try:
        if root.is_symlink() or not root.is_dir():
            return {"state": "mismatch", "reason": "invalid-volume-mountpoint"}

        entries = {entry.name: entry for entry in os.scandir(root)}
        unexpected = set(entries) - {"pgdata", "lost+found"}
        if unexpected:
            return {"state": "mismatch", "reason": "unexpected-volume-layout"}

        pgdata_entry = entries.get("pgdata")
        if pgdata_entry is None:
            return {"state": "empty"}
        if pgdata_entry.is_symlink():
            return {"state": "mismatch", "reason": "symlinked-pgdata"}
        if not pgdata_entry.is_dir(follow_symlinks=False):
            return {"state": "mismatch", "reason": "invalid-pgdata"}

        pgdata = root / "pgdata"
        children = list(os.scandir(pgdata))
        if not children:
            return {"state": "empty"}

        version_entry = next((entry for entry in children if entry.name == "PG_VERSION"), None)
        if version_entry is None or version_entry.is_symlink() or not version_entry.is_file(follow_symlinks=False):
            return {"state": "mismatch", "reason": "missing-pg-version"}

        version = (pgdata / "PG_VERSION").read_text(encoding="ascii").strip()
        if version != "17":
            return {
                "state": "mismatch",
                "reason": "postgres-major-version",
                "version": version,
            }
        return {"state": "ready", "version": version}
    except (OSError, UnicodeError):
        return {"state": "mismatch", "reason": "unreadable-volume"}


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} VOLUME_MOUNTPOINT", file=sys.stderr)
        return 2
    print(json.dumps(inspect_volume(Path(sys.argv[1])), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
