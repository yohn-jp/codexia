# Backup Console executor provisioning and recovery

**Status. Design proposal pending approval.** Backup operations owns this proposal. It is for deployment operators, recovery operators and reviewers of the VM runtime.
It covers provisioning and recovery of the existing v2 backup executor under the approved lifecycle and Ansible delivery path.
Backup format selection and the protected production recovery handoff have their own design decisions.
[Backup Console contract](../architecture/BACKUP-CONSOLE-CONTRACT.md) · [Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md) · [IaC](IAC.md)

## Current deployment gap

The Ansible transaction installs the backup producer, runner and launcher. The long-lived executor and deploy control CLI also need a private database connection, least-privilege login roles, the operational schema, a sealing key and operator configuration. The API needs its own constrained login, the public half of the sealing key and the operator policy. The installed API Quadlet supplies none of those inputs. The PostgreSQL Quadlet attaches to the internal data network and keeps its Unix socket inside the container. A host executor has no configured route to that PostgreSQL instance. [Deployment helper installation](../../deploy/ansible/deploy-prepare.yml) · [PostgreSQL Quadlet](../../deploy/quadlet/codexia-db.container) · [API Quadlet](../../deploy/quadlet/codexia-api.container) · [Existing operator settings](../../deploy/backup/CONSOLE.md)

An installation must reach ACTIVE with no S3 configuration or recovery receipt. The operator must then be able to enable the existing Console backup runtime and the owner must be able to configure a destination before R8 is enabled. This applies to current installations that reached ACTIVE before the runtime was provisioned as well as new installations. [Backup Console contract](../architecture/BACKUP-CONSOLE-CONTRACT.md) · [Update flow](UPDATE-FLOW.md)

## PostgreSQL access for the host executor

| Option | Fit | Verification needed |
| --- | --- | --- |
| **Use a PostgreSQL Unix socket in a private shared directory** | Keeps the executor and lock on the VM and preserves the isolated data network. The API can keep its existing container-network connection. | Confirm rootless UID mapping and access after reboot. Shared socket authentication must enforce SCRAM for the dedicated executor login and prevent unauthenticated access to any other login. PostgreSQL local HBA rules cover all Unix sockets, so verify the existing database bootstrap, backup and recovery commands with the resulting rules. |
| Bind PostgreSQL to a loopback-only host port | Lets the host driver use the existing TCP authentication contract and avoids a shared filesystem. It adds a DB listener reachable by VM-local processes. | Prove the bind remains loopback-only under the canonical rootless network runtime, including after reboot. Test against API and other Podman namespaces as well as the VM. |
| Launch the host executor in Podman's rootless network namespace | Can avoid adding a published port or shared socket. It couples the host worker to Podman namespace and DNS lifecycle, including runtime recovery. | Prove database address identity, name resolution, S3 egress, systemd interaction and host-lock behavior after Podman or VM restart. |
| Run the Node executor on the internal container network | Uses the image's installed runtime and direct PostgreSQL connectivity. Its approved work still requires the host runner, systemd and inherited host lock. | This would require an additional host invocation mechanism or broader Podman privileges. The current contract provides neither. |

Compare a private authenticated Unix socket first on a disposable rootless host.
Use the existing Node `pg` driver for the socket connection, the existing TCP route for the API container, and an Ansible-owned directory exposed only to PostgreSQL and the host runtime.
Have PostgreSQL apply effective SCRAM authentication to reachable local sessions and reject logins outside the approved boundary. Because PostgreSQL uses the same local HBA rules for every socket, test existing in-container admin commands with their protected credentials and verify that sharing a socket exposes no local `trust` rule.
Choose a topology only after the fixture proves the effective UID mapping, socket access, login permissions and restart behavior. If the socket cannot meet those conditions, evaluate the loopback-only alternative under the same permission tests. [PostgreSQL socket settings](https://www.postgresql.org/docs/17/runtime-config-connection.html) · [PostgreSQL HBA rules](https://www.postgresql.org/docs/17/auth-pg-hba-conf.html) · [PostgreSQL password authentication](https://www.postgresql.org/docs/17/auth-password.html) · [Podman rootless network namespace](https://docs.podman.io/en/latest/markdown/podman-unshare.1.html)

## Provisioning with the existing deployment authority

| Responsibility | Proposed authority and access |
| --- | --- |
| Install or adopt the runtime | Existing protected Ansible uses the certified Full image digest as the source of the executor and Node dependencies. It installs a verified private host release and atomically selects the active version. The deployment operator enables the existing launcher as a systemd user service; R8 invokes its fixed deploy operation under the same host lock. |
| Own the operational schema and logins | The existing database administrator applies the reviewed schema or its approved upgrade and keeps ownership and DDL. The two dedicated login roles receive only `codexia_backup_api` and `codexia_backup_executor`, respectively. The ordinary app and Auth logins retain their own grants. |
| Accept Console requests | The API container receives the API DSN, the sealing public key and the read-only operator policy. OWNER can use the approved backup actions. |
| Execute accepted work | The existing VM-local runtime receives the executor DSN, sealing private key, approved provider credentials, protected paths and read-only policy. Both its long-lived service and the protected R8 command run as the existing rootless service identity with the same journal and lock. The API container gets no host socket, VM state directory, private-key mount, or host process control. |
| Recover keys and records | The recovery operator keeps the necessary sealing keys and runtime secrets in independent protected custody. Backup age decryption keys and recovery-provider read access stay with the recovery operator, outside the writer runtime. |

[Operator settings](../../deploy/backup/CONSOLE.md) · [Role grants](../../deploy/backup/operational-schema.sql) · [Role verification](../../deploy/backup/verify-console-roles.sql) · [Full image build](../../Dockerfile.backend)

For a new VM, existing Ansible may prepare the local role, schema and runtime with backup jobs disabled. R4–R6 admission must work with no provider setup, age recipient or independent restore receipt. The deployment operator enables the runtime through the existing protected VM controls once local configuration is verified. After ACTIVE the owner selects the destination in Console, and the recovery operator verifies restore before routine production acceptance and R8 writer changes.
For an existing ACTIVE installation, the proposal uses existing protected maintenance to add the runtime with the same image, ledger and owner. A needed API restart uses the existing host lock. Adopt the existing keys, roles, settings and queue records in place. Provisioning reruns preserve them or stop on an unexplained mismatch.
[Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md) · [Update flow](UPDATE-FLOW.md)

systemd supervises the one service. The existing executor remains the owner of approved schedule windows and operation claims in PostgreSQL. For R8, the protected deployment command asks that same runtime to use the admitted Console revision and verifies the off-VM result.
Once shared provisioning and R8 admission are accepted, retire the duplicate manual install and Actions-supplied backup settings for that path. Keep the existing producer, independent evidence and restore access for retained v2 backups.

## Restore before the executor resumes

The current v2 dump includes the operational schema when it exists. Because the producer takes the snapshot before publishing the remote receipt, the selected snapshot may contain its own RUNNING row without that receipt. The durable in-flight index prevents a new run while such a row is unresolved. The VM-local transaction records that would ordinarily guide reconciliation may have been lost with the VM. Remote preservation and successful restore are evidenced separately. [Backup producer](../../deploy/backup/backup.sh) · [Operational schema](../../deploy/backup/operational-schema.sql) · [Executor startup](../../packages/api/src/backup-console-executor.ts) · [Console control](../../packages/api/src/backup-console-control.ts)

Keep the target executor stopped throughout independent restore and database verification. Before production restart, the deployment operator confirms that the original executor is stopped or fenced from the destination, including in a source-VM return. The recovery operator provides the selected backup identity and independently held transfer receipt for reconciliation. Use the protected operation under the existing host lock and the current PostgreSQL run journal.

| Restored state | Proposed disposition |
| --- | --- |
| Run represented by the selected v2 backup and matching independent receipt | Validate the original run ID, source and manifest digest before recording the verified transfer. Record independent restore through its separate proof. If the snapshot predates a manifest value, accept it only from the verified artifact and receipt bound to that same run. |
| Other in-flight runs with no verified terminal result | Preserve the row as `UNKNOWN` with the recovery reason and observed evidence. Require the operator to resolve any ambiguous external effect before enabling the worker. |
| Queued runs and expired schedule slots | Block automatic replay. Retain request and slot identities; require a new approved request or the next eligible scheduled slot. |
| Queued or in-flight probe, activate or disable | Block replay. Require a fresh Console request against the verified settings; unresolved external impact must be investigated before restarting the executor. |

The operator records each disposition with the existing run or operation ID and the digest of its evidence under the same protected mutation authority. For a required destination, revalidate the current policy, revision, key and provider access before enabling jobs. Missing or conflicting evidence keeps the target worker stopped. The same restored row cannot authorize a second producer or upload. Recovery handoff approval uses independently verified material under the lifecycle contract.
[Backup and recovery](BACKUP.md) · [Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md)

## Acceptance before selecting a topology

- A fresh install reaches ACTIVE and the owner can reach its normal Console before any provider credential, public age recipient or independent restore evidence is available. The operator provisions the backup runtime on a disposable new VM and an existing ACTIVE VM. Reapply provisioning and compare data, roles, keys and all pre-existing activity.
- Verify the PostgreSQL endpoint from the selected worker boundary using the actual Node driver and dedicated DSN. Deny unauthenticated local connections, unauthorized local UIDs, API-container access to the host socket and executor credentials, and connections from other hosts. Verify least-privilege grants, every existing administrative socket client, private key isolation, runtime provenance, restart and reboot.
- Configure and activate a destination in the Console. Exercise manual execution and compatible update on the same VM runtime and lock. Verify off-VM readback, absent configuration and required-provider failure, and interrupted backup and rollout recovery.
- Restore the selected backup on a separate disposable host with an independently obtained receipt and necessary secrets. Include a captured RUNNING deployment backup, a mismatched transfer receipt, a queued configuration operation, an expired scheduled slot and an attempt to resume the target while the old worker can still write. Prove the journal disposition with a restored PostgreSQL database, verify API readiness and confirm that a newly approved run completes through the same Console.
- Record synthetic exact-source CI evidence separately from actual provider, VM and independent recovery acceptance.
