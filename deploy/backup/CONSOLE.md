# Backup console control plane

BKC-001 through BKC-007 are enabled by an operator on a single-owner installation. The Fastify routes and the executor share the `codexia_backup` operational schema on PostgreSQL. The executor has no HTTP listener.

## Provisioning

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
  ]
}
```

Set `CODEXIA_BACKUP_POLICY_FILE` on both services. Set `CODEXIA_BACKUP_API_DATABASE_URL` and `CODEXIA_BACKUP_PUBLIC_KEY_FILE` on the API. The latter is a PEM SPKI public key (RSA, at least 2048 bits). Set `CODEXIA_BACKUP_EXECUTOR_DATABASE_URL` and `CODEXIA_BACKUP_EXECUTOR_CONFIG_FILE` on the separately isolated executor service. Its JSON configuration contains `privateKeyFiles`, an array of absolute PEM private key paths. Protect the config and private keys with mode 0400 or 0600 and the executor's UID. The private files and executor DSN belong exclusively to the executor identity.

For `operator-role`, the protected executor configuration can instead supply a preprovisioned `operatorCredential` with `origin`, `accessKeyId`, `secretAccessKey` and optional `sessionToken`. Restrict the underlying service identity to the approved bucket and prefix. An optional `transportByOrigin` object keys transport settings by exact destination origin. Entries can supply an operator-provided `caBundle` path and explicit `allowedPrivateAddresses` for approved private IPv4 endpoints. Loopback and metadata destinations are rejected. Keep `allowProbeCleanup` disabled unless the provisioned identity is allowed to clean up only the dedicated `.codexia-probes/` keyspace.

Install the [pinned S3 runtime](install-s3-runtime.sh) for the executor. Set `CODEXIA_BACKUP_PYTHON` to its absolute interpreter path and `CODEXIA_BACKUP_PROBE_SCRIPT` to the trusted absolute path of [s3_probe.py](s3_probe.py). Start `node packages/api/dist/backup-console-executor.js` using the isolated executor identity after building the API package. The process consumes only configuration operations.

For a key rotation, load the new private key alongside the old one, switch the API to the new public key, and submit a fresh draft credential. Probe and activate the new revision before removing the old worker key. Removing a key makes revisions sealed to it unavailable to the executor. Revoke upstream credentials through the provider's existing operator process.

## API requests

All mutations require the exact browser Origin and `X-Codexia-CSRF: 1`. Draft writes, activate and disable also require a recent Better Auth owner session. GET config returns the current draft ETag. Draft writes use that value as `If-Match`.

Send an `Idempotency-Key` for each POST and reuse it after an ambiguous response. Probe takes `revision`. Activate takes `revision`, `probeId` and `confirmed: true`. Disable takes the active `revision` and `confirmed: true`. Probe results are available at `GET /api/console/backups/config/probes/:id`. Configuration operation results are available at `GET /api/console/backups/status?requestId=<Idempotency-Key>`.

The executor revalidates the draft and S3 connection for activation and atomically records the applied revision and operation receipt. An existing required destination cannot be disabled or replaced with a secondary destination while alternate protection evidence is unavailable. Probe results and applied configuration do not establish that an off-VM backup or independent restore has succeeded.
