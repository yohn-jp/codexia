"""Compare fresh private extracts of the fixture's admitted image. Never switch current."""

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from time import monotonic_ns


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def output(*args):
    return run(*args, text=True, stdout=subprocess.PIPE).stdout.strip()


def shell(*args):
    return ["bash", "-euo", "pipefail", "-c", *args]


def tree_digest(directory):
    # GNU tar records paths, file types, modes, numeric owners, hard links,
    # symlink targets and contents. Ignore creation order and timestamps.
    result = run(*shell('tar --sort=name --mtime=@0 --numeric-owner -cf - app bin | sha256sum', "bash"),
                 cwd=directory, text=True, stdout=subprocess.PIPE)
    return result.stdout.split()[0]


def extract(method, image, directory):
    flags = ["--pull=never", "--network=none", "--read-only", "--cap-drop=all",
             "--security-opt=no-new-privileges", "--image-volume=ignore", "--entrypoint=tar"]
    if method == "mounted_copy" and subprocess.run(["podman", "unshare", "true"]).returncode != 0:
        return "mount_unavailable"
    if method == "tar":
        run(*shell('podman run --rm "$@" -cf - -C / app -C /usr/local bin/node | '
                   'tar --no-same-owner -xf -', "bash", *flags, image), cwd=directory)
        return "copied"

    container = output("podman", "create", *flags, image)
    try:
        (directory / "bin").mkdir()
        if method == "podman_cp":
            run("podman", "cp", f"{container}:/app", directory / "app")
            run("podman", "cp", f"{container}:/usr/local/bin/node", directory / "bin/node")
        else:
            result = subprocess.run(["podman", "unshare", *shell("""
                mount=$(podman mount "$1") || exit 77
                status=0
                cp -R --preserve=links,mode -- "$mount/app" "$2/app" &&
                  cp -P --preserve=mode -- "$mount/usr/local/bin/node" "$2/bin/node" || status=$?
                podman unmount "$1" >/dev/null || exit 1
                exit "$status"
                """, "bash", container, directory)])
            if result.returncode == 77:
                return "mount_unavailable"
            result.check_returncode()
        # Copying out of the user namespace must give the service account
        # the same ownership as tar --no-same-owner.
        if any((path.lstat().st_uid, path.lstat().st_gid) != (os.getuid(), os.getgid())
               for path in (directory / "app", directory / "bin/node")):
            run("podman", "unshare", "chown", "-hR", "0:0", directory / "app", directory / "bin")
        # Match the canonical non-root tar extraction under umask 077.
        run("chmod", "-R", "go-rwx", directory / "app", directory / "bin")
        return "copied"
    except subprocess.CalledProcessError:
        # A rejected alternative does not suppress the next comparison.
        return "copy_failed"
    finally:
        run("podman", "rm", container, stdout=subprocess.DEVNULL)


def main():
    os.umask(0o077)
    root = Path.home() / ".local/share/codexia-backup"
    record = json.loads((Path.home() / ".local/state/codexia-deploy/deployed-release.json").read_text())
    image = record["image"]
    match = re.fullmatch(r".+@sha256:([a-f0-9]{64})", image)
    if match is None:
        raise ValueError("Benchmark requires an immutable image reference")
    digest = match[1]
    selected = (root / "current").resolve(strict=True)
    if (selected != root / "releases" / digest or
            json.loads((selected / "app/update-identity.json").read_text()) != record["identity"]):
        raise ValueError("Benchmark requires the selected runtime for the committed image")
    reference = tree_digest(selected)
    print(f"BACKUP_EXTRACTION image={image} reference_sha256={reference}", flush=True)

    methods = ("tar", "podman_cp", "mounted_copy")
    for trial, order in enumerate((methods, reversed(methods)), start=1):
        for method in order:
            with tempfile.TemporaryDirectory(dir=root, prefix=".benchmark-") as stage:
                directory = Path(stage)
                start = monotonic_ns()
                status = extract(method, image, directory)
                duration = (monotonic_ns() - start) // 1_000_000
                observed = "-"
                if status == "copied":
                    observed = tree_digest(directory)
                    status = "equivalent" if observed == reference else "different"
                print(f"BACKUP_EXTRACTION trial={trial} method={method} duration_ms={duration} "
                      f"status={status} tree_sha256={observed}", flush=True)
                if method == "tar" and status != "equivalent":
                    raise ValueError("Fresh baseline differs from the selected certified runtime")


if __name__ == "__main__":
    main()
