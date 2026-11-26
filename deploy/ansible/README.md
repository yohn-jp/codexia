# Codexia Ansible push deployment

> On a pristine approved VM, the browser enrollment flow uses a one-time setup key and a restricted Fastify API behind Cloudflare. The protected production workflow uses the normal same-origin frontend. See [first owner through the browser](AUTH-RUNTIME.md#first-owner-through-the-browser) and the [initial deployment design](../../docs/deployment/INITIAL-DEPLOYMENT-FLOW.md).

The [initial deployment state machine](../../docs/deployment/INITIAL-DEPLOYMENT-FLOW.md) and [compatible update/rollback state machine](../../docs/deployment/UPDATE-FLOW.md) are normative. The implemented `bootstrap` stage converges approved host, secrets, base, and auth-runtime tasks; owner enrollment and protected application activation remain separate.

The protected GitHub Actions → Tailscale → SSH workflow is the only deployment controller. Under the rootless `codexia` service account, Ansible converges PostgreSQL, API and Tunnel Quadlets. `site.yml` rejects the obsolete pull-updater stages.

The protected controller generates its inventory and pins SSH. An isolated stage test can use its own inventory:

```bash
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=inspect
```

Supported stages are `inspect`, `bootstrap`, `host`, `secrets`, `base`, `auth-runtime`, `deploy`, `deploy-lifecycle-fixture` and `restore-drill`. The lifecycle fixture stage runs only from the run-bound disposable GitHub Actions workflow; it is not a production operation.

The `host` stage validates Ubuntu 26.04, systemd and cgroup v2, and creates or adopts the authorized service account. The `secrets` stage installs the Tunnel credential and the two PostgreSQL credentials without implicit rotation. The `base` stage converges networks, volumes, PostgreSQL 17 and Tunnel Quadlets, verifying exact persistent storage and identities. These stages do not publish new API images.

The `deploy` stage requires a certified immutable Full image, main-source provenance certificate, compatible deployed UI epoch and a backup directory and an age recipient. It recovers interrupted transactions, validates the backup destination, serializes application changes, backs up before replacing an existing API, and observes candidate health. Image-only updates refuse changed migration fingerprint, persistence format or API epoch. A failed candidate restores the prior Quadlet and release record.

## Bring up a new VM

Start [Protected production Bootstrap](../../docs/deployment/PRODUCTION-BOOTSTRAP.md) with the pinned administrator login and approved target. The controller derives the deployment public key in the runtime Environment, generates the Ansible inventory, and installs the key with OpenSSH's `restrict` option. On an approved fresh VM the rootless service generates its DB and authentication credentials. R4 encrypts these values for independent recovery before provisioning the DB. The [example inventory](inventory.example.yml) describes the individual stages used by disposable hosts and explicit recovery operations.

A fresh R4 ends with the DB and authentication schema prepared. R5 opens the restricted API for the [browser handoff](AUTH-RUNTIME.md#first-owner-through-the-browser) after the certified frontend is available.

After enrollment and preparation, the protected production workflow can activate the certified image with the two first-install approvals and handle subsequent compatible updates. See the [first activation procedure](../../docs/deployment/PUSH-DEPLOYMENT.md#first-application-activation).

Schema and persistence-format changes are not currently supported by the image-only push workflow. No startup migration bypass is permitted. The candidate remains blocked until an independent migration procedure defines approval, backup, execution, verification, and tested restore.

The host lock and deployment state are under `~/.local/state/codexia-deploy`. The backup executable is `deploy/backup/backup.sh`. The `restore-drill` stage is executed on an isolated local recovery host and never restores production data. See [Push deployment](../../docs/deployment/PUSH-DEPLOYMENT.md) and [Backup](../../docs/deployment/BACKUP.md).

No polling, timer, signed channel, route selector or compatibility controller is installed. Repository changes do not modify the live VM.
