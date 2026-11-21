# Ansible performance A/B — experimental, read-only against production

This workflow compares alternatives **without modifying the canonical Ansible
runtime, deployment path, inventory, credentials, or any production VM**. Trigger
\`Ansible performance A/B (experimental)\` by changing this harness in a PR or
through \`workflow_dispatch\`. It runs only on GitHub-hosted Ubuntu 26.04
disposable runners. Dependencies are pinned to the repository's
\`ansible-core==2.21.6\` and experimental \`mitogen==0.3.55\`. Mitogen is not
introduced into \`deploy/ansible/requirements.txt\`.

## Two distinct measurements

1. **SSH A/B:** A disposable SSH daemon bound to 127.0.0.1:22222, a
   unique keypair with a pinned host key, a dedicated login identity, and
   \`sudo\` limited to becoming a separate fixture service account. Each profile
   runs the same read-only Ansible \`setup\`, \`command\`, \`stat\`, \`slurp\`,
   privilege-switching and acceptance assertions. The synthetic file-check
   workload models multiple inexpensive Podman/SQL/status checks, **not their
   actual database or Podman processing time**.
2. **Rootless contract A/B:** Reuse the existing
   \`test-base-secrets-integration.sh\` and
   \`test-base-runtime-integration.sh\` unchanged, on disposable rootless
   Podman/systemd fixtures using the repository's **local** Ansible connection.
   Run the full sequence first under \`linear\`, then under \`mitogen_linear\`.
   Record total seconds, every playbook invocation, the sum of playbook wall
   times, and whether both contract scripts pass. Some playbook invocations
   intentionally fail as negative tests; **only the parent contract script
   exit status** determines contract validity.

The full contract's connection is \`ansible_connection: local\`, whereas
production is SSH. Consequently it can test Mitogen compatibility with the
real Codexia tasks, but **cannot prove Mitogen/SSH performance in production**.
The SSH fixture separately tests connection overhead.

## Variants

| Arm | Change relative to A |
| --- | --- |
| A-baseline | \`linear\`, 5 forks, no pipeline or mux, full facts, individual checks |
| B-forks20 | Increase forks to 20; a negative control for the one-host topology |
| C-pipelining | SSH pipelining |
| D-multiplex | SSH ControlMaster/ControlPersist |
| E-ssh-combined | Pipelining + multiplex |
| F-minimal-facts | \`['!all', '!min', 'user']\` facts |
| G-command-batching | One shell invocation for the same twelve read-only checks |
| H-linear-combined | All three standard Ansible reductions |
| I-mitogen | \`mitogen_linear\`, otherwise baseline |
| J-mitogen-combined | Mitogen + all tested reductions |

The target fixture and source SHA are fixed for all arms. The first baseline
run is warm-up only. By default, two measured repetitions execute in forward
then reverse order to reduce systematic order effects. Results show per-sample
wall times, medians, ratios, source SHA, Ansible version and exact settings.
Package installation, image pulling, and user/account creation are **excluded**
from measurement. These are small samples: they are screening evidence, not
a statistically significant production speedup claim.

The A/B workload makes no application mutations. Authentication is key-only,
password login and root login are disabled, SSH host key checking remains
enabled, and the private key is never uploaded. The only escalation grant is
from the disposable SSH login user to the disposable fixture service user.

## Evidence and decision rules

- Review each job's GitHub Step Summary and both 30-day artifacts:
  \`ansible-ssh-ab-measurements\` (\`results.json\`, per-arm logs, summary) and
  \`ansible-base-contract-ab\` (\`contract.csv\`, per-call timings and logs).
- An arm with failed SSH identity, file identity, checked inputs, escalation,
  or failed playbook status is recorded as **invalid**. Invalid candidates
  cannot win by finishing early.
- A failed baseline is a workflow failure. An experimental Mitogen failure is
  reported as a rejected candidate and **does not affect canonical release
  admission**. It is never silently substituted for a successful variant.
- Distinguish the reduction in Ansible process overhead from time spent inside
  PostgreSQL, Podman and systemd. Changes to checks or facts are not proof that
  an actual production safety assertion may be deleted.
- Before adopting a candidate, re-run the complete rootless contracts,
  host/auth-runtime validations, remote SSH \`become\` paths, negative checks,
  fail-closed safety and idempotency against the exact candidate
  implementation. Deployment and restoration acceptance remain independent.
- Refactoring the real PostgreSQL/Podman calls, reducing the **27-ish**
  repeated playbook invocations, and changing production fact collection
  require separate code changes and full contract verification; their
  production speedup is **not measured** merely by the synthetic batching
  arm. The per-invocation evidence identifies where later controlled A/B
  experiments should concentrate.

This harness does not install anything on the live VM, enable Mitogen for
production, skip safety assertions, modify database state, or deploy an image.
