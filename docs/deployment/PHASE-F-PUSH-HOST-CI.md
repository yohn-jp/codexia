# Phase F push-host bootstrap fixture

The [Phase F push-host fixture](../../.github/workflows/phase-f-push-host.yml) runs manually or for pull requests that change its fixture, workflow, or host-stage inputs. It is the first reusable whole-host fixture slice for the deployment path authorized by #430. It runs the real Ansible `host` stage on a disposable Ubuntu 26.04 Actions host using the production service identity name `codexia` and isolated UID/GID 22001. It checks fresh and repeated host convergence, lingering, the rootless user manager, Podman rootless mode, and a real Quadlet internal network start/stop. The fixture removes its `codexia` account and home after successful evidence capture.

The fixture input boundary is the `CODEXIA_HOST_CONVERGENCE` callable plus the `CODEXIA_HOST_FIXTURE_*` identity variables consumed by `test-host-integration.sh`. When configured, the callable receives the private inventory path and lifecycle name (`host`) and must emit the same truthful first/repeat change evidence. If unset, the helper uses the current Ansible `site.yml` host stage. The dedicated wrapper fixes identity to `codexia`, rejects preexisting identity or home state, and accepts only its manual workflow marker. The upcoming canonical push entrypoint can implement the callable and reuse the same isolated account and evidence envelope without adding updater-only acceptance stages.

The workflow has read-only repository permissions, no production environment, no secrets, and no deploy-capable step. Its artifact binds the observation to the exact source SHA, workflow run, attempt, and runner. It contains no private credentials.

## Evidence boundary

This slice proves host/account bootstrap on an ephemeral GitHub Actions Ubuntu host. The following remain `NOT_CHECKED`: the future push deployment entrypoint, application preparation, API readiness, PostgreSQL or volume continuity, rollback, a VM reboot, Tailscale/SSH access, and production acceptance. VM reboot recovery requires a later isolated VM fixture capable of rebooting and observing the same guest; a workflow runner cannot safely reboot itself and continue as if it had.

The former manual updater acceptance workflow is not part of this fixture. Existing updater lifecycle evidence does not prove push deployment behavior. #183 remains open for the remaining disposable whole-host lifecycle and target-host evidence.
