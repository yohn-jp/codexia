# Encrypted push-deployment backups

The only backup executable is [`deploy/backup/backup.sh`](../../deploy/backup/backup.sh). It belongs to the GitHub Actions → Tailscale → SSH → Ansible → rootless Podman Quadlet push deployment. No pull updater, timer, signed-channel controller, compatibility handler or legacy proxy controls this backup.

The Ansible `deploy` stage creates or validates a private backup directory (default `/home/codexia/backups`). A local directory or an independently mounted remote filesystem is supported; remote NFS/CIFS/SSHFS destinations undergo additional host-identity validation. If the installed API image changes, deployment is serialized under `~/.local/state/codexia-deploy/host.lock`, the API and Tunnel are stopped, and the helper's `backup-locked` command is invoked with an explicitly inherited lock descriptor. Backup must confirm the API writer is quiesced, encrypt the PostgreSQL logical dump, history volume and manifest with `age`, publish ciphertext checksums atomically at the selected destination, and verify fingerprints before proceeding. A backup failure fails closed before candidate activation. **A local backup does not survive loss of the VM or its disk; independently preserve ciphertext off-VM before treating it as disaster-recovery evidence.**

An independent `restore-drill` stage decrypts a **v2** artifact on an isolated recovery host, imports it into disposable PostgreSQL/history resources, checks the logical database and history fingerprints, and removes the temporary resources. It never restores production data or writes credentials to the repository. Versions preceding v2 and the retired updater's rollback receipts are deliberately unsupported.

Use an approved protected Ansible inventory and independently supplied recipient/recovery identity. Only the holder of the external backup encryption private key can perform the restore drill.

The deployment backup is a pre-rollout recovery point for the database and history resources. PostgreSQL roles and Podman secrets require separate recovery. Current push deployment admission rejects migration-fingerprint, API-epoch, and persistence-format changes. These changes require a separately reviewed operation with its own approval, encrypted pre-change backup, migration verification, and tested restore procedure.

## Rehearse a reviewed Full candidate

Load the locally reviewed, publication-certified Full backend image by its immutable `ghcr.io/yohn-jp/codexia-backend@sha256:<digest>` reference on the isolated recovery host. Set `codexia_restore_candidate_full_image` to that reference in the approved `restore-drill` inputs. The standalone equivalent on that host is:

```sh
bash deploy/backup/backup.sh drill "$backup_directory" "$recovery_identity_file" --approved \
  --candidate-full-image "$certified_full_image"
```

After the restored PostgreSQL and history fingerprints match the backup, the candidate runs its packaged maintenance `--check`, `--apply`, and `--check` against the scratch database. It uses a dedicated read-only role for checks and a separate writer for apply. The image uses only the scratch database's loopback network namespace. Preserve the successful drill output with the exact digest and checksum-manifest SHA-256. The regular backup receipt still records the restored ciphertext identity. Paired activation and production recovery require their own approved procedure.

[Push deployment procedure](PUSH-DEPLOYMENT.md)
