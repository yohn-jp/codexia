# Encrypted push-deployment backups

The only backup executable is [`deploy/backup/backup.sh`](../../deploy/backup/backup.sh). It belongs to the GitHub Actions → Tailscale → SSH → Ansible → rootless Podman Quadlet push deployment. No pull updater, timer, signed-channel controller, compatibility handler or legacy proxy controls this backup.

The Ansible `deploy` stage creates or validates a private backup directory (default `/home/codexia/backups`). A local directory or an independently mounted remote filesystem is supported; remote NFS/CIFS/SSHFS destinations undergo additional host-identity validation. If the installed API image changes, deployment is serialized under `~/.local/state/codexia-deploy/host.lock`, the API and Tunnel are stopped, and the helper's `backup-locked` command is invoked with an explicitly inherited lock descriptor. Backup must confirm the API writer is quiesced, encrypt the PostgreSQL logical dump, history volume and manifest with `age`, publish ciphertext checksums atomically at the selected destination, and verify fingerprints before proceeding. A backup failure fails closed before candidate activation. **A local backup does not survive loss of the VM or its disk; independently preserve ciphertext off-VM before treating it as disaster-recovery evidence.**

An independent `restore-drill` stage decrypts a **v2** artifact on an isolated recovery host, imports it into disposable PostgreSQL/history resources, checks the logical database and history fingerprints, and removes the temporary resources. It never restores production data or writes credentials to the repository. Versions preceding v2 and the retired updater's rollback receipts are deliberately unsupported.

Use an approved protected Ansible inventory and independently supplied recipient/recovery identity. Only the holder of the external backup encryption private key can perform the restore drill.

The deployment backup is a pre-rollout recovery point for the database and history resources; it does not roll back a schema migration, PostgreSQL role, or Podman secret. Current push deployment admission rejects migration-fingerprint, API-epoch, and persistence-format changes. Those changes remain unsupported until an independently reviewed operation defines its approval, encrypted pre-change backup, migration verification, and tested restore procedure. The isolated restore drill does not satisfy that migration procedure by itself.

[Push deployment procedure](PUSH-DEPLOYMENT.md)
