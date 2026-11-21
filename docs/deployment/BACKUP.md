# Encrypted push-deployment backups

The only backup executable is [`deploy/backup/backup.sh`](../../deploy/backup/backup.sh). It belongs to the GitHub Actions → Tailscale → SSH → Ansible → rootless Podman Quadlet push deployment. No pull updater, timer, signed-channel controller, compatibility handler or legacy proxy controls this backup.

The Ansible `deploy` stage first validates an off-VM backup mount. If the installed API image changes, it serializes the deployment under `~/.local/state/codexia-deploy/host.lock`, stops the API and Tunnel, and invokes the helper's `backup-locked` command with an explicitly inherited lock descriptor. Backup must confirm the API writer is quiesced, encrypt the PostgreSQL logical dump, history volume and manifest with `age`, publish ciphertext checksums atomically on the remote mount, and verify fingerprints before proceeding. A backup failure fails closed before candidate activation.

An independent `restore-drill` stage decrypts a **v2** artifact on an isolated recovery host, imports it into disposable PostgreSQL/history resources, checks the logical database and history fingerprints, and removes the temporary resources. It never restores production data or writes credentials to the repository. Versions preceding v2 and the retired updater's rollback receipts are deliberately unsupported.

Use an approved protected Ansible inventory and independently supplied recipient/recovery identity. Only the holder of the external backup encryption private key can perform the restore drill.

[Push deployment procedure](PUSH-DEPLOYMENT.md)
