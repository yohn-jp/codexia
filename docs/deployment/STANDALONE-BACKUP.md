# Standalone backup and isolated restore drill

The backup controller command holds the same host-wide `flock` as updater operations. It is available for both a pre-journal legacy writer and a stable initialized controller. The Ansible task includes in `deploy/ansible/backup.yml` and `restore-drill.yml` provide explicit approvals and protected input checks; Phase C must connect these includes to the existing `site.yml` stage dispatch before Ansible exposes them as operator stages.

The age recipient and off-VM destination are external inputs. Supply them through a protected inventory or Vault and keep Ansible `no_log` enabled. Provision the recipient and recovery identity independently; this workflow never creates or rotates production backup credentials. Keep the private recovery key on an isolated recovery host, never on the source VM or alongside the artifact. The remote destination must be independently protected against deletion and have a retention policy.

## Encrypted backup

Run the rootless `codexia-updater` wrapper with one of these forms:

```sh
codexia-updater backup /absolute/config.json /absolute/remote/mount age1-public-recipient --approved
codexia-updater backup /absolute/config.json /absolute/signed-legacy-release.json /absolute/remote/mount age1-public-recipient --approved
```

The first form requires a valid stable controller journal, one verified serving slot writer, the route targeting that writer, and no preflight containers. The second form requires no controller journal, an exact legacy release record published in the signed channel, a matching running legacy image/version/browser-auth identity, a blocked controller-owned route marker, and zero slot or preflight writers.

The controller records the prior paused and updater-timer state, blocks admission through its existing route adapter, stops only the active writer and (for legacy) the Tunnel connector when it was active, then invokes the existing encrypted backup code while retaining the lock. The backup helper checks that the caller already holds this exact lock and does not take a nested lock. The controller resumes the original writer, verifies its serving identity, restores the prior Tunnel/timer state, and preserves the journal and paused state. It never writes a Cloudflare route or changes DB schema or credentials. A failure that cannot be recovered leaves admission blocked and retains evidence; it does not create a controller journal.

The destination must be an existing absolute NFS, CIFS or SSHFS mount. The database custom-format dump and history-volume archive stream directly into age ciphertext. The encrypted manifest stores logical fingerprints of public PostgreSQL table rows and history file names/content; the artifact directory records checksums. A partial directory is published only after all ciphertext and checksums have been synchronized. The backup database image pin matches the deployed PostgreSQL 17 Quadlet pin.

## Isolated restore drill

Run the drill on an isolated recovery host with Podman and the external recovery identity:

```sh
bash deploy/updater/standalone-backup.sh drill \
  /absolute/remote/backup/directory /absolute/private/age-identity --approved
```

The directory must resolve to an approved remote filesystem. The recovery identity must be a regular non-symlink file owned by the recovery user with mode `0400` or `0600`. The script verifies fixed ciphertext checksums and decrypts the manifest before creating scratch resources. It restores into uniquely named, labeled PostgreSQL and history volumes with no network and no published ports, then compares the restored logical fingerprints. Cleanup removes only resources with the exact generated drill label; it cannot select or restore into production volume names. The Ansible restore-drill include delegates to the local recovery host and checks the private-key path and mode without reading the key contents.

The drill does not restore production role passwords, grants, Cloudflare credentials, systemd configuration or browser-local drafts. The database fingerprint covers row values, not physical WAL, sequence state, ACLs or server settings; the history fingerprint covers regular file names and contents, not filesystem metadata. A complete recovery acceptance still requires testing a recovered API, login, document revision, Knowledge, Evidence and approval workflows and recording measured RPO/RTO.

## Verification status

The disposable CI test uses real rootless Podman, the pinned PostgreSQL image, age encryption and an isolated PostgreSQL/history restore. A narrow `findmnt` fixture labels its local temporary directory as remote solely to exercise destination gating. It verifies route/writer/lock rejection, encrypted artifact integrity, recovery-key permissions, restore failure cleanup and successful fingerprint comparison.

Actual off-VM NFS/CIFS/SSHFS backup, external recipient custody, use of the real recovery key, target-host writer/Tunnel resumption and real recovered API workflows are **NOT_CHECKED** without authorized external destination and recovery access. The disposable CI proof is not production backup or disaster-recovery evidence.
