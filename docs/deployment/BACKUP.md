# Encrypted push-deployment backups

The [Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md) owns when backup, independent recovery evidence and restore are required for route admission and operation acceptance. Fresh R4–R6 does not require backup or restore evidence; adoption/recovery and subsequent updates protect existing data. Backup is a prerequisite in the [compatible update state machine](UPDATE-FLOW.md), and recovery acceptance is required by the [initial deployment state machine](INITIAL-DEPLOYMENT-FLOW.md). A verified ciphertext file alone is not proof of independent-host recoverability.

[`deploy/backup/backup.sh`](../../deploy/backup/backup.sh) is the canonical producer. The protected Ansible push transaction and the operator-provisioned backup executor invoke it under the same host lock. The executor can request backups in operator-approved maintenance windows.

For an installed API update, the Ansible `deploy` stage requires the active Console backup revision. The VM-local [executor settings](../../deploy/backup/CONSOLE.md) supply a private staging directory and the age recipient for both ordinary runs and updates. A remote NFS/CIFS/SSHFS destination is also supported and undergoes additional host-identity validation. Deployment is serialized under `~/.local/state/codexia-deploy/host.lock`. After the API and Tunnel stop, the shared VM backup runner invokes `backup-locked` with the inherited lock descriptor. The producer confirms the writer is quiesced, encrypts the PostgreSQL logical dump, history and manifest with `age`, and verifies its fingerprints and ciphertext checksums. The executor verifies off-VM preservation against the pinned revision before the candidate can start. Recovery after loss of the VM or its disk relies on the verified off-VM artifact.

An independent `restore-drill` stage decrypts a **v2** artifact on an isolated recovery host, imports it into disposable PostgreSQL/history resources, checks the logical database and history fingerprints, and removes the temporary resources. It never restores production data or writes credentials to the repository. Versions preceding v2 and the retired updater's rollback receipts are deliberately unsupported.

An operator can extend the isolated drill with `--candidate-full-image` and `--candidate-ledger` for the exact reviewed Full image. The `--candidate-api-ready` check also takes `--candidate-runtime-settings` and `--candidate-introspection-secret-file`, both protected recovery inputs for the restored Better Auth catalog. It verifies API readiness against the restored PostgreSQL and history during the drill.

Use the approved protected operator procedure and an independently supplied recipient/recovery identity on a recovery host. Only the holder of the external backup encryption private key can perform the restore drill. Production recovery keys, backup credentials and recovery material are not supplied to GitHub Actions.

The deployment backup is a pre-rollout recovery point for the database and history resources. PostgreSQL roles and Podman secrets require separate recovery. Current push deployment admission rejects migration-fingerprint, API-epoch, and persistence-format changes. These changes require a separately reviewed operation with its own approval, encrypted pre-change backup, migration verification, and tested restore procedure.

## Accepted target: one PostgreSQL application-state recovery source

[Data model — REQ-DATA-005](../architecture/DATA-MODEL.md) owns the approved target of consolidating all recovery-required server application state into one PostgreSQL cluster. Once migrated and independently verified, application-state disaster recovery must not depend on the former host-history volume or derived caches. Infrastructure configuration, recovery keys, credentials and independently protected evidence remain separately recoverable. Author-facing [open work export](../authoring-portable.md) is data portability, not operational recovery.

Continue the logical PostgreSQL backup using `pg_dump`, age, and S3-compatible off-VM storage. Retain the history input and the v2 recovery procedure until PostgreSQL-only recovery and the successor preservation path pass isolated restore, off-VM protection, key custody, integrity, failure and deployment admission tests. The [backup design decision](BACKUP-PRODUCT-PROPOSAL.md) records the approved simplification and the conditions for reevaluating physical backup.

## Verify a candidate ledger on a restored backup

Load the reviewed, publication-certified Full backend image by its immutable digest on the isolated recovery host. Use the migration fingerprint from the same certified image.

```sh
bash deploy/backup/backup.sh drill "$backup_directory" "$recovery_identity_file" --approved \
  --candidate-full-image "$certified_full_image" --candidate-ledger "$migration_fingerprint"
```

After verifying the restored database and history fingerprints, the drill checks the candidate's PostgreSQL ledger using a read-only role in the scratch database. Retain the checksum-manifest SHA-256 and the verified ledger fingerprint as recovery evidence.

## 採用済み目標: S3互換オブジェクトストレージへの暗号化バックアップ

[バックアップ制御の運用手順](../../deploy/backup/CONSOLE.md)に従い、オペレーターがS3保存先を扱うAPIとexecutorを有効化する。
OWNER-SESSIONで保存先とwrite-only資格情報を扱う画面の設計は[バックアップ管理コンソール](../architecture/BACKUP-CONSOLE-CONTRACT.md)に従う。
暗号化アーティファクトの生成とwriter停止の確認には`backup.sh`と共通host lockを使う。
ローカルstagingとage受取公開鍵はVM上の保護された実行設定で管理する。本番復元、VMやIAM変更は保護されたオペレーター手順で行う。通常のS3保存先・実行資格情報はConsoleからのみ設定する。Actionsに保全設定・復号鍵を登録しない。

ローカルまたは独立 mount 先で生成した v2 artifact は、S3 API 互換ストレージへ転送できる。
保護された executor と Ansible のデプロイ受入は、同じ `backup.sh` と転送アダプターを使う。
クラウドベンダー、バケット名、リージョン、保持期間は配備先の運用方針で決める。

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

The writer needs `s3:PutObject`, `s3:GetObject`, and `s3:AbortMultipartUpload` on the fixed object prefix, plus `s3:ListBucket` scoped by `s3:prefix` to return an unambiguous missing-object result for conditional creation. It queries bucket versioning and Object Lock configuration to report observed capabilities. The writer and recovery reader need `s3:GetObjectVersion` for versioned readback. For a Console revision requesting retention days, the adapter observes the provider-applied retention on each exact ciphertext and marker version. The writer needs `s3:GetObjectRetention` for that check. Standalone operator-requested explicit retention additionally requires `s3:PutObjectRetention` and `s3:GetObjectRetention` for the writer on that same prefix. The adapter never calls `ListMultipartUploads`, `DeleteObject`, or `DeleteBucket`.

Run the separate synthetic-provider fixture with:

```sh
bash deploy/backup/s3-fixture.sh
```

It starts the pinned Silo S3-compatible service on loopback with a temporary CA, bucket, and restricted writer. It creates synthetic PostgreSQL 17 and history data, invokes the canonical `backup.sh` v2 producer, transfers and downloads the encrypted artifact, and runs the canonical isolated restore drill. Its local Podman command shim is backed by Docker; it does not change the production helper. Temporary credentials, identities, containers, volumes and artifacts are removed on completion. The fixture does not contact AWS or use AWS credentials.

### 接続・セキュリティ契約

| 項目 | 要件 |
| --- | --- |
| Endpoint | AWS S3およびS3 API互換サービスを対象。HTTPS必須、TLS検証を無効化しない。endpoint/region/virtual-hosted vs path-styleはprovider仕様に従う明示設定 |
| 認証 | 短命credential/ロール連携が可能なら優先。固定access keyが必要なproviderではConsoleのwrite-only入力から専用運用schemaに封印し、実行主体だけが利用する。operator-roleの場合は外部管理面とVMで事前構成する。repo/Actions Secrets/CI artifact/logに出さず、API応答・UI読戻し・MCPへ資格情報を返さない |
| 権限 | 書込・参照・復元・削除の主体を分離。通常のバックアップwriterにbucket-wide deleteや管理権限を与えない。別prefix/別環境への誤配送を拒否 |
| 暗号化 | **S3転送前にageでクライアント側暗号化**。SSE-S3/SSE-KMS等は追加防御でありageの代替ではない。秘密鍵はオフVMの独立した保護・復旧手順で管理 |
| 保持・削除 | versioning、Object Lock/WORM、retention、lifecycleはproviderが対応する範囲で明示設定。未対応の場合は「保護済み」と誤表示せず、削除権限分離・独立コピー等の補完策を受入条件にする |
| リトライ | timeout、指数バックオフ、multipart cleanup、同一backup IDの冪等再実行。部分成功は `BLOCKED` として記録し、commit markerを公開しない |
| ネットワーク | VMから対象S3 endpointへの最小の送信経路。S3への書込のためにAPI/Tunnel/SSH/MCPの新たな公開入口を作らない |
| 観測 | backup ID、source SHA、schema fingerprint、ciphertext SHA-256、object key、endpoint識別子（秘密を含まない）、size、timestamp、upload/download/restore結果を監査可能にする |

### 初期の復旧目標

| 対象 | 運用目標 |
| --- | --- |
| VM 喪失時の復旧時点目標（RPO） | 24 時間以内。事故時の最終確定書込みと、独立保管から取得できる最新の検証済み復旧点との差を測る。 |
| 復旧時間目標（RTO） | 障害検知から公開再開まで 4 時間以内。鍵と保管物の取得、隔離環境の準備、復元、API と既存 owner の認証確認を含む。 |
| 定期バックアップ | 原則 1 日 1 回。取得と転送の時間、失敗後に次の検証済み復旧点を確保するまでの時間を踏まえ、RPO を満たす間隔を実測で確定する。 |
| 通常 Backend 更新 | host lock と writer 停止の下で、候補起動前の最後の確定書込みまで含む復旧点を確保し、必要なオフ VM 保全と照合の完了を候補起動の条件にする。 |
| 作者による原稿の誤編集 | [既存 Revision](../architecture/DATA-MODEL.md) から復旧する。災害復旧では取得時点の論理 dump を用いる。 |

これらは運用目標である。
保管先への転送と独立ホストでの復旧を測定し、復旧担当が達成の根拠を保護された運用記録に残す。
現時点では物理バックアップと PITR は採用対象外とする。
現行方式が実測で目標を満たせない場合に、取得間隔、転送、鍵の取得、環境準備、DB 復元の所要時間を分けて原因を特定する。
DB 保全または復元方式が達成を妨げる場合に限り、原因に応じて物理方式を再評価する。

### 実装の簡素化

PostgreSQL 標準コマンドと age を保全物の生成に、既存 Boto3 を S3 の通信と再試行に、Ansible と systemd を既存 executor の配備と監視に使う。
手動、定期、R8 は同じ実行主体、設定 revision、journal と host lock を使う。
同じ事実を表す転送処理、再試行、journal、receipt の管理、wrapper と実行制御を集約する。
独立した復旧証拠、暗号文の読み戻しと完全性、復号鍵の分離、同一 ID の冪等性、R8 の失敗停止を受入条件にする。
S3 の commit marker と独立 receipt は別の保護境界に置く。
保全失敗、marker の応答消失、VM 喪失を検証し、独立復元と更新前保全を再現できた処理から置き換える。

### 運用ポリシーと失敗時

- **通常Backend更新前バックアップ**は既存のhost lock・停止・暗号化・復元可能性の契約を維持する。S3を必須の保管先に指定した環境では、S3アップロードと検証が成功するまでcandidate activationを禁止する。S3が任意の二次保管先である環境では、既存の承認済み独立バックアップが成立した場合に限りS3失敗を別の運用障害として記録できる。失敗を黙って無視しない。
- **定期的な保全**は既存の Console schedule と同じ VM 内実行主体で受け入れてから有効にする。writer 整合性、host lock、可用性、および上の復旧目標への適合を検証する。保持期間と世代数は運用方針に従う。
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

## 通常運用のバックアップと災害復旧

No initial backup, credential escrow, S3 profile, recovery Environment, independent restore receipt, or backup encryption recipient is required to bootstrap and activate a genuinely new installation. R4 generates internal credentials on the VM; R5 enrolls the owner; R6 starts the normal Backend. These steps do not establish disaster-recovery acceptance.

1. ACTIVE後、インフラ管理者は実バケット・prefix・IAM/retentionを準備する。復旧担当は独立秘密管理に復号鍵、復旧reader資格情報、復旧に不可欠なVM秘密（Podman secrets、DB role資格、Better Auth/内省、backup executorの封印解除鍵等の現行利用対象）を保全する。外部Tunnel/OIDC等は元の管理面から再取得または再発行できることを確認する。保全・取得は既存の保護されたoperator手順で行い、手製復旧bundle、独自の資格情報エスクロー、新規Workflowを要求しない。鍵/秘密を紛失したらDR未受入とする。
2. 所有者は `/console/backups` で保存先、実行資格、保護方針を設定し、接続試験、有効化、通常バックアップを実行する。VMの共通実行主体が現行v2を生成し、転送・readbackを行う。GitHubへの保管先・age鍵・S3 credentialの転記は不要。手動・定期・通常Backend更新前のバックアップは同じ保管設定と実行経路を使う。既存host lock、整合性、暗号化・検証の条件を維持する。
3. 復旧担当は別ホストで、独立保全したreceiptを用いて選択backupを取得・照合・復号し、隔離DB/historyに復元してowner/Auth/role/ledgerとAPI readinessを照合する。VM・Console・GitHubが失われても独立秘密・保管先から取り出せることを確認する。保護された運用記録に結果を保持し、既存のConsole記録経路で参照できるようにする。通常データ投入と継続的な自動配備を受け入れる前に実環境で確認する。未受入を新たな初回配備gateや実装上の画面ロックに置き換えない。
4. 本番復元はR2として明示承認する。既存writer/Tunnelを停止し、復元先が隔離されていることを確認し、必要な新VMを既存Ansibleで収束する。復元対象DBに新規ownerを作らず、必要なruntime秘密/roleと選択したDB/historyを復元し、同一owner・Passkey・client・DB内容と認定済み候補を照合する。復元点以後の更新の扱いを承認し、readiness・公開経路・backup運用の再確認後に復帰する。完全なDB集約受入後は旧historyなしの復元を要求する。復元失敗・鍵欠落・未知状態は停止。

廃止対象は初回専用の credential escrow、initial-preservation/credential-recovery workflow と対応する gate、設定、receipt 形式とする。
現行の実体と廃止対象の証拠を調査し、必要な復旧資料を復旧担当へ安全に引き渡した後に依存を除去する。
GitHub Environment の廃止は既存資料の保全と運用承認に従う。
