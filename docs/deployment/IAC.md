# Infrastructure as code

The sole backend delivery path is **GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → rootless Podman Quadlet**. Cloudflare Tunnel remains application ingress, not the administration channel. No pull updater, polling timer, signed release channel, reverse-proxy selector or alternate writer controller is maintained.

The canonical production tasks are in [Ansible](../../deploy/ansible/README.md) and the Quadlet definitions in [Quadlet](../../deploy/quadlet). The protected production workflow verifies a certified immutable Full GHCR digest and its provenance, serializes deployment under a rootless host lock, requires encrypted off-VM backup and probes readiness. Pull-request validation receives no production credentials.

## Supported Ansible operations

| Stage | Responsibility |
| --- | --- |
| `inspect` | Read-only host and Podman inventory |
| `host` | Rootless service account and host prerequisites |
| `secrets` | Initial protected Podman credential convergence |
| `base` | Networks, persistent volumes, PostgreSQL and Tunnel Quadlets |
| `auth-runtime` | Explicit Better Auth role, schema, and runtime secret provisioning; no migrations or activation |
| `deploy` | Certified image admission, encrypted off-VM backup, application health and rollback |
| `restore-drill` | Isolated encrypted backup restoration and checksum verification |

Unsupported operations fail closed. Database schema changes require a separate approved migration process; image-only deployment refuses incompatible migration fingerprints, persistence formats and API epochs.

Runtime state lives only in `~/.local/state/codexia-deploy`, with the host lock, deployment release record and interruption recovery intent. There is no polling journal or route selector.

Require pinned SSH host keys, protected GitHub environment approval, independently held backup encryption keys and a private inventory. Never put credentials or private keys in Git.

First activation requires `host`, `secrets`, `base`, then `deploy` with explicit first-install and database-use approvals. On a pristine database, optional `auth-runtime` provisioning must follow the successful first `deploy`: its separate schema would otherwise fail the fresh-schema admission check. See the ordered procedure and the unsupported schema-maintenance boundary in [Push deployment](PUSH-DEPLOYMENT.md).

See [Backup](BACKUP.md) and [Host bootstrap acceptance](PUSH-HOST-CI.md) for their separate evidence boundaries.
