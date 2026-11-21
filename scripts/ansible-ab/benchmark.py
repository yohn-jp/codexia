#!/usr/bin/env python3
"""Read-only, paired Ansible strategy/SSH/facts/task-granularity benchmark.

Invoked only from the disposable GitHub Actions SSH fixture.  Timing excludes
package installation, fixture construction, and artifact upload.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Arm:
    name: str
    strategy: str = "linear"
    pipelining: bool = False
    multiplex: bool = False
    facts: str = "full"
    commands: str = "split"
    forks: int = 5


ARMS = (
    Arm("A-baseline"),
    Arm("B-forks20", forks=20),
    Arm("C-pipelining", pipelining=True),
    Arm("D-multiplex", multiplex=True),
    Arm("E-ssh-combined", pipelining=True, multiplex=True),
    Arm("F-minimal-facts", facts="user"),
    Arm("G-command-batching", commands="batched"),
    Arm("H-linear-combined", pipelining=True, multiplex=True, facts="user", commands="batched"),
    Arm("I-mitogen", strategy="mitogen_linear"),
    Arm("J-mitogen-combined", strategy="mitogen_linear", pipelining=True, multiplex=True, facts="user", commands="batched"),
)
SENTINEL = "CODEXIA_ANSIBLE_AB_CONTRACT_OK"


def config_for(arm: Arm, plugin_path: Path, known_hosts: Path, control_path: Path) -> str:
    ssh_options = (
        "-o BatchMode=yes -o IdentitiesOnly=yes "
        "-o StrictHostKeyChecking=yes "
        f"-o UserKnownHostsFile={known_hosts} "
        "-o ConnectionAttempts=1 "
    )
    if arm.multiplex:
        ssh_options += f"-o ControlMaster=auto -o ControlPersist=60s -o ControlPath={control_path}"
    else:
        ssh_options += "-o ControlMaster=no -o ControlPersist=no"
    return (
        "[defaults]\n"
        "host_key_checking = True\n"
        f"forks = {arm.forks}\n"
        f"strategy = {arm.strategy}\n"
        f"strategy_plugins = {plugin_path}\n"
        "retry_files_enabled = False\n"
        "interpreter_python = /usr/bin/python3\n"
        "[ssh_connection]\n"
        f"pipelining = {'True' if arm.pipelining else 'False'}\n"
        f"ssh_args = {ssh_options}\n"
    )


def run_benchmark(args: argparse.Namespace) -> int:
    dest = Path(args.output).resolve()
    if dest.exists() and any(dest.iterdir()):
        raise ValueError(f"Output directory is not empty: {dest}")
    dest.mkdir(parents=True, exist_ok=True)
    root = Path(args.fixture).resolve()
    known_hosts = root / "known_hosts"
    plugin_path = Path(args.mitogen_strategy_path).resolve()
    control_path = root / "control-%C"
    inventory = root / "inventory.yml"
    if not known_hosts.is_file() or not inventory.is_file() or not (plugin_path / "mitogen_linear.py").is_file():
        raise ValueError("Pinned host key, SSH inventory or Mitogen plugin is missing")
    if len(str(control_path)) >= 90:
        raise ValueError("SSH ControlPath may exceed UNIX socket length")
    if args.repetitions not in range(1, 6):
        raise ValueError("Repetitions must be between 1 and 5")
    if not os.environ.get("GITHUB_ACTIONS") == "true":
        raise ValueError("This benchmark requires a disposable GitHub Actions runner")

    configs = {}
    for arm in ARMS:
        path = dest / f"{arm.name}.cfg"
        path.write_text(config_for(arm, plugin_path, known_hosts, control_path), encoding="utf-8")
        configs[arm.name] = path

    results: list[dict] = []

    def invoke(arm: Arm, repetition: int, warmup: bool = False) -> None:
        label = "warmup" if warmup else f"r{repetition:02d}"
        path = dest / f"{arm.name}-{label}.log"
        env = dict(os.environ)
        env["ANSIBLE_CONFIG"] = str(configs[arm.name])
        env["ANSIBLE_HOST_KEY_CHECKING"] = "True"
        env["ANSIBLE_NOCOLOR"] = "1"
        env.pop("ANSIBLE_STRATEGY", None)
        env.pop("ANSIBLE_SSH_PIPELINING", None)
        cmd = [
            args.ansible_playbook, "-i", str(inventory), args.playbook,
            "-e", json.dumps({"benchmark_facts": arm.facts, "benchmark_commands": arm.commands}),
        ]
        started = time.monotonic_ns()
        try:
            proc = subprocess.run(cmd, cwd=args.repo_root, env=env, text=True, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, timeout=args.timeout, check=False)
            log = proc.stdout
            exit_code = proc.returncode
        except subprocess.TimeoutExpired as exc:
            log = (exc.stdout or b"").decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            log += "\nBENCHMARK_TIMEOUT\n"
            exit_code = 124
        elapsed_ms = round((time.monotonic_ns() - started) / 1_000_000, 1)
        path.write_text(log, encoding="utf-8")
        passed = exit_code == 0 and SENTINEL in log and re.search(r"failed=0\b", log) is not None \
            and re.search(r"unreachable=0\b", log) is not None
        record = {"arm": arm.name, "repetition": repetition, "warmup": warmup,
                  "elapsed_ms": elapsed_ms, "exit_code": exit_code, "contract_pass": passed,
                  "log": path.name}
        if not warmup:
            results.append(record)
            print(f"ANSIBLE_AB arm={arm.name} repetition={repetition} elapsed_ms={elapsed_ms} "
                  f"contract={'pass' if passed else 'FAIL'}", flush=True)
        else:
            print(f"ANSIBLE_AB warmup_contract={'pass' if passed else 'FAIL'}", flush=True)
        if arm.name == "A-baseline" and not passed:
            raise RuntimeError(f"Baseline failed; details: {path}")

    # A warm-up removes first interpreter/SSH/service startup from the timing sample.
    invoke(ARMS[0], 0, warmup=True)
    # Reverse every other pass to counter first/last variant scheduling bias.
    for repetition in range(1, args.repetitions + 1):
        arms = ARMS if repetition % 2 else tuple(reversed(ARMS))
        for arm in arms:
            invoke(arm, repetition)

    baseline_samples = [r["elapsed_ms"] for r in results if r["arm"] == "A-baseline"]
    baseline_median = statistics.median(baseline_samples)
    rows = []
    for arm in ARMS:
        samples = [r for r in results if r["arm"] == arm.name]
        valid = len(samples) == args.repetitions and all(r["contract_pass"] for r in samples)
        elapsed = statistics.median(r["elapsed_ms"] for r in samples) if valid else None
        rows.append({
            **asdict(arm), "contract_pass": valid,
            "median_ms": elapsed,
            "relative_speedup": round(baseline_median / elapsed, 3) if elapsed else None,
            "samples_ms": [r["elapsed_ms"] for r in samples],
        })

    summary = {
        "schema_version": 1,
        "source_sha": os.environ.get("GITHUB_SHA"),
        "os_image": os.environ.get("ImageOS"),
        "runner_arch": os.environ.get("RUNNER_ARCH"),
        "ansible_core": subprocess.check_output([args.ansible_playbook, "--version"], text=True).splitlines()[0],
        "mitogen_version": args.mitogen_version,
        "ssh_target": "loopback disposable SSH service account (not production)",
        "repetitions": args.repetitions,
        "baseline_median_ms": baseline_median,
        "arms": rows,
        "runs": results,
    }
    (dest / "results.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    lines = [
        "### Ansible SSH A/B benchmark (disposable loopback SSH, not production)",
        "",
        f"Baseline median: **{baseline_median / 1000:.2f}s**; {args.repetitions} samples per variant. "
        "Environment setup and dependency install excluded.",
        "",
        "| Arm | Strategy | Pipeline | SSH mux | Facts | Checks | Forks | Median | Speedup | Contract |",
        "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |",
    ]
    for row in rows:
        duration = f'{row["median_ms"]/1000:.2f}s' if row["median_ms"] is not None else "INVALID"
        speedup = f'{row["relative_speedup"]:.2f}x' if row["relative_speedup"] is not None else "—"
        lines.append(
            f'| {row["name"]} | {row["strategy"]} | {row["pipelining"]} | {row["multiplex"]} '
            f'| {row["facts"]} | {row["commands"]} | {row["forks"]} | {duration} | {speedup} '
            f'| {"PASS" if row["contract_pass"] else "FAIL"} |'
        )
    lines += ["", "Only passing, same-workload variants are comparable. "
              "Batching changes module invocation count, and facts mode changes gather scope; "
              "their results are experimental, not equivalent to changing production playbooks. "
              "The full base-runtime contract is checked separately.",
              "Mitogen is never enabled for production by this benchmark."]
    report = "\n".join(lines) + "\n"
    (dest / "summary.md").write_text(report, encoding="utf-8")
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as out:
            out.write(report)
    # Experimental candidates may be incompatible. Record them as failures in evidence,
    # but do not mistake such failures for passing performance improvements or affect
    # the canonical CI release admission. Baseline failure remains fatal.
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--ansible-playbook", required=True)
    parser.add_argument("--playbook", required=True)
    parser.add_argument("--mitogen-strategy-path", required=True)
    parser.add_argument("--mitogen-version", required=True)
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    return run_benchmark(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"ANSIBLE_AB_FATAL: {exc}", file=sys.stderr)
        sys.exit(1)
