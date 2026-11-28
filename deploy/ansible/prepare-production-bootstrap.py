#!/usr/bin/env python3
"""Prepare an ephemeral, pinned GitHub Actions Ansible bootstrap controller.

This operation never opens a network connection or writes to the target VM.
"""
from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

import yaml

USERNAME = re.compile(r"[a-z_][a-z0-9_-]{0,31}\Z")
MAIN_SHA = re.compile(r"[a-f0-9]{40}\Z")
RUN_NUMBER = re.compile(r"[1-9][0-9]*\Z")
MUTATING_MODES = frozenset({"bootstrap", "owner-setup", "prepare-activation"})
class InvalidBootstrapInput(ValueError):
    pass


def required(env: dict[str, str], name: str) -> str:
    value = env.get(name, "")
    if not value:
        raise InvalidBootstrapInput(f"Missing protected input: {name}")
    return value


def truth(value: str, label: str) -> bool:
    if value not in ("true", "false"):
        raise InvalidBootstrapInput(f"{label} must be exactly true or false")
    return value == "true"


def validate_host(host: str) -> None:
    try:
        ipaddress.ip_address(host)
        if "%" in host:
            raise ValueError("Scoped IP addresses are unsupported")
        return
    except ValueError:
        pass
    if len(host) > 253 or not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", p) for p in host.split(".")):
        raise InvalidBootstrapInput("Bootstrap host must be a single literal address or DNS name")


def certified_image(env: dict[str, str], runner_temp: Path, repository: str,
                    repository_id: int, owner_id: int, image_repository: str) -> str:
    source = required(env, "GITHUB_SHA")
    run_id = required(env, "GITHUB_RUN_ID")
    attempt = required(env, "GITHUB_RUN_ATTEMPT")
    if not MAIN_SHA.fullmatch(source) or not RUN_NUMBER.fullmatch(run_id) or not RUN_NUMBER.fullmatch(attempt):
        raise InvalidBootstrapInput("Invalid protected workflow identity")
    # This receipt comes from the protected preflight candidate verifier, which
    # checks the producer, Git tree, certificate and embedded image identity.
    # Dispatch inputs select a candidate and cannot supply a receipt.
    path = runner_temp / "codexia-lifecycle-candidate.json"
    if path.is_symlink() or not path.is_file():
        raise InvalidBootstrapInput("Bootstrap requires the verified lifecycle candidate receipt")
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
        candidate = receipt["candidateBackend"]
        profile = candidate["identity"]["profile"]
        certified = candidate["image"]
    except (OSError, UnicodeError, ValueError, KeyError, TypeError) as exc:
        raise InvalidBootstrapInput("Bootstrap requires the verified lifecycle candidate receipt") from exc
    if (receipt.get("sourceSha") != source or type(receipt.get("runId")) is not int or str(receipt["runId"]) != run_id
            or type(receipt.get("attempt")) is not int or str(receipt["attempt"]) != attempt):
        raise InvalidBootstrapInput("Verified lifecycle candidate does not match the current workflow run and attempt")
    if (receipt.get("repository") != repository or receipt.get("repositoryId") != repository_id or
            receipt.get("ownerId") != owner_id):
        raise InvalidBootstrapInput("Verified lifecycle candidate belongs to a different repository")
    verify_run = candidate.get("verifyRun", {})
    if (verify_run.get("repository") != repository or verify_run.get("repositoryId") != repository_id or
            verify_run.get("ownerId") != owner_id):
        raise InvalidBootstrapInput("Certified deployment image belongs to a different repository")
    if (not isinstance(certified, str) or
            not re.fullmatch(re.escape(image_repository) + r"@sha256:[a-f0-9]{64}", certified) or profile != "full"):
        raise InvalidBootstrapInput("Verified lifecycle candidate does not match the reviewed digest and Full profile")
    return certified


def prepare(env: dict[str, str]) -> dict[str, str]:
    if (env.get("GITHUB_ACTIONS") != "true" or
            env.get("GITHUB_REF") != "refs/heads/main" or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"):
        raise InvalidBootstrapInput("Production bootstrap preparation is restricted to manual runs on protected main")
    repository = required(env, "GITHUB_REPOSITORY")
    owner_match = re.fullmatch(r"([A-Za-z0-9-]+)/codexia", repository)
    repository_id = required(env, "GITHUB_REPOSITORY_ID")
    owner_id = required(env, "GITHUB_REPOSITORY_OWNER_ID")
    if not owner_match or not RUN_NUMBER.fullmatch(repository_id) or not RUN_NUMBER.fullmatch(owner_id):
        raise InvalidBootstrapInput("Missing immutable repository identity")
    image_repository = f"ghcr.io/{owner_match[1].lower()}/codexia-backend"
    operation = required(env, "CODEXIA_BOOTSTRAP_MODE")
    if operation != "preflight" and operation not in MUTATING_MODES:
        raise InvalidBootstrapInput("Unsupported bootstrap operation")
    host = required(env, "CODEXIA_BOOTSTRAP_HOST")
    validate_host(host)
    user = required(env, "CODEXIA_BOOTSTRAP_SSH_USER")
    if not USERNAME.fullmatch(user) or user in ("root", "codexia"):
        raise InvalidBootstrapInput("Bootstrap must use an independent non-root administrator SSH identity")
    init_approved = truth(required(env, "CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED"), "Database initialization approval")
    if operation != "bootstrap" and init_approved:
        raise InvalidBootstrapInput("Read-only preflight and owner operations must not include mutation approvals for database initialization")

    runner_temp = Path(required(env, "RUNNER_TEMP")).resolve(strict=True)
    image = (certified_image(env, runner_temp, repository, int(repository_id), int(owner_id), image_repository)
             if operation in MUTATING_MODES else None)
    root = runner_temp / "codexia-bootstrap"
    if root.exists() or root.is_symlink():
        raise InvalidBootstrapInput("Refusing to reuse an existing bootstrap controller directory")
    root.mkdir(mode=0o700)
    control = root / "control"
    control.mkdir(mode=0o700)
    profile = json.loads(Path(__file__).resolve().parents[1].joinpath("production.json").read_text(encoding="utf-8"))
    vars_ = {
        "codexia_service_user": "codexia", "codexia_service_group": "codexia",
        "codexia_service_home": "/home/codexia", "codexia_service_uid": profile["serviceUid"],
        "codexia_service_gid": profile["serviceGid"],
    }
    if operation == "bootstrap":
        runtime_key = required(env, "CODEXIA_RUNTIME_SSH_PUBLIC_KEY")
        if not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}", runtime_key):
            raise InvalidBootstrapInput("Protected runtime SSH public key is invalid")
        tunnel = env.get("CODEXIA_TUNNEL_TOKEN", "")
        if tunnel:
            if not re.fullmatch(r"[!-~]{1,8192}", tunnel):
                raise InvalidBootstrapInput("Expected a single Tunnel connector token")
            try:
                target = json.loads(required(env, "CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET"))
                credential = json.loads(base64.b64decode(tunnel + "=" * (-len(tunnel) % 4), validate=True))
                if (target["repository"] != repository or target["repositoryId"] != int(repository_id) or
                    target["ownerId"] != int(owner_id) or target["origin"] != profile["publicOrigin"] or
                    target["origin"] != required(env, "CODEXIA_PUBLIC_ORIGIN") or
                    not target["accountId"] or not target["tunnelId"] or
                    credential["a"] != target["accountId"] or credential["t"] != target["tunnelId"]):
                    raise ValueError
            except (binascii.Error, UnicodeError, ValueError, KeyError, TypeError) as exc:
                raise InvalidBootstrapInput("Tunnel connector token does not match the protected Cloudflare target") from exc
            tunnel_file = control / "tunnel-token"
            with open(tunnel_file, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
                output.write(tunnel)
            vars_["codexia_tunnel_token_file"] = str(tunnel_file)
        vars_.update({
            "codexia_create_service_account": True, "codexia_host_approved": True,
            "codexia_secrets_approved": True, "codexia_base_approved": True, "codexia_auth_runtime_approved": True,
            "codexia_managed_bootstrap_secrets": True,
            "codexia_deploy_ssh_public_key": runtime_key,
            "codexia_public_origin": profile["publicOrigin"],
            "codexia_api_audience": profile["publicOrigin"] + "/api",
            "codexia_oauth_introspection_client_id": profile["introspectionClientId"],
            "codexia_oauth_owner_client_ids": profile["webClientId"] + "," + profile["iosClientId"],
            "codexia_owner_setup_web_redirect_uris": [profile["publicOrigin"] + profile["desktopCallbackPath"]],
        })
    if operation == "owner-setup":
        recipient = required(env, "CODEXIA_OWNER_SETUP_AGE_RECIPIENT")
        if not re.fullmatch(r"age1[0-9a-z]+", recipient):
            raise InvalidBootstrapInput("Invalid owner handoff recipient")
        vars_["codexia_owner_setup_age_recipient"] = recipient
    if operation in ("owner-setup", "prepare-activation"):
        vars_["codexia_owner_setup_approved"] = True
        vars_["codexia_owner_setup_edge_approved"] = operation == "owner-setup"

    ssh = root / "ssh"
    ssh.mkdir(mode=0o700)
    key = ssh / "id_ed25519"
    key.write_text(required(env, "CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY").rstrip("\n") + "\n", encoding="utf-8")
    key.chmod(0o600)
    known = ssh / "known_hosts"
    known.write_text(required(env, "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS").rstrip("\n") + "\n", encoding="utf-8")
    known.chmod(0o600)
    try:
        public = subprocess.run(["ssh-keygen", "-y", "-P", "", "-f", str(key)], check=True,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout.split()
        if operation == "bootstrap" and public[:2] == runtime_key.split():
            raise InvalidBootstrapInput("Administrator and runtime SSH keys must be independent")
        subprocess.run(["ssh-keygen", "-F", host, "-f", str(known)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise InvalidBootstrapInput("Bootstrap SSH key or independently pinned target host key is invalid") from exc
    config = ssh / "config"
    config.write_text(f"""Host codexia-bootstrap-target
    HostName {host}
    User {user}
    IdentityFile {key}
    IdentitiesOnly yes
    BatchMode yes
    ConnectTimeout 10
    StrictHostKeyChecking yes
    UserKnownHostsFile {known}
    GlobalKnownHostsFile /dev/null
    PasswordAuthentication no
    KbdInteractiveAuthentication no
""", encoding="utf-8")
    config.chmod(0o600)

    # Scope connection settings to the SSH host. Global extra-vars would also
    # redirect plays' delegate_to: localhost tasks to the VM.
    connection = {
        "ansible_host": "codexia-bootstrap-target",
        "ansible_user": user,
        "ansible_connection": "ssh",
        "ansible_ssh_common_args": f"-F {shlex.quote(str(config))}",
        "ansible_ssh_private_key_file": str(key),
        "ansible_ssh_use_tty": False,
    }
    inventory = {"all": {"children": {"codexia": {
        "hosts": {"codexia-target": connection}, "vars": vars_,
    }}}}
    (control / "inventory.yml").write_text(yaml.safe_dump(inventory, sort_keys=False), encoding="utf-8")

    overrides: dict[str, object] = {
        "codexia_stage": "inspect" if operation == "preflight" else operation,
        "codexia_database_initialization_approved": init_approved,
    }
    if image is not None:
        overrides["codexia_auth_bootstrap_image"] = image
    runtime = control / "runtime-vars.json"
    runtime.write_text(json.dumps(overrides, separators=(",", ":")) + "\n", encoding="utf-8")
    runtime.chmod(0o600)
    outputs = env.get("GITHUB_OUTPUT")
    if outputs:
        with open(outputs, "a", encoding="utf-8") as output:
            output.write(f"host={host}\nuser={user}\ncontrol={control}\nssh_config={config}\n")
    return {"control": str(control), "host": host, "mode": operation}


if __name__ == "__main__":
    try:
        result = prepare(dict(os.environ))
        print(f"Protected {result['mode']} inputs validated for the pinned bootstrap target; no secret values were logged.")
    except InvalidBootstrapInput as error:
        print(f"Bootstrap preflight refused: {error}", file=sys.stderr)
        sys.exit(1)
