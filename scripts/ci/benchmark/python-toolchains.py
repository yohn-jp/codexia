"""Compare fresh package-manager environments; never run a production deployment."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time

ROOT = Path.cwd()
TARGET = os.environ["BENCH_TARGET"]
RESULTS = Path(os.environ["RUNNER_TEMP"]) / "python-toolchain-results"
RESULTS.mkdir(exist_ok=True)
ASSETS = {
    ("Linux", "x86_64"): ("x86_64-unknown-linux-gnu", "bf65ac1a0af10f92c522d91ac096c7c0a39657647b155577e7836c2cbbb4526c"),
    ("Linux", "aarch64"): ("aarch64-unknown-linux-gnu", "14590f644805a6234ffe071154340669e38137f38e60aa9629690119704107d2"),
    ("Darwin", "arm64"): ("aarch64-apple-darwin", "e419bf07533bdbf48795fc793601c834dd79db57a8c49ce8e25cfe3a8639958d"),
    ("Darwin", "x86_64"): ("x86_64-apple-darwin", "153e03197588204c04fc4c81cc4bafbfa4280222a385e4ee36a87aeec0ae63b4"),
}
REQUIREMENTS = {
    "graphify": ["graphifyy[sql,terraform]==0.9.115"],
    "ansible": ["-r", "deploy/ansible/requirements.txt"],
    "ansible-mitogen": ["-r", "deploy/ansible/requirements.txt", "mitogen==0.3.55"],
    "s3": ["--require-hashes", "-r", "deploy/backup/requirements.lock"],
    "huggingface": ["huggingface_hub==0.36.0"],
    "ios-yaml": ["PyYAML==6.0.3"],
}
def run(args, env=None, **kw):
    return subprocess.run([str(a) for a in args], cwd=ROOT, env=env, check=True, **kw)

def timed(args, env=None):
    start = time.monotonic()
    run(args, env)
    return round(time.monotonic() - start, 3)

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def validate(folder, env):
    py = folder / "bin/python"
    out = folder.parent / (folder.name + "-output")
    out.mkdir()
    start = time.monotonic()
    evidence = {}
    if TARGET == "graphify":
        env["GRAPHIFY_BACKEND"] = "none"
        excludes = ["tests/**", "evidence/**", ".agents/**", "docs/**", "**/*.test.*", "**/*.spec.*"]
        args = [v for pattern in excludes for v in ("--exclude", pattern)]
        run([folder / "bin/graphify", "extract", ".", "--code-only", "--out", out / "graph", "--max-workers", "2", *args], env, timeout=600)
        run([folder / "bin/graphify", "cluster-only", out / "graph", "--no-label"], env, timeout=120)
        graph = out / "graph/graphify-out"
        run([py, "scripts/graphify-pages/candidates.py", graph / "candidates.json", *args], env)
        run(["node", "scripts/graphify-pages/pack.mjs", graph, out / "site",
             subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), graph / "candidates.json"], env)
        index = json.loads((out / "site/graph/source.json").read_text())
        evidence = {"files": sorted(f["path"] for f in index["files"]), "stats": index["stats"]}
    elif TARGET.startswith("ansible"):
        cli = folder / "bin/ansible-playbook"
        run([cli, "--version"], env)
        for playbook in ("site", "preflight-observe"):
            run([cli, "-i", "deploy/ansible/inventory.example.yml", f"deploy/ansible/{playbook}.yml", "--syntax-check"], env)
        if TARGET == "ansible-mitogen":
            plugin = subprocess.check_output([str(py), "-c",
                "import ansible_mitogen,os;print(os.path.join(os.path.dirname(ansible_mitogen.__file__),'plugins','strategy'))"], text=True).strip()
            assert (Path(plugin) / "mitogen_linear.py").is_file()
            env["ANSIBLE_STRATEGY"] = "mitogen_linear"
            env["ANSIBLE_STRATEGY_PLUGINS"] = plugin
            play = out / "local.yml"
            play.write_text("- hosts: localhost\n  connection: local\n  gather_facts: false\n  tasks:\n    - ansible.builtin.command: /bin/true\n      changed_when: false\n")
            run([cli, "-i", "localhost,", "-e", f"ansible_python_interpreter={py}", play], env)
        evidence = {"syntax": ["site", "preflight-observe"], "mitogen": TARGET.endswith("mitogen")}
    elif TARGET == "s3":
        run([py, "-c", 'import boto3,botocore;assert boto3.__version__==botocore.__version__=="1.44.9"'], env)
        run([py, "-m", "unittest", "deploy.backup.test_s3_transfer", "deploy.backup.test_s3_admission", "deploy.backup.test_s3_retention", "-v"], env)
        evidence = {"hash_lock": digest(ROOT / "deploy/backup/requirements.lock")}
    elif TARGET == "huggingface":
        env["HF_HOME"] = str(out / "hf-home")
        env["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
        run([folder / "bin/hf", "download", "Xenova/multilingual-e5-small", "config.json", "--revision",
             "761b726dd34fb83930e26aab4e9ac3899aa1fa78", "--local-dir", out / "model", "--max-workers", "4"], env)
        config = out / "model/config.json"
        assert config.stat().st_size == 658
        assert digest(config) == "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1"
        evidence = {"config_sha256": digest(config)}
    elif TARGET == "ios-yaml":
        run([py, "ios/CodexiaTransport/normalize-openapi.py", "packages/http-contract/openapi/codexia.openapi.yaml",
             out / "normalized.json", out / "operations.tsv"], env)
        evidence = {name: digest(out / name) for name in ("normalized.json", "operations.tsv")}
    return round(time.monotonic() - start, 3), evidence

with tempfile.TemporaryDirectory(prefix="python-bench-", dir=os.environ["RUNNER_TEMP"]) as tmp:
    work = Path(tmp)
    asset, sha = ASSETS[(platform.system(), platform.machine())]
    archive = work / "uv.tar.gz"
    acquisition = timed(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2",
                         f"https://github.com/astral-sh/uv/releases/download/0.13.10/uv-{asset}.tar.gz", "--output", archive])
    assert digest(archive) == sha, "uv release checksum mismatch"
    run(["tar", "-xzf", archive, "-C", work])
    uv = work / f"uv-{asset}/uv"
    run([uv, "--version"])
    results = {"source": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
               "target": TARGET, "python": sys.version, "platform": platform.platform(),
               "uv_acquisition_seconds": acquisition, "arms": {}}
    path = RESULTS / "result.json"
    def save():
        path.write_text(json.dumps(results, indent=2, sort_keys=True) + "\n")
    save()
    for manager in ("pip", "uv"):
        folder = work / manager
        env = os.environ.copy()
        env.update(PIP_CACHE_DIR=str(work / "pip-cache"), PIP_DISABLE_PIP_VERSION_CHECK="1",
                   PIP_INDEX_URL="https://pypi.org/simple", UV_DEFAULT_INDEX="https://pypi.org/simple",
                   UV_CACHE_DIR=str(work / "uv-cache"), UV_NO_MANAGED_PYTHON="1", UV_LINK_MODE="copy")
        for key in ("PIP_EXTRA_INDEX_URL", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL"):
            env.pop(key, None)
        if manager == "pip":
            venv = timed([sys.executable, "-m", "venv", folder], env)
            install = timed([folder / "bin/python", "-m", "pip", "install", *REQUIREMENTS[TARGET]], env)
            run([folder / "bin/python", "-m", "pip", "check"], env)
        else:
            venv = timed([uv, "venv", "--python", sys.executable, folder], env)
            install = timed([uv, "pip", "install", "--python", folder / "bin/python", *REQUIREMENTS[TARGET]], env)
            run([uv, "pip", "check", "--python", folder / "bin/python"], env)
        packages = json.loads(subprocess.check_output([str(folder / "bin/python"), "-c",
            "import importlib.metadata as m,json,re;print(json.dumps({re.sub(r'[-_.]+','-',d.metadata['Name']).lower():d.version for d in m.distributions() if d.metadata['Name'].lower() not in ('pip','setuptools')}))"], text=True))
        arm = {"venv_seconds": venv, "install_seconds": install, "packages": packages}
        results["arms"][manager] = arm
        save()
        print("INSTALL_BENCHMARK", TARGET, manager, venv, install, len(packages), flush=True)
        verification, evidence = validate(folder, env)
        arm.update(verification_seconds=verification, evidence=evidence)
        save()
        print("VALIDATION_BENCHMARK", TARGET, manager, verification, flush=True)
    results["package_parity"] = results["arms"]["pip"]["packages"] == results["arms"]["uv"]["packages"]
    results["evidence_parity"] = results["arms"]["pip"]["evidence"] == results["arms"]["uv"]["evidence"]
    save()
    print("BENCHMARK_PARITY", TARGET, results["package_parity"], results["evidence_parity"], flush=True)
    assert results["package_parity"], "Resolved dependency versions differ; do not promote without lock parity"
    assert results["evidence_parity"], "Validation outputs differ; investigate before promotion"
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"## {TARGET}\n\nFresh package installation (seconds), no remote cache.\n\n")
        summary.write("| Manager | Venv | Install | Validation |\n|---|---:|---:|---:|\n")
        for manager, arm in results["arms"].items():
            summary.write(f"| {manager} | {arm['venv_seconds']} | {arm['install_seconds']} | {arm['verification_seconds']} |\n")
        summary.write(f"\nuv archive acquisition: {acquisition}s. Package and selected validation-output parity: PASS.\n")
