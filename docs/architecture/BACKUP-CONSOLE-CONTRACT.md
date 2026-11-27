# バックアップ管理コンソール・S3制御プレーン詳細契約

**種別: 採用済みの機能・安全設計、部分導入。** 本書は `/console/backups` の**運用設定・S3保管先・ジョブ要求・監視**についての責務境界、バックエンド契約、受入条件を所有する。画面のIDと操作は [Screen control catalog](../design/SCREEN-CONTROL-CATALOG.md)、状態遷移図は [Screen State Atlas](../design/SCREEN-STATE-ATLAS.md)、権限の正本は [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md)、生成する暗号化アーティファクトと実復旧は [Backup](../deployment/BACKUP.md)、初期配備/更新とhost lockは [Push deployment](../deployment/PUSH-DEPLOYMENT.md) に従う。

対象は**単一ownerのインストール**。BKC-001〜010のAPIとexecutorはオペレーターによる明示的な設定で有効になる。導入条件と運用手順は [Backup console provisioning](../../deploy/backup/CONSOLE.md) を参照。

バックアップ先の指定、検証、有効化、保全状態と証拠の参照を行うOWNER-SESSION向けの画面は実装目標である。ownerセッション/公開HTTP APIはOPERATOR、SSH、Ansible、Podman、PG管理者、S3 bucket管理者の資格ではない。**本番DBの復元、任意コマンド実行、IAM/Object Lock変更、秘密鍵の読取、保全済みオブジェクトの削除を管理画面に提供しない。**

## 配備との一意の責務分担

| 対象 | 正本・実行主体 | Webからの許可 |
| --- | --- | --- |
| ローカル暗号化バックアップ生成・writer quiesce・host lock・rollback | 現行 `deploy/backup/backup.sh` とAnsible push運用 | 表示／限定ジョブ要求のみ。公開WebでVMを操作しない |
| ローカルステージングディレクトリ、age受取公開鍵、復号秘密鍵、Podman DB/role | OPERATOR保護設定、復旧ホスト | 表示は秘匿値を除く能力・状態だけ。変更不可 |
| S3互換のoff-VM保存先の**希望設定** | ownerが入力するconsole設定（保護された業務外運用schema） | draft作成・変更・接続試験・有効化・停止 |
| 実際に適用したS3設定・credential・バックアップ実行結果 | 独立した権限のバックアップexecutorとdurable receipt | 隔離された読み取りAPIで結果を再取得 |
| AWS S3／互換storeの実bucket/IAM/versioning/Object Lock/retention | operator/provisioned provider policy | 読取・検査した能力を表示。providerの管理権限や削除権限をWebへ渡さない |
| 災害復旧・本番DB復元 | 独立復旧hostと別途承認済みOPERATOR手順 | 説明・復元確認証拠の表示のみ。本番restore実行ボタンなし |

**競合解決:** `CODEXIA_BACKUP_DESTINATION`は引き続き**保護されたローカルstagingパス**。WebのS3設定でこの環境変数/Ansible inventoryを上書きしない。既存の暗号化v2アーティファクトを一度だけ生成し、executorが**active revisionとして確定したS3設定**をバックアップ開始時に読み取って暗号文を遠隔保管する。設定変更は進行中のジョブに遡及適用せず、各run receiptに採用revisionを固定する。S3必須指定の場合はアップロード・再取得照合が完了するまで既存deployment admissionを成功としない。S3接続失敗時に別の保存先へ暗黙フォールバックしない。

## 受理するS3設定の契約

インストールごとに**最大1つのactive S3 off-VM保存先**と、更新のためのdraftを許可する。複数destの同時組替え/自動複製は対象外。既存ローカルstagingは残す。

| フィールド | 入力・制約 |
| --- | --- |
| provider | `aws-s3` または `s3-compatible` |
| endpoint | AWS選択時はregionから固定の公式endpointを導出。互換先はoperatorのegress/endpoint allowlistに登録済みの**HTTPS exact origin**のみ。URL userinfo、query、fragment、redirect、localhost、link-local/metadata、未承認private IP、非TLSを拒否 |
| region / bucket / prefix | 非空の正規化値。bucket/prefixは固定したallowlist・権限境界を越えない。prefixに `..`、先頭 `/`、制御文字、別環境の領域を含めない |
| addressing | path-style / virtual-hosted-style。providerとTLSホスト名に適合する組合せのみ |
| credentialMode | `operator-role` または `sealed-access-key`。前者はoperatorが明示的にpreprovisionしたservice identityのみ。後者は画面から**一回だけwrite-only**で資格情報を提出する |
| offVmPolicy | `required` または `secondary`。requiredの場合にはS3の保全未成立はdeploymentを停止。secondaryでも代替の独立オフVM保全が証明されない場合、DRの「保護済み」と表示しない |
| retentionRequest | 必要な世代/日数を要求値として保持。providerのObject Lock/lifecycle/versioningを実装が勝手に変更しない。effective保護はexecutorの実観測で別表示 |
| schedule | 初期は`disabled`。有効時はoperatorが許可したmaintenance-windowとタイムゾーンの選択、バックアップ中のwriter停止を明示。タイマー有効化は独立受入後 |
| revision | 整数/不透明ETagで楽観ロック。古いdraft/probeをactiveに昇格しない |

`sealed-access-key`はHTTPSの入力フォームからAPIへ送るが、**ブラウザー永続領域、URL、応答、監査ログ、アプリの通常DB roleに平文保存しない**。APIはoperatorが用意したバックアップexecutor公開鍵で資格情報をsealed envelopeにし、専用の制限付き運用schemaへ格納する。秘密鍵はAPIの実行identityと分離してrootless executorにのみ配布する。資格情報は**読み戻し不可**とし、更新・失効・鍵ローテーションを専用operationで扱う。schemaの設置は正式なmigration/role権限検査に従い、起動時の暗黙migrationをしない。**業務原稿のCore PostgreSQL tablesを設定ストアとして流用しない。** 同じPGクラスタ内の運用schemaを利用しても原稿の第二正本は作らない。

S3互換endpointへのprobeと転送は固定のegress policyを持つserver-side executorが実施する。DNS解決結果を接続先IPまで検査・再検査し、HTTP redirect、proxy経由の内部宛SSRF、意図しないbucket/prefixを拒否する。SDKの自動retryも安全な同一object key/同一checksumに制約する。

## Web APIの目標契約

**BKC-001〜010はoperatorによる明示的な有効化が必要。** `/api/console/backups/*` はCloudflare Tunnelを経由するFastify上の**OWNER-SESSION専用のcookie/CSRF保護経路**。OWNER-API bearer、MCP bearer、SETUP、ANON、SHARE-READER、EDGE-CIには権限を与えない。fresh reauthenticationはcredentialの登録/再設定、activate、disable、手動バックアップ要求時に**API側で**検査する。新しい外部管理APIやshell実行RPCは作らない。

| Operation ID | Method / path | 行為・成功応答 | 必須の拒否条件 |
| --- | --- | --- | --- |
| BKC-001 | `GET /api/console/backups/status` | 200。最新のactive revision、enabled/degraded、last verified off-VM backup、restore drillの有無・日時、staging状態の**非機密**情報。未取得は`unknown` | owner不足401/403、private credential露出禁止 |
| BKC-002 | `GET /api/console/backups/config` | 200。active/draftの非機密設定、version、secret=`configured`/`missing`の状態のみ | credentials、secret値、署名済みS3 URLを絶対返さない |
| BKC-003 | `PUT /api/console/backups/config/draft` | 200。If-Matchで対象revisionを確認し、妥当性検査後にdraft保存。秘密値はwrite-only | 412 stale、422 input、403 unauthorized、operator allowlist外、送信中の二重操作 |
| BKC-004 | `POST /api/console/backups/config/probes` | 202＋`probeId`。draft revisionを固定し、executorにS3検査を依頼。probeは専用一時keyでPUT/GET/checkし、検査後は権限に応じて安全に片付ける | 未設定・古いrevision、実運用prefixの既存object上書き、未知endpoint、資格失効 |
| BKC-005 | `GET /api/console/backups/config/probes/:id` | 200。QUEUED/RUNNING/PASSED/FAILED/BLOCKEDと証拠分類。認証情報なし | 他owner/別run、不明ID、安全情報を超える例外 |
| BKC-006 | `POST /api/console/backups/config/activate` | 202＋`operationId`。draft revisionとPASSED probeの一致、fresh再認証、再承認後にactiveへの適用を要求。**202は有効化成功ではない** | 409 stale/unverified、403、失効したprobe、実policyと矛盾 |
| BKC-007 | `POST /api/console/backups/config/disable` | 202＋operationId。影響（オフVM保護喪失）を明示確認し、別の保護経路がなくrequiredなら拒否 | requiredのDR保全を無検証に空にする操作、遠隔object削除要求 |
| BKC-008 | `POST /api/console/backups/runs` | 202＋runId。手動保全をdurable queueへ要求。maintenance window・writer停止の確認が必要。**バックアップ成功ではない** | 重複request identity、lock競合、未承認live writer停止、executor不在 |
| BKC-009 | `GET /api/console/backups/runs` / `GET /api/console/backups/runs/:id` | 200。実行履歴、source/version、active revision、phase、manifest digest、off-VM confirmation、詳細エラー区分をredactedで返す | 未存在/他identity、receiptなきsuccess、秘密露出 |
| BKC-010 | `GET /api/console/backups/recovery` | 200。restore drillの最終成功・対象と不足条件。実復旧のOPERATOR手順への導線のみ | Webからの本番復元、age private keyダウンロード、VM操作不可 |

**共通DTO・エラー:** `requestId`/Idempotency-Key、`revision`/If-Match、明示的な`status`と`phase`、`reasonCode`、`observedAt`。資格・endpoint/バケット詳細のログ/応答は安全なマスキングを適用。401未認証、403権限不足、404存在隠蔽、409稼働状態不整合、412 revision、422妥当性、429頻度、503 executor/DB/S3停止を区分。タイムアウト/応答不明時は`requestId`による再取得を必須とし、二重実行しない。API operationの詳細wire Schemaは [API contract](API-CONTRACT.md) と将来のTypeSpecが所有する。BKC-IDは安定した要求識別子であり、任意のHTTP handler名に依存しない。

## 実行状態と保護境界

```text
Cloudflare Workers /console/backups (OWNER-SESSION)
                |
        Fastify /api/console/backups/*
           config/version/CSRF/fresh reauth
                |
       専用PostgreSQL運用schema
       draft/active・sealed credentials・job/receipt
                |
       rootless backup executor (公開portなし)
       制限付きDB roleと独立secret key
           /              \
host lock + backup.sh     S3 probe/upload/download
API/Tunnel quiesce        allowlisted HTTPS egress
          \               /
           verifiable receipt
                   |
       GET status/runs/recovery to owner
```

- owner APIは**希望する設定**とbounded command（probe/backup）をdurable requestとして記録するだけ。host lock・Podman・Ansible・実S3副作用はoperatorが導入したexecutorが行う。任意コマンド名、bash引数、任意path、任意S3 URL・HTTPヘッダーをブラウザーから受け取らない。
- backup executorは**第二のデプロイコントローラーではない**。既存`backup.sh`とhost lockを再利用し、現在のrun tokenで明示された保全処理だけを許可する。deploy pipelineと手動・scheduled jobは同じexclusive host lockを使い、書込中に別バックアップが走らない。
- writerをquiesceする必要があるmanual/scheduled backup中はAPI/Tunnelが一時停止し、Webはジョブ受付後に接続を失い得る。UIは保存済みrun IDを保持し、サービス復帰後に結果を再取得する。「接続が切れた＝失敗/成功」と推定しない。クライアントの原稿下書きと異なる。
- interrupted/timeout時には、既存deploymentのロック・サービス復旧不変条件を維持。復旧と結果確認が済まない限りrunを`SUCCEEDED`にしない。副作用完了とAPI通知の順序を逆転させない。
- 本番S3にuploadしたことをrestore可能性の唯一証拠にしない。**独立した復旧hostでのdrill receipt**、外部保護したage鍵/backup receipt/認証role/secretsの可用性を別々に照合する。

## 画面状態と表示

正規UIの入口は`/console`→`/console/backups`。子画面は`/console/backups/destination`、`/console/backups/verification`、`/console/backups/history`、`/console/backups/recovery`。画面IDは`CON-30`〜`CON-34`。具体的な遷移とコントロールは上記のUI正本に記録する。

接続試験`PASSED`、有効設定`ACTIVE`、遠隔バックアップ`VERIFIED`、独立復旧`DRILL_PASSED`は**異なる事実**。dashboardに「保護済み」と表示できるのはポリシー上必要な保全・暗号文の遠隔照合が完了している場合だけ。DR復旧可能性は別のdrill成功に限る。オンライン/オフライン・空状態・credential期限切れ・課金/容量不足を区別し、再認証後も入力秘密の再表示はしない。

## 受入条件（全て実装後に検証）

| ID | 独立の検証義務 |
| --- | --- |
| BKC-T01 | owner/ANON/SETUP/OWNER-API/MCP/SHARE/EDGE-CIで10 operationを交差試験し、許可対象外はfail-closed。CSRF、Origin、fresh reauthをAPI側で証明 |
| BKC-T02 | AWS S3と互換providerに対し、allowlist・TLS・redirect拒否・DNS rebinding・metadata SSRF・bucket/prefix越境を否定テスト |
| BKC-T03 | draft revision競合/古いprobe、二重activate/timeout/retryは実行を重複させず、完了結果を再取得。機密値は保存後に読み返せない |
| BKC-T04 | OPERATORが保護設定したlocal stagingとage鍵がUI入力によって置換されない。復元秘密鍵とS3資格が公開UI、CI、ログ、MCPに露出しない |
| BKC-T05 | backup.shのv2 artifact一式をS3送信・照合。ETagのみで合格としない。外部独立receiptと暗号文digestが一致しないと失敗 |
| BKC-T06 | 手動/定期ジョブとdeployが同じhost lockを競合して安全停止。writer quiesce、API/Tunnel復帰、中断回復を実ホストfixtureで検証 |
| BKC-T07 | 必須S3障害時のdeployment停止、secondary障害時の別保管証明、不明/未設定時のDR未認定を確認 |
| BKC-T08 | 使い捨てDB/S3互換fixtureで異常系を検証。独立restore hostで暗号文取得→復号→DB/history/認証整合とAPI readinessを証明 |
| BKC-T09 | Desktopとコンソールの直接URL・戻る操作、キーボード操作・320 CSS pxでの表示・WCAG 2.2 AA、IME・原稿下書き保持、owner session失効・通信中断をPlaywrightで確認 |
| BKC-T10 | 本番復元/SSH/Ansible/Podman/IAM/Object Lock変更をpublic API経由で要求できず、Web入力から任意副作用を起こせない |

本書を完成させてもコード・本番UI・S3 bucket・role・worker・backup timer・drillが存在する証拠とはならない。導入PRごとにAPI/DB/権限/CIの実測結果を添える。
