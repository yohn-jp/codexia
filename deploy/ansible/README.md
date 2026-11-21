# Codexia Ansible push deployment

The protected GitHub Actions → Tailscale → SSH workflow is the only deployment controller. Under the rootless `codexia` service account, Ansible converges PostgreSQL, API and Tunnel Quadlets. `site.yml` rejects the obsolete pull-updater stages.

Use a private inventory with pinned SSH host keys, externally supplied protected secrets and an explicit stage:

```bash
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=inspect
```

Supported stages are `inspect`, `host`, `secrets`, `base`, `deploy` and `restore-drill`.

The `host` stage validates Ubuntu 26.04, systemd and cgroup v2, and creates or adopts the authorized service account. The `secrets` stage installs four protected Podman secrets without implicit rotation. The `base` stage converges networks, volumes, PostgreSQL 17 and Tunnel Quadlets, verifying exact persistent storage and identities. These stages do not publish new API images.

The `deploy` stage requires a certified immutable Full image, main-source provenance certificate, compatible deployed UI epoch and approved off-VM encrypted backup inputs. It recovers interrupted transactions, validates the backup destination, serializes application changes, backs up before replacing an existing API, and observes candidate health. Image-only updates refuse changed migration fingerprint, persistence format or API epoch. A failed candidate restores the prior Quadlet and release record.

The host lock and deployment state are under `~/.local/state/codexia-deploy`. The backup executable is `deploy/backup/backup.sh`. The `restore-drill` stage is executed on an isolated local recovery host and never restores production data. See [Push deployment](../../docs/deployment/PUSH-DEPLOYMENT.md) and [Backup](../../docs/deployment/BACKUP.md).

No polling, timer, signed channel, route selector or compatibility controller is installed. Repository changes do not modify the live VM.
