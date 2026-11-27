# Backup console control plane

BKC-001 through BKC-010 are enabled by an operator on a single-owner installation. The Fastify routes and executor share the `codexia_backup` operational schema on PostgreSQL. The executor has no HTTP listener. Existing #897 installations apply [operational-schema-667-upgrade.sql](operational-schema-667-upgrade.sql) as the database administrator; it adds the durable run journal without resetting backup settings.

## Provisioning

Target operation after conformance: use existing Ansible and certified deployment artifacts to provision the backup runtime and operational schema/roles idempotently, not a second manual bootstrap bundle. The owner enters S3 settings and write credentials only in the ordinary Console. The VM-local protected settings below are not GitHub Actions Environment inputs. Fresh activation must not depend on any backup configuration or recovery proof. The recovery operator keeps necessary secrets independently and validates recovery after Console configuration. Until implementation conforms, this provisioning section describes existing component interfaces, not additional required manual steps for R4–R6.

Apply [operational-schema.sql](operational-schema.sql) once to the selected database as its migration administrator with `psql -v ON_ERROR_STOP=1`. Provision two separate login roles through the installation's protected database credential workflow. Grant the API login only `codexia_backup_api` and the executor login only `codexia_backup_executor`. Verify the two logins with [verify-console-roles.sql](verify-console-roles.sql), supplying the psql variables `backup_api_login` and `backup_executor_login`. The ordinary API database, Auth and manuscript roles do not receive either grant.

Supply both processes a read-only operator-owned JSON policy file. Each entry binds the endpoint, region, bucket, prefix boundary and permitted credential mode. An AWS entry omits `endpoint` and uses the regional AWS endpoint. Compatible entries require exact canonical HTTPS origins. For example:

```json
{
  "destinations": [
    {
      "provider": "s3-compatible",
      "endpoint": "https://objects.example.org",
      "region": "us-east-1",
      "bucket": "codexia-backups",
      "prefix": "instance-a/backup",
      "credentialModes": ["sealed-access-key"]
    }
  ],
  "maintenanceWindows": [
    { "id": "weekly-sunday-0200", "timeZone": "Asia/Tokyo", "daysOfWeek": [0], "start": "02:00", "durationMinutes": 60 }
  ]
}
```

An owner manual run can be requested only during the selected currently-open operator-approved window and requires explicit confirmation. Scheduled runs remain disabled by default. To opt in, set `scheduleWindowId` in the protected policy to one of `maintenanceWindows`; there is no public schedule mutation or timer. The executor records one durable slot per local window date and never replays a missed/expired slot. Manual and scheduled work use the same protected host runner and lock.

After an isolated `restore-drill.yml` succeeds, an operator may import its protected receipt with `codexia-backup-control record-restore <runId> <receiptFile>`. The command requires a private regular receipt whose manifest SHA-256 matches the verified source run. To include API readiness, supply the protected candidate image, ledger, settings and introspection secret inputs to the drill. Import validates the verified image digest against the source run. BKC-010 reports partial evidence and the missing readiness check when the receipt proves only PostgreSQL and history recovery.

Set `CODEXIA_BACKUP_POLICY_FILE` on both services. Set `CODEXIA_BACKUP_API_DATABASE_URL` and `CODEXIA_BACKUP_PUBLIC_KEY_FILE` on the API. The latter is a PEM SPKI public key (RSA, at least 2048 bits). Set `CODEXIA_BACKUP_EXECUTOR_DATABASE_URL` and `CODEXIA_BACKUP_EXECUTOR_CONFIG_FILE` on the separately isolated executor service. Its JSON configuration contains `privateKeyFiles`, an array of absolute PEM private key paths. Protect the config and private keys with mode 0400 or 0600 and the executor's UID. The private files and executor DSN belong exclusively to the executor identity.

For `operator-role`, the protected executor configuration can instead supply a preprovisioned `operatorCredential` with `origin`, `accessKeyId`, `secretAccessKey` and optional `sessionToken`. Restrict the underlying service identity to the approved bucket and prefix. An optional `transportByOrigin` object keys transport settings by exact destination origin. Entries can supply an operator-provided `caBundle` path and explicit `allowedPrivateAddresses` for approved private IPv4 endpoints. Loopback and metadata destinations are rejected. Keep `allowProbeCleanup` disabled unless the provisioned identity is allowed to clean up only the dedicated `.codexia-probes/` keyspace.

Install the [pinned S3 runtime](install-s3-runtime.sh). In the rootless host's private `/home/codexia/.config/codexia-backup/executor.env` (mode 0600), set `CODEXIA_BACKUP_PYTHON` to its absolute interpreter and set `CODEXIA_BACKUP_PROBE_SCRIPT` and `CODEXIA_BACKUP_TRANSFER_SCRIPT` to the trusted absolute paths of `s3_probe.py` and `s3_transfer.py`. Set an absolute `CODEXIA_BACKUP_RECEIPT_DIRECTORY` owned by the executor with mode 0700. Preserve its receipts separately from the S3 objects.

Set `CODEXIA_BACKUP_EXECUTOR_ENTRYPOINT` to the absolute `backup-console-control.js` path. Set `CODEXIA_BACKUP_RUNNER` to `/home/codexia/.local/bin/codexia-backup-runner`, `CODEXIA_BACKUP_DESTINATION` to the protected staging directory and `CODEXIA_BACKUP_AGE_RECIPIENT` to the public age recipient. For a secondary S3 destination, `CODEXIA_BACKUP_SECONDARY_INDEPENDENT_MOUNT` may name an operator-approved independent filesystem mounted at that staging directory.

The deployment helpers install `codexia-backup-executor.service` for the rootless service identity. After ACTIVE and approved VM-local provisioning, use the user systemd manager to enable and start the unit. It launches the existing executor. Under the shared host lock, Ansible uses the same launcher and staging settings, pins the active Console revision and invokes the same backup runner before a compatible Backend update. Missing runtime or active configuration stops the update before the writer is stopped.

For a restored database, keep the target executor stopped and disabled. Confirm the source executor fence through the protected recovery process. Under the existing protected operator authority, run `codexia-backup-control reconcile-restored-journal <receiptFile> <approvedTransferReceiptSha256> <executorFenceSha256>` with the private independently preserved transfer receipt. The launcher acquires the shared host lock. The command binds the selected run to the receipt and blocks replay of the restored requests. Resolve any remaining `UNKNOWN` runs in the existing journal, then revalidate the policy, active revision, keys and provider access before enabling the worker. Record the isolated restore using the separate restore receipt.

For a key rotation, load the new private key alongside the old one, switch the API to the new public key, and submit a fresh draft credential. Probe and activate the new revision before removing the old worker key. Removing a key makes revisions sealed to it unavailable to the executor. Revoke upstream credentials through the provider's existing operator process.

## API requests

All mutations require the exact browser Origin and `X-Codexia-CSRF: 1`. Draft writes, activate and disable also require a recent Better Auth owner session. GET config returns the current draft ETag. Draft writes use that value as `If-Match`.

Send an `Idempotency-Key` for each POST and reuse it after an ambiguous response. Probe takes `revision`. Activate takes `revision`, `probeId` and `confirmed: true`. Disable takes the active `revision` and `confirmed: true`. Probe results are available at `GET /api/console/backups/config/probes/:id`. Configuration operation results are available at `GET /api/console/backups/status?requestId=<Idempotency-Key>`.

For a day-based retention request, activation requires an observed bucket Object Lock default retention at least that long. A requested generation count stays in the draft pending independent evidence of retained backup generations. The executor revalidates the draft and S3 connection for activation and atomically records the applied revision and operation receipt. An existing required destination cannot be disabled or replaced with a secondary destination while alternate protection evidence is unavailable. Probe results and applied configuration do not establish that an off-VM backup or independent restore has succeeded.
