# Codexia Ansible push deployment

> **Current-runbook boundary:** The existing bootstrap stage converges host, secrets, PostgreSQL and auth staging, but first-owner registration still uses the SSH-forward launcher below. The agreed target is a 256-bit Ansible-managed one-time grant with owner-controlled Passkey enrollment through the Workers `/console/setup` screen and a restricted setup-only Fastify API. Those target features are **not yet implemented**. See [initial deployment design](../../docs/deployment/INITIAL-DEPLOYMENT-FLOW.md) and [console UX](../../docs/design/ADMIN-SCREEN-FLOW.md).

The [initial deployment state machine](../../docs/deployment/INITIAL-DEPLOYMENT-FLOW.md) and [compatible update/rollback state machine](../../docs/deployment/UPDATE-FLOW.md) are normative. The implemented `bootstrap` stage converges approved host, secrets, base, and auth-runtime tasks; owner enrollment and protected application activation remain separate.

The protected GitHub Actions → Tailscale → SSH workflow is the only deployment controller. Under the rootless `codexia` service account, Ansible converges PostgreSQL, API and Tunnel Quadlets. `site.yml` rejects the obsolete pull-updater stages.

Use a private inventory with pinned SSH host keys, externally supplied protected secrets and an explicit stage:

```bash
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=inspect
```

Supported stages are `inspect`, `bootstrap`, `host`, `secrets`, `base`, `auth-runtime`, `deploy`, `deploy-lifecycle-fixture` and `restore-drill`. The lifecycle fixture stage runs only from the run-bound disposable GitHub Actions workflow; it is not a production operation.

The `host` stage validates Ubuntu 26.04, systemd and cgroup v2, and creates or adopts the authorized service account. The `secrets` stage installs the Tunnel credential and the two PostgreSQL credentials without implicit rotation. The `base` stage converges networks, volumes, PostgreSQL 17 and Tunnel Quadlets, verifying exact persistent storage and identities. These stages do not publish new API images.

The `deploy` stage requires a certified immutable Full image, main-source provenance certificate, compatible deployed UI epoch and a backup directory and an age recipient. It recovers interrupted transactions, validates the backup destination, serializes application changes, backs up before replacing an existing API, and observes candidate health. Image-only updates refuse changed migration fingerprint, persistence format or API epoch. A failed candidate restores the prior Quadlet and release record.

## Bring up a new VM

Use the [example inventory](inventory.example.yml) with the VM's management address, pinned SSH host key, existing bootstrap login with sudo, service UID/GID and private credential file paths. Set `codexia_deploy_ssh_public_key` to the public half of the protected workflow key, or provision that SSH access externally. Ansible installs the declared key with OpenSSH's `restrict` option on the service account. The bootstrap administrator retains its own SSH connection for enrollment.

For a new host, enable the host, service-account creation, secrets, base, and database initialization approvals in the private inventory. Set `codexia_auth_runtime_approved: true` to include authentication, `codexia_auth_bootstrap_image` to the reviewed Full digest, and `codexia_auth_registration_pending: true` for initial enrollment. Prepare the [enrollment settings and TLS files](AUTH-RUNTIME.md#initial-owner-and-oauth-client-registration) in `codexia_auth_enrollment_files_dir`. Each file must be owned by the control user with mode 0400 or 0600. Apply the inventory from the reviewed checkout:

```bash
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=bootstrap
```

The play provisions the host, rootless credentials, networks, volumes, PostgreSQL and Tunnel definition in order. When authentication is approved it also fetches the pinned Full image on demand, initializes a pristine application database, and stages the auth schema, secrets and enrollment inputs. The Tunnel and API first start at protected activation.

Complete the owner and client registration over the administrative SSH connection. Use a local port forward on that connection and run the enrollment helpers as the service user with its user-systemd environment. Set registration pending to false, enter the returned internal owner ID, and reapply the same inventory. With the enrollment directory still declared, Ansible removes the three temporary files from the VM. The protected production workflow can then activate the certified image with the two first-install approvals and handle subsequent compatible updates. See the [first activation procedure](../../docs/deployment/PUSH-DEPLOYMENT.md#first-application-activation).

Schema and persistence-format changes are not currently supported by the image-only push workflow. No startup migration bypass is permitted. The candidate remains blocked until an independent migration procedure defines approval, backup, execution, verification, and tested restore.

The host lock and deployment state are under `~/.local/state/codexia-deploy`. The backup executable is `deploy/backup/backup.sh`. The `restore-drill` stage is executed on an isolated local recovery host and never restores production data. See [Push deployment](../../docs/deployment/PUSH-DEPLOYMENT.md) and [Backup](../../docs/deployment/BACKUP.md).

No polling, timer, signed channel, route selector or compatibility controller is installed. Repository changes do not modify the live VM.
