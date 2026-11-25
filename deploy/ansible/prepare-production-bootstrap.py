#!/usr/bin/env python3
"""Prepare an ephemeral, pinned GitHub Actions Ansible bootstrap controller.

This operation never opens a network connection or writes to the target VM.
"""
from __future__ import annotations

import base64
import binascii
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tarfile

import yaml

REQUIRED_FILES = frozenset({
    "inventory.yml",
    "private/tunnel-token",
    "private/postgres-admin-password",
    "private/postgres-app-password",
    "private/codexia-auth-database-url",
    "private/codexia-auth-secret",
    "private/codexia-oauth-introspection-client-secret",
})
OPTIONAL_FILES = frozenset({
    "private/codexia-oidc-client-secret",
    "private/enrollment/bootstrap.env",
    "private/enrollment/tls.crt",
    "private/enrollment/tls.key",
})
FILE_VARS = {
    "codexia_tunnel_token_file": "private/tunnel-token",
    "codexia_postgres_admin_password_file": "private/postgres-admin-password",
    "codexia_postgres_app_password_file": "private/postgres-app-password",
    "codexia_auth_database_url_file": "private/codexia-auth-database-url",
    "codexia_auth_secret_file": "private/codexia-auth-secret",
    "codexia_oauth_introspection_client_secret_file": "private/codexia-oauth-introspection-client-secret",
}
IMMUTABLE_FULL_IMAGE = re.compile(r"ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}\Z")
USERNAME = re.compile(r"[a-z_][a-z0-9_-]{0,31}\Z")
HOST_ALIAS = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*\Z")
MAIN_SHA = re.compile(r"[a-f0-9]{40}\Z")
RUN_NUMBER = re.compile(r"[1-9][0-9]*\Z")
MUTATING_MODES = frozenset({"bootstrap", "owner-setup", "prepare-activation"})
CONTROLLER_VARS = frozenset({
    "codexia_stage", "codexia_bootstrap_stages", "codexia_auth_bootstrap_image",
    "codexia_expected_bootstrap_resume", "codexia_expected_owner_setup_checkpoint",
    "codexia_owner_setup_install_intent", "codexia_owner_setup_operation", "codexia_database_initialization_approved",
    "codexia_recreate_missing_app_database_approved", "codexia_expected_absent_database", "codexia_initial_install_approved",
})


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


def unpack_bundle(encoded: str, directory: Path) -> set[str]:
    try:
        compressed = base64.b64decode(encoded, validate=True)
    except binascii.Error as exc:
        raise InvalidBootstrapInput("Protected control bundle is not canonical base64") from exc
    if not compressed or len(compressed) > 131072:
        raise InvalidBootstrapInput("Protected control bundle exceeds the 128-KiB compressed limit")

    accepted = REQUIRED_FILES | OPTIONAL_FILES
    members_seen: set[str] = set()
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(compressed), mode="r:gz") as archive:
            for member in archive:
                if member.name not in accepted or member.name in members_seen or not member.isfile():
                    raise InvalidBootstrapInput("Protected control bundle contains an unexpected, duplicate, or non-regular entry")
                if member.size <= 0 or member.size > 32768:
                    raise InvalidBootstrapInput("Protected control bundle entry has invalid length")
                total += member.size
                if total > 131072:
                    raise InvalidBootstrapInput("Protected control bundle exceeds the uncompressed limit")
                contents = archive.extractfile(member)
                if contents is None:
                    raise InvalidBootstrapInput("Cannot read protected control bundle entry")
                data = contents.read(member.size + 1)
                if len(data) != member.size:
                    raise InvalidBootstrapInput("Protected control bundle entry size mismatch")
                destination = directory / member.name
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with destination.open("xb") as output:
                    output.write(data)
                destination.chmod(0o600)
                members_seen.add(member.name)
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise InvalidBootstrapInput("Protected control bundle is invalid") from exc
    if not REQUIRED_FILES.issubset(members_seen):
        raise InvalidBootstrapInput("Protected control bundle is missing required files")
    return members_seen


def inventory_vars(path: Path, host: str, user: str, operation: str) -> dict:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        all_hosts = data["all"]
        children = all_hosts["children"]
        group = children["codexia"]
        hosts = group["hosts"]
        vars_ = group["vars"]
    except (OSError, UnicodeError, yaml.YAMLError, KeyError, TypeError) as exc:
        raise InvalidBootstrapInput("Private inventory must declare a single codexia group, host and vars mapping") from exc
    if (set(data) != {"all"} or set(all_hosts) != {"children"} or set(children) != {"codexia"}
            or set(group) != {"hosts", "vars"} or not isinstance(hosts, dict)
            or len(hosts) != 1 or not isinstance(vars_, dict)):
        raise InvalidBootstrapInput("Private inventory must contain exactly one Codexia target")
    alias, host_config = next(iter(hosts.items()))
    if not isinstance(alias, str) or not HOST_ALIAS.fullmatch(alias):
        raise InvalidBootstrapInput("Private inventory must use one literal host alias")
    if not isinstance(host_config, dict) or set(host_config) != {"ansible_host", "ansible_user"}:
        raise InvalidBootstrapInput("Private inventory host may declare only the pinned host and user")
    if host_config["ansible_host"] != host or host_config["ansible_user"] != user:
        raise InvalidBootstrapInput("Private inventory host/user differ from independently pinned bootstrap target")
    if any(not isinstance(key, str) or not key.startswith("codexia_") or key in CONTROLLER_VARS or key.startswith("codexia_owner_setup_expected_")
           for key in vars_):
        raise InvalidBootstrapInput("Private inventory cannot set connection, stage, or protected controller inputs")
    if vars_.get("codexia_service_user") != "codexia" or vars_.get("codexia_service_home") != "/home/codexia":
        raise InvalidBootstrapInput("Private inventory must retain the existing rootless Codexia identity")
    uid = vars_.get("codexia_service_uid")
    if not isinstance(uid, int) or isinstance(uid, bool) or uid <= 0:
        raise InvalidBootstrapInput("Private inventory must pin the rootless service UID")
    if operation == "bootstrap":
        approvals = ("codexia_host_approved", "codexia_secrets_approved", "codexia_base_approved", "codexia_auth_runtime_approved")
        if any(vars_.get(flag) is not True for flag in approvals):
            raise InvalidBootstrapInput("Private inventory must explicitly approve host, secrets, base and auth-runtime stages")
    if operation in ("owner-setup", "prepare-activation") and vars_.get("codexia_owner_setup_approved") is not True:
        raise InvalidBootstrapInput("Private inventory must explicitly approve owner setup")
    if operation == "owner-setup" and vars_.get("codexia_owner_setup_edge_approved") is not True:
        raise InvalidBootstrapInput("Private inventory must explicitly approve the restricted owner setup edge")
    return vars_


def certified_image(env: dict[str, str], runner_temp: Path) -> str:
    image = env.get("CODEXIA_BOOTSTRAP_FULL_IMAGE", "")
    if not IMMUTABLE_FULL_IMAGE.fullmatch(image):
        raise InvalidBootstrapInput("Bootstrap requires the reviewed immutable Full image digest")
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
    if certified != image or profile != "full":
        raise InvalidBootstrapInput("Verified lifecycle candidate does not match the reviewed digest and Full profile")
    return certified


def prepare(env: dict[str, str]) -> dict[str, str]:
    if (env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REPOSITORY") != "yohn-jp/codexia" or
            env.get("GITHUB_REF") != "refs/heads/main" or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"):
        raise InvalidBootstrapInput("Production bootstrap preparation is restricted to manual runs on protected main")
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
    image = certified_image(env, runner_temp) if operation in MUTATING_MODES else None
    root = runner_temp / "codexia-bootstrap"
    if root.exists() or root.is_symlink():
        raise InvalidBootstrapInput("Refusing to reuse an existing bootstrap controller directory")
    root.mkdir(mode=0o700)
    control = root / "control"
    control.mkdir(mode=0o700)
    names = unpack_bundle(required(env, "CODEXIA_BOOTSTRAP_BUNDLE_B64"), control)
    vars_ = inventory_vars(control / "inventory.yml", host, user, operation)
    oidc = "private/codexia-oidc-client-secret" in names
    if ("codexia_oidc_client_id" in vars_) != oidc or ("codexia_oidc_issuer" in vars_) != oidc:
        raise InvalidBootstrapInput("OIDC client settings and their protected credential must be supplied together")
    enrollment = {p for p in names if p.startswith("private/enrollment/")}
    if enrollment and enrollment != {"private/enrollment/bootstrap.env", "private/enrollment/tls.crt", "private/enrollment/tls.key"}:
        raise InvalidBootstrapInput("Legacy enrollment requires all three protected files")
    if ("codexia_auth_enrollment_files_dir" in vars_) != bool(enrollment):
        raise InvalidBootstrapInput("Legacy enrollment inventory and protected inputs must agree")

    ssh = root / "ssh"
    ssh.mkdir(mode=0o700)
    key = ssh / "id_ed25519"
    key.write_text(required(env, "CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY").rstrip("\n") + "\n", encoding="utf-8")
    key.chmod(0o600)
    known = ssh / "known_hosts"
    known.write_text(required(env, "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS").rstrip("\n") + "\n", encoding="utf-8")
    known.chmod(0o600)
    try:
        subprocess.run(["ssh-keygen", "-y", "-P", "", "-f", str(key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
    overrides.update({name: str(control / path) for name, path in FILE_VARS.items()})
    if oidc:
        overrides["codexia_oidc_client_secret_file"] = str(control / "private/codexia-oidc-client-secret")
    if enrollment:
        overrides["codexia_auth_enrollment_files_dir"] = str(control / "private/enrollment")
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
