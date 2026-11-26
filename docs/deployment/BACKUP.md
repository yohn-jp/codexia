# Encrypted push-deployment backups

The [Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md) owns when backup, independent recovery evidence and restore are required for route admission and coordinated activation. Backup is a prerequisite in the [compatible update state machine](UPDATE-FLOW.md), and recovery acceptance is required by the [initial deployment state machine](INITIAL-DEPLOYMENT-FLOW.md). A verified ciphertext file alone is not proof of independent-host recoverability.

[`deploy/backup/backup.sh`](../../deploy/backup/backup.sh) is the canonical producer. The protected Ansible push transaction and the operator-provisioned backup executor invoke it under the same host lock. The executor can request backups in operator-approved maintenance windows.

The Ansible `deploy` stage creates or validates a private backup directory (default `/home/codexia/backups`). A local directory or an independently mounted remote filesystem is supported; remote NFS/CIFS/SSHFS destinations undergo additional host-identity validation. If the installed API image changes, deployment is serialized under `~/.local/state/codexia-deploy/host.lock`, the API and Tunnel are stopped, and the helper's `backup-locked` command is invoked with an explicitly inherited lock descriptor. Backup must confirm the API writer is quiesced, encrypt the PostgreSQL logical dump, history volume and manifest with `age`, publish ciphertext checksums atomically at the selected destination, and verify fingerprints before proceeding. A backup failure fails closed before candidate activation. **A local backup does not survive loss of the VM or its disk; independently preserve ciphertext off-VM before treating it as disaster-recovery evidence.**

An independent `restore-drill` stage decrypts a **v2** artifact on an isolated recovery host, imports it into disposable PostgreSQL/history resources, checks the logical database and history fingerprints, and removes the temporary resources. It never restores production data or writes credentials to the repository. Versions preceding v2 and the retired updater's rollback receipts are deliberately unsupported.

An operator can extend the isolated drill with `--candidate-full-image` and `--candidate-ledger` for the exact reviewed Full image. The `--candidate-api-ready` check also takes `--candidate-runtime-settings` and `--candidate-introspection-secret-file`, both protected recovery inputs for the restored Better Auth catalog. It verifies API readiness against the restored PostgreSQL and history during the drill.

Use an approved protected Ansible inventory and independently supplied recipient/recovery identity. Only the holder of the external backup encryption private key can perform the restore drill.

The deployment backup is a pre-rollout recovery point for the database and history resources. PostgreSQL roles and Podman secrets require separate recovery. Current push deployment admission rejects migration-fingerprint, API-epoch, and persistence-format changes. These changes require a separately reviewed operation with its own approval, encrypted pre-change backup, migration verification, and tested restore procedure.

## Accepted target: one PostgreSQL application-state recovery source

[Data model — REQ-DATA-005](../architecture/DATA-MODEL.md) owns the approved target of consolidating all recovery-required server application state into one PostgreSQL cluster. Once migrated and independently verified, application-state disaster recovery must not depend on the former host-history volume or derived caches. Infrastructure configuration, recovery keys, credentials and independently protected evidence remain separately recoverable. Author-facing [open work export](../authoring-portable.md) is data portability, not operational recovery.

The current logical DB + history + age backup and protected host lock remain the only admitted path until a separately approved replacement has passed isolated clean-VM restore, off-VM protection, key custody, integrity/authenticity, failure and deployment admission tests. Evaluate established PostgreSQL physical backup/WAL/PITR tools (e.g. pgBackRest or WAL-G) under that change; neither product nor a new encryption/retention policy is selected here. Do not retire the existing backup or its S3/restore obligations merely because a DB migration is complete.

## Verify a candidate ledger on a restored backup

Load the reviewed, publication-certified Full backend image by its immutable digest on the isolated recovery host. Use the migration fingerprint from the same certified image.

```sh
bash deploy/backup/backup.sh drill "$backup_directory" "$recovery_identity_file" --approved \
  --candidate-full-image "$certified_full_image" --candidate-ledger "$migration_fingerprint"
```

After verifying the restored database and history fingerprints, the drill checks the candidate's PostgreSQL ledger using a read-only role in the scratch database. Retain the checksum-manifest SHA-256 and the verified ledger fingerprint as recovery evidence.

## 採用済み目標: S3互換オブジェクトストレージへの暗号化バックアップ

**運用設定UIの正本:** [バックアップ管理コンソール設計](../architecture/BACKUP-CONSOLE-CONTRACT.md)。ownerは`/console/backups`からS3の保存先・credential（write-only）・要求する保持期間・検証・有効化・run状態を操作する。通常の保存先指定にSSH/Ansible編集を要求しない。一方、既存の暗号化アーティファクト生成・host lock・writer停止は`backup.sh`が所有し、実本番復元やVM/IAM変更は引き続き保護されたOPERATORの経路で行う。local stagingとage受取公開鍵はoperator-controlledでありWeb変更を禁止する。

ローカルまたは独立mount先で生成したv2 artifactは、S3 API互換ストレージへ転送できる。保護されたexecutorとAnsibleのデプロイ受入は、同じ`backup.sh`と転送アダプターを使う。クラウドベンダー、バケット名、リージョン、保持期間、RPO/RTOは配備先の運用方針で決める。

### 機能・データフロー

1. 既存の唯一のbackup producer `deploy/backup/backup.sh` が、API writerの停止とhost lockのもとで、**現行v2形式のage暗号化PostgreSQL dump・history・manifest・ciphertext checksum**を作る。S3専用の第二dump/別の暗号化形式を作らない。
2. 検証済みの暗号文一式を、保護されたS3互換bucket/prefixへ**オブジェクトとしてアップロード**する。未完了のmultipart uploadや途中オブジェクトを「利用可能な復旧点」として公開しない。全オブジェクトのサイズ・SHA-256/manifest digestとリモート取得内容を検証し、最後に**commit marker/receipt**を公開する。オブジェクト名はバックアップIDとsource identityで一意にし、既存の復旧点を上書きしない。
3. **アップロード済みオブジェクトを再取得**し、manifestとchecksumを照合してからオフVM保管成功とする。S3のETagをSHA-256や完全性の唯一の証拠として扱わない。また、SHA-256は破損検出であり**作成者の真正性を証明しない**。復元時にはバックアップIDと暗号文digestを、S3オブジェクトとは独立した保護済みの運用receipt（実行主体・時刻・対象sourceを含む）と照合し、改ざんされたS3側manifestだけを信頼しない。
4. 隔離restore hostは、明示したbackup IDとbucket/prefixから暗号文とmanifestを取得し、ローカルの一時領域で完全性を確認して、**既存の `backup.sh drill` の復号・PostgreSQL/history検証へ引き渡す**。本番DBへ直接復元しない。
5. 現行バックアップ対象外であるPostgreSQL roles、Podman secrets、age秘密鍵、S3 credentialの復旧責務は別途維持し、これらを同一bucketに平文保管しない。

### OPS-01 transfer adapter

`deploy/backup/s3_transfer.py` は既存の `backup.sh` が作成したv2 artifact一式だけを読み、`database.dump.age`、`history.tar.age`、`manifest.age`、`SHA256SUMS` をアップロードする。転送と復元ドリルは、生成時の `SHA256SUMS` と照合結果がバイト単位で一致することを要求する。第二のdumpや暗号化形式は作らない。AWS S3署名・retryはhash-locked Boto3 SDKへ委譲する。

Profileは `schemaVersion`, `provider`, `region`, `bucket`, `prefix`, `endpointUrl`, `allowedOrigins`, `addressingStyle` を含むprivate JSON fileで、所有者が実行user、mode `0400` または `0600` であることを検査する。Credentialはprofileに置かず、Boto3の標準credential provider chainから取得する。S3リクエストは環境のHTTPプロキシ設定を使用せず、選択したHTTPS endpointへ直接送信する。EndpointGuardはHTTP transportで接続ごとにDNS回答を再検証し、検証済みIPアドレスへsocketを接続する。TLS SNI、証明書検証、HTTP Hostには元のendpoint hostnameを維持する。HTTPS検証とredirect拒否を維持し、S3側のETagをSHA-256の代用にしない。

例として、operatorが保護設定したprofile、artifact directory、独立したreceipt pathから実行する。

```sh
backup_id='replace-with-backup-id'
source_identity='0123456789abcdef0123456789abcdef01234567'
artifact_dir="/protected/backups/codexia-$backup_id"
receipt_path="/protected/backup-receipts/$backup_id.json"
deploy/backup/install-s3-runtime.sh /protected/codexia-s3-runtime
/protected/codexia-s3-runtime/bin/python deploy/backup/s3_transfer.py upload \
  --profile /protected/s3-profile.json \
  --artifact-dir "$artifact_dir" \
  --backup-id "$backup_id" \
  --source-identity "$source_identity" \
  --receipt "$receipt_path"
/protected/codexia-s3-runtime/bin/python deploy/backup/s3_transfer.py download \
  --profile /protected/s3-profile.json \
  --backup-id "$backup_id" \
  --receipt "$receipt_path" \
  --output-dir /protected/restore-staging
bash deploy/backup/backup.sh drill \
  "/protected/restore-staging/codexia-$backup_id" \
  /protected/age-recovery-identity --approved
```

`upload` verifies each uploaded object's size and SHA-256 by downloading it again. It saves the expected commit marker identity in the protected local receipt directory, publishes the marker, and verifies it by readback before writing the final independent receipt. A retry using the same receipt path can verify the original marker even if the bucket capability observations have changed. `COMMIT.json` is limited to 64 KiB; downloads reject larger or mismatched declared lengths and close the response stream on success and failure. Receipt directories must be private and receipt files are created mode `0600`. Retries use conditional object creation and refuse changed ciphertext under the same backup ID. Multipart upload IDs are held in a private local journal so the helper can abort the exact unfinished upload without `ListBucketMultipartUploads`. A provider lifecycle rule should also abort incomplete uploads left by a host loss before the local upload ID is recorded. The helper operates with write and readback permissions scoped to the backup prefix.

When the profile requests retention, readback must confirm the requested Object Lock mode and a retain-until date at least as late as requested on each exact object version. This includes reused objects on retry. The adapter verifies the commit marker's retention before issuing the independent receipt.

The writer needs `s3:PutObject`, `s3:GetObject`, and `s3:AbortMultipartUpload` on the fixed object prefix, plus `s3:ListBucket` scoped by `s3:prefix` to return an unambiguous missing-object result for conditional creation. It queries bucket versioning and Object Lock configuration to report observed capabilities. The writer and recovery reader need `s3:GetObjectVersion` for versioned readback. Explicit retention additionally requires `s3:PutObjectRetention` and `s3:GetObjectRetention` for the writer on that same prefix. The adapter never calls `ListMultipartUploads`, `DeleteObject`, or `DeleteBucket`.

Run the separate synthetic-provider fixture with:

```sh
bash deploy/backup/s3-fixture.sh
```

It starts the pinned Silo S3-compatible service on loopback with a temporary CA, bucket, and restricted writer. It creates synthetic PostgreSQL 17 and history data, invokes the canonical `backup.sh` v2 producer, transfers and downloads the encrypted artifact, and runs the canonical isolated restore drill. Its local Podman command shim is backed by Docker; it does not change the production helper. Temporary credentials, identities, containers, volumes and artifacts are removed on completion. The fixture does not contact AWS or use AWS credentials.

### 接続・セキュリティ契約

| 項目 | 要件 |
| --- | --- |
| Endpoint | AWS S3およびS3 API互換サービスを対象。HTTPS必須、TLS検証を無効化しない。endpoint/region/virtual-hosted vs path-styleはprovider仕様に従う明示設定 |
| 認証 | 短命credential/ロール連携が可能なら優先。固定access keyが必要なproviderではAnsible protected secretsで供給し、repo/CI artifact/logへ出さない。公開API・owner UI・MCPにbucket credentialを渡さない |
| 権限 | 書込・参照・復元・削除の主体を分離。通常のバックアップwriterにbucket-wide deleteや管理権限を与えない。別prefix/別環境への誤配送を拒否 |
| 暗号化 | **S3転送前にageでクライアント側暗号化**。SSE-S3/SSE-KMS等は追加防御でありageの代替ではない。秘密鍵はオフVMの独立した保護・復旧手順で管理 |
| 保持・削除 | versioning、Object Lock/WORM、retention、lifecycleはproviderが対応する範囲で明示設定。未対応の場合は「保護済み」と誤表示せず、削除権限分離・独立コピー等の補完策を受入条件にする |
| リトライ | timeout、指数バックオフ、multipart cleanup、同一backup IDの冪等再実行。部分成功は `BLOCKED` として記録し、commit markerを公開しない |
| ネットワーク | VMから対象S3 endpointへの最小の送信経路。S3への書込のためにAPI/Tunnel/SSH/MCPの新たな公開入口を作らない |
| 観測 | backup ID、source SHA、schema fingerprint、ciphertext SHA-256、object key、endpoint識別子（秘密を含まない）、size、timestamp、upload/download/restore結果を監査可能にする |

### 運用ポリシーと失敗時

- **デプロイ前バックアップ**は既存のhost lock・停止・暗号化・復元可能性の契約を維持する。S3を必須の保管先に指定した環境では、S3アップロードと検証が成功するまでcandidate activationを禁止する。S3が任意の二次保管先である環境では、既存の承認済み独立バックアップが成立した場合に限りS3失敗を別の運用障害として記録できる。失敗を黙って無視しない。
- **定期的な保全**の頻度、RPO/RTO、retention、世代数は運用要件として別途承認する。新しいVM polling updaterや第二のデプロイ制御器を作らない。定期バックアップを導入する場合はwriterの整合性、実行主体、host lock、バックアップ中の可用性を別設計で承認する。
- S3 provider障害、credential失効、quota不足、TLS失敗、誤bucket、アップロード中断、object改ざん、削除/retention違反、age鍵紛失を想定する。暗号文がアップロードされた事実だけで災害復旧成功とみなさない。
- **Restore drill**は本番データを公開CIへ送らず、隔離した復旧ホスト・合成データでS3→download→decrypt→PostgreSQL/history→API readinessまで実証する。productionでの復旧には別途明示承認が必要。

### 受入シナリオ

| ID | 検証内容 |
| --- | --- |
| BACKUP-S3-001 | AWS S3と少なくとも1種類のS3互換実装で、暗号化済みv2 artifactをアップロードし、ダウンロード後のSHA-256/manifest一致 |
| BACKUP-S3-002 | multipart中断、timeout、再試行、同一backup IDでの冪等性。未完成バックアップは列挙/復旧候補に現れない |
| BACKUP-S3-003 | 間違ったendpoint/bucket/prefix、期限切れcredential、権限不足、TLS失敗を安全に拒否 |
| BACKUP-S3-004 | Object Lock/retentionの有効性と未対応providerでの代替保護の区別 |
| BACKUP-S3-005 | 隔離restore hostでS3取得→独立保護したreceiptで送信元/digest照合→既存drill→DB/history/schema fingerprint→API起動の実証 |
| BACKUP-S3-006 | 必須S3保管先の障害時はデプロイ停止。任意保管先の場合も監査可能な失敗を記録 |
| BACKUP-S3-007 | bucket credential、age秘密鍵、原稿平文がログ・CI artifact・公開Pagesへ出ない |

本番のDR受入には、実際の保管先での転送・読み戻しと、独立したホストでの復元ドリルの証拠が必要になる。S3互換fixtureで確認できる範囲は、使用した互換実装とその隔離復元環境に限られる。[External interfaces](../architecture/EXTERNAL-INTERFACES.md)（`EXT-OPS-003`）と [Requirements](../requirements/REQUIREMENT-REGISTER.md)（`REQ-OPS-003`）を参照。

## Initial recovery before activation

Provision both recovery paths before starting a fresh install. The owner first reaches the normal backup console after activation. The operator controls the initial destinations and identities through protected Environments.

| Material | Writer and recovery reader | Admission proof |
| --- | --- | --- |
| Rootless Podman secrets including the PostgreSQL role credentials | On R4 the VM encrypts the exact installed values to the public age recipient. Bootstrap puts the envelope in S3 and reads it back. A fresh runner in `codexia-bootstrap-recovery` reads and decrypts the envelope and validates its actual contents. | The recovery principal records proof for the host, recipient and credential generation. R5 and the initial data capture verify the current generation and corresponding S3 ciphertext. |
| Enrolled DB and history | After R5 preparation, the runtime operator captures the stopped source with the existing `backup.sh backup-locked` producer. The pinned S3 adapter uploads and reads back its v2 artifact. A fresh recovery runner downloads the artifact and runs `backup.sh drill` against isolated PostgreSQL and history volumes. | Only the successful drill publishes the redacted source-bound receipt. R6 authenticates the producing workflow, run and successful attempt on the reviewed main and verifies the host, DB, secret identities and both restored content fingerprints before publication. |

Use a dedicated escrow prefix and the standard S3 transfer profile JSON for `CODEXIA_BOOTSTRAP_ESCROW_PROFILE` (Variable). Set `CODEXIA_BOOTSTRAP_ESCROW_RECIPIENT` to the verified recovery public key. Supply `CODEXIA_BOOTSTRAP_ESCROW_CREDENTIAL` as a Secret containing `accessKeyId`, `secretAccessKey` and optional `sessionToken`. Grant the bootstrap principal conditional upload and read access to `envelopes/` and only read access to `verified/`. The runtime observer reads both prefixes. Grant the independent recovery principal read access to envelopes and conditional write/read access to the proof prefix. Include versioned reads for a versioned bucket. When the profile requests Object Lock, scope the required retention permissions to each principal’s authorized keys. The recovery Environment alone receives the Secret `CODEXIA_BOOTSTRAP_ESCROW_AGE_IDENTITY`. Keep an independent offline recovery copy.

To rehydrate credentials on an approved isolated host, retrieve the original redacted R4 receipt, use the configured recovery profile and recovery credential, and invoke the [escrow helper](../../deploy/backup/bootstrap_escrow.py) in the pinned S3 Python environment. Set `CODEXIA_BOOTSTRAP_ESCROW_PROFILE` and `CODEXIA_BOOTSTRAP_ESCROW_CREDENTIAL` for the recovery destination. The helper derives the recipient from the private identity.

```sh
python deploy/backup/bootstrap_escrow.py recover \
  --receipt /private/escrow-receipt.json --identity /private/recovery.agekey \
  --output-dir /private/restored-secrets
```

When the Actions receipt has expired, use `restore --host-id HOST_ID --generation GENERATION --identity /private/recovery.agekey --output-dir /private/restored-secrets`. The host ID and generation identify the independently verified receipt in the protected S3 prefix. This path needs read access only.

The output directory must be new. Apply the recovered values under the canonical Podman secret names and provision the original PostgreSQL roles using the recovered passwords through the approved recovery operation. Restore the v2 DB and history, then verify the original owner, Passkey and client bindings before allowing runtime use.

For initial **data** preservation, configure `CODEXIA_INITIAL_BACKUP_PROFILE` (Variable) in both `codexia-production` and `codexia-bootstrap-recovery` with the same v2 destination. In each Environment supply its own `CODEXIA_INITIAL_BACKUP_CREDENTIAL` Secret. The production principal needs the [v2 upload permissions](#採用済み目標-s3互換オブジェクトストレージへの暗号化バックアップ) and the recovery principal needs read access. Production supplies the public `CODEXIA_BACKUP_AGE_RECIPIENT`; the recovery Environment supplies the matching `CODEXIA_INITIAL_BACKUP_IDENTITY` Secret. The initial workflow passes the private transfer receipt between jobs encrypted to that recipient. After the isolated drill succeeds, the recovery runner conditionally writes the exact age-encrypted transfer receipt to `<escrow-prefix>/verified/v2-backups/<source-host-id>/<backup-id>.age` and reads it back byte for byte. A different existing object, failed write or failed readback stops publication of the activation receipt. The recovery Environment uses its existing write/read access to `verified/`. Set object retention to cover the v2 backup's recovery lifetime.

To retrieve an initial backup after the Actions artifacts expire, fetch that object from the escrow destination using the protected recovery reader. On the isolated recovery host, decrypt it with the initial **data** backup identity. Verify `sourceHostId` and `backupId` against the selected backup before exporting its `transfer` record. The pinned S3 transfer helper consumes this private record with the initial data profile and its read credential. Given a private directory, the encrypted receipt, and the selected identifiers:

```sh
umask 077
set -euo pipefail
age -d -i "$DATA_AGE_IDENTITY" "$PRIVATE_DIR/transfer.age" |
  jq -e --arg host "$SOURCE_HOST_ID" --arg id "$BACKUP_ID" \
    'select(.sourceHostId == $host and .backupId == $id and .transfer.backupId == $id) | .transfer' \
    > "$PRIVATE_DIR/transfer.json"
mkdir -m 0700 "$PRIVATE_DIR/download"
python deploy/backup/s3_transfer.py download --profile "$INITIAL_DATA_PROFILE" \
  --backup-id "$BACKUP_ID" --receipt "$PRIVATE_DIR/transfer.json" --output-dir "$PRIVATE_DIR/download" \
  --credential-stdin < "$INITIAL_DATA_READ_CREDENTIAL"
bash deploy/backup/backup.sh drill "$PRIVATE_DIR/download/codexia-$BACKUP_ID" "$DATA_AGE_IDENTITY" --approved
```

A new verification dispatch on current main can refresh an expired activation receipt while the Backend remains stopped.
