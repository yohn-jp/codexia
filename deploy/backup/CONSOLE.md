# Backup console control plane

BKC-001 through BKC-010 are enabled by an operator on a single-owner installation. The Fastify routes and executor share the `codexia_backup` operational schema on PostgreSQL. The executor has no HTTP listener. Ansible applies the [journal upgrade](operational-schema-667-upgrade.sql) to recognized earlier schemas and preserves existing settings.

## Provisioning

After an installation reaches ACTIVE, run the existing protected Ansible `base` stage with `codexia_base_approved: true` and `codexia_backup_runtime_approved: true`. Use the same reviewed checkout, inventory and management identity as [base convergence](../ansible/BASE-RUNTIME.md). Supply the recovery operator’s **public** age recipient as `codexia_backup_age_recipient` and the allowed destinations and maintenance windows as `codexia_backup_policy`. The owner supplies the actual destination and write-only credential in the Console.

The stage reads the deployed release record, checks the healthy Full image and extracts its Node runtime and executor. It sets up the private PostgreSQL socket and dedicated SCRAM logins, applies the operational schema or its journal upgrade, generates the local sealing key once and attaches only the API credential, public key and policy to the existing API. It starts the user service under the shared deployment lock and checks its database heartbeat. Reapplying the stage adopts matching settings. A mismatch in existing credentials, policy or release identity requires protected maintenance. Keep the original keys and journal when adopting an existing installation.

For example, the following policy permits one destination and one manual maintenance window.

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

The owner can confirm a manual run in an open operator-approved window. Scheduling remains disabled in the supported Console contract. A maintenance window alone never authorizes a scheduled writer stop.

The default staging and receipt directories are under `~/.local/share/codexia-backup`. Set `codexia_backup_receipt_directory` to a protected mounted directory when independent receipt storage is available. Preserve verified receipts independently from both the VM and the destination objects. The recovery operator keeps the age private key and recovery reader credentials outside the VM. A pre-existing staging mount may be selected with `codexia_backup_staging_directory`. If approved as independent secondary protection, set `codexia_backup_secondary_independent_mount` to the same mount. The producer validates the actual filesystem and remote host when that protection is used.

The executor uses `~/.config/codexia-backup/executor.json`. The default names the VM-local private sealing key. For an operator role or private endpoint, maintain the protected `operatorCredential` and `transportByOrigin` there. The API has no mount for this file or its keys. The executor’s private PostgreSQL connection is in `database.env`. The worker and R8 use the same local `executor.env` for staging, age, transfer and receipt settings.

After an isolated `restore-drill.yml` succeeds, an operator may import its protected receipt with `codexia-backup-control record-restore <runId> <receiptFile>`. The command requires a private regular receipt whose manifest SHA-256 matches the verified source run. To include API readiness, supply the protected candidate image, ledger, settings and introspection secret inputs to the drill. Import validates the verified image digest against the source run. BKC-010 reports partial evidence and the missing readiness check when the receipt proves only PostgreSQL and history recovery.

For a restored database, keep the target executor stopped and disabled. Confirm the source executor fence through the protected recovery process. Under the existing protected operator authority, run `codexia-backup-control reconcile-restored-journal <receiptFile> <approvedTransferReceiptSha256> <executorFenceSha256>` with the private independently preserved transfer receipt. The launcher acquires the shared host lock. The command binds the selected run to the receipt and blocks replay of the restored requests.

For each remaining `UNKNOWN` run, import its matching verified transfer receipt with the same fence or record the independently confirmed absence of a verified transfer. After checking the provider and independent records, use `codexia-backup-control reconcile-restored-absence <evidenceFile> <approvedEvidenceSha256>`. The protected JSON record contains `format: "codexia-backup-run-disposition/v1"`, the run UUID as `backupId`, `executorFenceSha256` and `conclusion: "no_verified_transfer"`. The existing journal retains the protected record digest. Leave a run `UNKNOWN` while its outcome is uncertain. Revalidate the policy, active revision, keys and provider access before enabling the worker. Record the isolated restore using the separate restore receipt.

For a key rotation, load the new private key alongside the old one, switch the API to the new public key, and submit a fresh draft credential. Probe and activate the new revision before removing the old worker key. Removing a key makes revisions sealed to it unavailable to the executor. Revoke upstream credentials through the provider's existing operator process.

## API requests

All mutations require the exact browser Origin and `X-Codexia-CSRF: 1`. Draft writes, activate and disable also require a recent Better Auth owner session. GET config returns the current draft ETag. Draft writes use that value as `If-Match`.

Send an `Idempotency-Key` for each POST and reuse it after an ambiguous response. Probe takes `revision`. Activate takes `revision`, `probeId` and `confirmed: true`. Disable takes the active `revision` and `confirmed: true`. Probe results are available at `GET /api/console/backups/config/probes/:id`. Configuration operation results are available at `GET /api/console/backups/status?requestId=<Idempotency-Key>`.

For a day-based retention request, activation requires an observed bucket Object Lock default retention at least that long. A requested generation count stays in the draft pending independent evidence of retained backup generations. The executor revalidates the draft and S3 connection for activation and atomically records the applied revision and operation receipt. An existing required destination cannot be disabled or replaced with a secondary destination while alternate protection evidence is unavailable. Probe results and applied configuration do not establish that an off-VM backup or independent restore has succeeded.
