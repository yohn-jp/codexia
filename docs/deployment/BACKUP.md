# Encrypted push-deployment backups

Backup is a prerequisite in the [compatible update state machine](UPDATE-FLOW.md), and recovery acceptance is required by the [initial deployment state machine](INITIAL-DEPLOYMENT-FLOW.md). A verified ciphertext file alone is not proof of independent-host recoverability.

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

After the restored PostgreSQL and history fingerprints match the backup, the candidate runs its packaged PostgreSQL maintenance `--check`, `--apply`, and `--check` against the scratch database. It uses a dedicated read-only role for checks and a separate writer for apply. The image uses only the scratch database's loopback network namespace.

The same image then runs the packaged `maintain-job-history.js` command in the same three modes against the restored scratch history volume. It runs as UID/GID 1000 without network access and mounts the scratch volume read-only for checks. Apply promotes job-history formats 1 and 2 to format 3. A missing or current history is already ready. The drill requires both final checks to report readiness and preserves the encrypted backup bytes.

Preserve the successful drill output with the exact digest and checksum-manifest SHA-256. The regular backup receipt still records the restored ciphertext identity. Paired activation and production recovery require their own approved procedure.

[Push deployment procedure](PUSH-DEPLOYMENT.md)

## 採用済み目標: S3互換オブジェクトストレージへの暗号化バックアップ

**状態: 機能要件・設計採用済み、実装/本番検証は未完了。** 現行のローカル/独立mount先に加えて、**S3 API互換ストレージをオフVM保管先としてサポートする**。特定のクラウドベンダー、バケット名、リージョン、保持期間、RPO/RTOはまだ確定していない。S3対応はバックアップの保管・取得機能であり、CodexiaのPostgreSQL正本やdeploy管理プレーンを変更しない。

### 機能・データフロー

1. 既存の唯一のbackup producer `deploy/backup/backup.sh` が、API writerの停止とhost lockのもとで、**現行v2形式のage暗号化PostgreSQL dump・history・manifest・ciphertext checksum**を作る。S3専用の第二dump/別の暗号化形式を作らない。
2. 検証済みの暗号文一式を、保護されたS3互換bucket/prefixへ**オブジェクトとしてアップロード**する。未完了のmultipart uploadや途中オブジェクトを「利用可能な復旧点」として公開しない。全オブジェクトのサイズ・SHA-256/manifest digestとリモート取得内容を検証し、最後に**commit marker/receipt**を公開する。オブジェクト名はバックアップIDとsource identityで一意にし、既存の復旧点を上書きしない。
3. **アップロード済みオブジェクトを再取得**し、manifestとchecksumを照合してからオフVM保管成功とする。S3のETagをSHA-256や完全性の唯一の証拠として扱わない。
4. 隔離restore hostは、明示したbackup IDとbucket/prefixから暗号文とmanifestを取得し、ローカルの一時領域で完全性を確認して、**既存の `backup.sh drill` の復号・PostgreSQL/history検証へ引き渡す**。本番DBへ直接復元しない。
5. 現行バックアップ対象外であるPostgreSQL roles、Podman secrets、age秘密鍵、S3 credentialの復旧責務は別途維持し、これらを同一bucketに平文保管しない。

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
| BACKUP-S3-005 | 隔離restore hostでS3取得→既存drill→DB/history/schema fingerprint→API起動の実証 |
| BACKUP-S3-006 | 必須S3保管先の障害時はデプロイ停止。任意保管先の場合も監査可能な失敗を記録 |
| BACKUP-S3-007 | bucket credential、age秘密鍵、原稿平文がログ・CI artifact・公開Pagesへ出ない |

この機能は [External interfaces](../architecture/EXTERNAL-INTERFACES.md) の `EXT-OPS-003`、[Requirements](../requirements/REQUIREMENT-REGISTER.md) の `REQ-OPS-003` と関連付ける。導入時にS3 SDK/CLIの最新版・ライセンス・認証方式を比較して決める。**本PRでは実装、bucket作成、credential設定、実S3通信を行っていない。**
