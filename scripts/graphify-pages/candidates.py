#!/usr/bin/env python3
"""Emit Graphify's code-candidate paths for an exact source checkout.

This file is run after Graphify is installed in the audit job. It deliberately
serializes only repository-relative paths and the inputs needed to validate
that inventory; no file contents, manifest hashes, or detector metadata leave
the ephemeral runner.
"""
from __future__ import annotations

import argparse
from importlib.metadata import PackageNotFoundError, version
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

EXPECTED_EXCLUDES = [
    "tests/**",
    "evidence/**",
    ".agents/**",
    "docs/**",
    "**/*.test.*",
    "**/*.spec.*",
]


def _repo_path(value: str, root: Path) -> str | None:
    candidate = Path(value)
    if candidate.is_absolute():
        try:
            candidate = candidate.relative_to(root)
        except ValueError:
            return None
    path = candidate.as_posix().removeprefix("./")
    if (
        not path
        or path.startswith("/")
        or "\\" in path
        or "//" in path
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or any(ord(char) < 32 or ord(char) == 127 for char in path)
    ):
        return None
    return path


def collect_candidates(root: Path, excludes: list[str], cache_root: Path) -> dict:
    if excludes != EXPECTED_EXCLUDES:
        raise ValueError("candidate exclusions must exactly match the Pages Graphify recipe")
    try:
        from graphify.detect import detect
    except ImportError as exc:
        raise RuntimeError("Graphify 0.9.121 must be installed before candidate collection") from exc
    try:
        installed_version = version("graphifyy")
    except PackageNotFoundError as exc:
        raise RuntimeError("Graphify package metadata is unavailable") from exc
    if installed_version != "0.9.121":
        raise RuntimeError(f"expected graphifyy 0.9.121, found {installed_version}")

    root = root.resolve()
    cache_root.mkdir(parents=True, exist_ok=True)
    result = detect(root, extra_excludes=excludes, cache_root=cache_root)
    raw = result.get("files", {}).get("code", [])
    if not isinstance(raw, list):
        raise RuntimeError("Graphify detect returned an invalid code candidate inventory")
    files = sorted({path for value in raw if isinstance(value, str) if (path := _repo_path(value, root))})
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True,
    ).stdout.strip()
    if len(sha) != 40 or any(char not in "0123456789abcdef" for char in sha):
        raise RuntimeError("git did not return a full lowercase source commit SHA")
    return {
        "schemaVersion": 1,
        "sourceSha": sha,
        "generator": "graphify.detect",
        "generatorVersion": installed_version,
        "codeOnly": True,
        "excludes": excludes,
        "files": files,
    }


def write_inventory(output: Path, inventory: dict) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(inventory, separators=(",", ":"), ensure_ascii=False) + "\n"
    fd, temp_name = tempfile.mkstemp(prefix=output.name + ".", suffix=".tmp", dir=output.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, output)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--exclude", action="append", default=[], dest="excludes")
    args = parser.parse_args()
    try:
        inventory = collect_candidates(Path.cwd(), args.excludes, args.output.resolve().parent)
        write_inventory(args.output, inventory)
    except Exception as exc:  # make sure a bad inventory blocks publication
        print(f"Graphify candidate collection failed: {exc}", file=sys.stderr)
        return 1
    print(f"Graphify candidates: {len(inventory['files'])} files for {inventory['sourceSha']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
