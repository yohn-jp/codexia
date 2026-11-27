# PostgreSQL バックアップ製品の選定提案

**種別は未承認の設計提案。**
設計の所有者はバックアップ運用で、対象読者は配備運用者、復旧担当者、設計レビュー担当者。
対象は PostgreSQL に復旧対象のアプリケーション状態を集約した後の災害復旧と通常 Backend 更新前の保全である。
作品エクスポート、既存データの非互換 Cutover、本番復元の実行、保持方針の決定は対象外とする。
運用には既存の [Backup](BACKUP.md)、[Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md)、[更新遷移](UPDATE-FLOW.md)、[Backup Console](../architecture/BACKUP-CONSOLE-CONTRACT.md) を適用する。

## 復旧単位

現行方式は `backup.sh` が API writer 停止と host lock の下で PostgreSQL の論理 dump と history volume を取得し、age で暗号化する。
VM 側の実行主体は公開受取鍵を持ち、復旧担当は独立保管した秘密鍵を使う。
S3 転送は暗号文を読み戻して検証し、完了 marker と独立保護された receipt を復旧時に照合する。
論理 dump の復旧単位は対象 DB と同時に採取した history で、DB のグローバル role と VM 秘密は別に復旧する。[現行バックアップ契約](BACKUP.md) [PostgreSQL の pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

物理バックアップでは、ベースバックアップに PostgreSQL の変更を記録した **WAL** を順に適用し、指定した復旧位置までクラスタを再構成できる。
これを **PITR**（ポイントインタイムリカバリ）と呼ぶ。
ベースバックアップに対応する連続した WAL、互換性のある PostgreSQL のメジャーバージョンと拡張、復旧対象のタイムラインが揃う必要がある。
復元対象はクラスタ全体であり、認証スキーマと role catalog も含む。
構成管理で配備した設定、Podman secrets、バックアップ executor の封印解除鍵、独立した復旧証拠は引き続き各所有者の保全対象となる。
物理バックアップを候補とする前提は、ジョブ、通知、編集位置などを含むサーバー状態が PostgreSQL に移行済みで、旧 history に依存せず復旧できることである。[PostgreSQL の連続アーカイブ](https://www.postgresql.org/docs/17/continuous-archiving.html) [データモデルの REQ-DATA-005](../architecture/DATA-MODEL.md#サーバー永続データ集約契約req-data-005)

## 方式の比較

| 方式 | 保全と復元 | 鍵と保管先 | Codexia への適用条件 |
| --- | --- | --- | --- |
| 現行の論理 dump と age | 復旧時点は取得時に固定される。現行の v2 形式と隔離 restore drill が利用できる | VM は公開受取鍵を使用し、復旧担当が秘密鍵を持つ。S3 転送は読み戻しと独立 receipt に対応する | 承認済み方式として継続できる。採取間隔が失われうるデータ量を左右し、dump と復元にかかる時間を実測する必要がある |
| pgBackRest | フル、差分、増分バックアップと WAL アーカイブを提供する。`check` はアーカイブ設定を検査し、`verify` は指定したセットのバックアップと WAL を検証できる | S3 リポジトリのクライアント側暗号化は共有パスフレーズ方式。書込み時に使う秘密が復号にも使える。既定の自動 `expire` を停止し、保持期限の処理を別権限で行える | 一体化した検証コマンドが利点。復号可能な秘密を置く主体と、リポジトリメタデータの更新や削除権限を分離する方法を先に承認する必要がある |
| WAL-G | フル、増分バックアップと WAL アーカイブを提供する。`wal-verify` は WAL の欠落とタイムラインを調べる。指定したベースバックアップからの復元は `backup-fetch` と `wal-fetch` を使う | アップロード用の公開鍵と復元用の秘密鍵を使い分ける OpenPGP 構成が文書化されている。S3 の保持期間と保持モードを設定できる | 同名 WAL の衝突検出時に保存済み WAL を復号するため、公開鍵だけを持つ書込み主体でそのまま再試行できない。保全全体の読み戻しと独立した同一性照合も別途検証が必要 |

製品の機能は [pgBackRest 操作ガイド](https://pgbackrest.org/user-guide.html)、[pgBackRest 設定](https://pgbackrest.org/configuration.html)、[pgBackRest コマンド](https://pgbackrest.org/command.html)、[WAL-G PostgreSQL](https://wal-g.readthedocs.io/PostgreSQL/)、[WAL-G 暗号化](https://wal-g.readthedocs.io/)、[WAL-G ストレージ](https://wal-g.readthedocs.io/STORAGES/) を参照する。

## 推奨する判定

WAL-G の `WALG_PREVENT_WAL_OVERWRITE` は、同名 WAL を再送するときに保存済みオブジェクトを取得し、復号と展開を経て元の WAL と比較する。
タイムライン履歴ファイルでは設定に関係なく同じ比較を行う。
公開鍵だけの書込み主体は、S3 への保存が成功した直後に応答を失うなどして同じ WAL を再送すると、保存済み WAL を復号できずに停止する。
標準の上書き防止を解除すると通常 WAL の衝突検査が失われるので、現行方式と同等の再試行条件を満たせない。[WAL の上書き検査](https://github.com/wal-g/wal-g/blob/v3.0.10/internal/databases/postgres/wal_push_handler.go#L51-L65) [保存済み WAL の比較](https://github.com/wal-g/wal-g/blob/v3.0.10/internal/databases/postgres/wal_push_handler.go#L111-L135) [取得時の復号](https://github.com/wal-g/wal-g/blob/v3.0.10/internal/fetch_helper.go#L193-L209) [OpenPGP の復号](https://github.com/wal-g/wal-g/blob/v3.0.10/internal/crypto/openpgp/crypter.go#L132-L143)

現時点では論理 dump と age の継続を提案する。
稼働環境の復旧時点目標（RPO）と復旧時間目標（RTO）を明示し、現行方式の実測で採取間隔より短い RPO または中間時点への復元が必要と確定した場合に、物理バックアップを再評価する。
復号鍵の独立管理を維持する場合は、公開鍵による WAL-G の暗号化に、復号なしで安全に再試行できる上流機能を組み合わせられることが評価の前提になる。
本番の保全実行主体が復号可能になる変更を検討する場合は、鍵管理の設計を先に承認する。
共有パスフレーズを許容する設計であれば、指定セットの検証機能を持つ pgBackRest を優先して比較できる。
[依存選定規約](../architecture/DEPENDENCY-POLICY.md) に従い、採用する場合に PostgreSQL と互換性のある安定版、配布元、改変検知と脆弱性対応を確認して固定する。

## Console と通常更新への接続条件

純新規の R4〜R6 では保管先、バックアップ鍵、復旧証拠を求めず、ACTIVE 後に所有者が Console で保管先を設定する。
製品を採用する場合は、手動、承認済みの定期実行、および通常 Backend 更新が同一の VM の実行主体と確定済み設定 revision を参照することを示す。
PostgreSQL の WAL アーカイブは復元に必要な WAL を配送する責務に限り、バックアップの要求、配備判断、期限切れ削除は既存の運用境界に従う。
rootless Podman で PGDATA に接する主体と権限、資格情報の受け渡し、動作中の設定 revision の切り替え方法が既存の Ansible、Quadlet、executor に収まることを採用条件とする。

通常 Backend 更新では、既存の host lock と writer 停止を前提に、候補起動前の最後の確定書込みを含む復旧位置を特定する。
必要なベースバックアップとその位置までの WAL が独立保管先から読み取れ、保全先と設定 revision が実行記録に結び付くことを確認してから次に進む。
必要な WAL の未着、保全失敗、証拠の欠落時には候補を起動せず、既存の再開または切戻し手順を使う。
同一 digest の no-op と非互換候補の拒否は通常更新の契約に従う。[更新遷移](UPDATE-FLOW.md)

## 採用前の受入条件

| 項目 | 合格を判断する観測 |
| --- | --- |
| 復旧点とデータ同一性 | 空の隔離 VM で、独立保管先から保全 ID、クラスタ ID、タイムラインと目標時刻または LSN を指定して復元する。選んだ位置より前の確定書込みが残り、後続の書込みが含まれない。原稿と確定履歴、owner と Passkey、OAuth、運用設定、ジョブと通知、編集位置、ledger、API readiness を照合する。旧 history や派生 cache のコピーを必要とせず、API 認証と派生データの再生成を確認する |
| 保全先と完全性 | AWS S3 と少なくとも一種類の互換保管先について、TLS、endpoint と prefix の制約、アップロード後のバイト照合、バージョンと保持の実効性を示す。ベースバックアップと必要な WAL の期待値を独立保護した証拠で固定し、保管先でオブジェクト、カタログ、marker が一緒に差し替わった場合も拒否する。製品の内部検証や ETag だけで送信元の真正性を判定しない |
| 鍵と権限 | VM の書込み主体が通常稼働に必要な権限だけで動き、復旧担当は独立した読取資格と復号鍵を使う。DB の role catalog と外部から再配備した秘密の組合せで認証が成立する。設定の write-only 入力、API と executor の役割分離、保全先の削除権限と保持期限操作の分離、期限前の削除拒否を確認する。Secrets、復号鍵、平文データは Actions、API の応答、ログ、公開成果物へ流れない |
| 失敗と再開 | WAL 欠落、同名 WAL の不一致、別クラスタや別タイムライン、権限失効、通信切断、途中生成物、保持期限のずれを検出する。同じ保全要求の再試行で既存復旧点を上書きせず、未完成点を受入済みと表示しない。Console の保全設定変更、更新前の失敗、host lock 競合から既存の運用状態へ安全に戻る |
| RPO、RTO、容量 | 想定データ規模で復旧可能位置と最終確定書込みの差、隔離 VM 準備から API 検証までの時間、更新時の writer 停止時間を測る。保管先が停止した場合の WAL 滞留とディスク増加を再現し、検出時点、復帰後の追いつき、設定した保持期限内の WAL 連続性を確認する |
| 稼働環境での受入 | 認定した同一ソースと意図した配備構成を突き合わせ、実際の保管先への転送と別ホストの隔離復元を保護された運用記録に紐付ける。通常配備から独立した承認で実施し、隔離した検証用クラスタが本番と同時に公開される経路を持たないことを確認する |

## 現行方式を終える条件

現行 v2 の生成、転送、復元契約は、データ集約の認定、製品と運用設計の承認、隔離復元と通常更新前保全の受入が揃うまで稼働を続ける。
切替時には旧形式の保全済みデータ、receipt、鍵と復旧に必要な手順を承認済みの保持期限まで利用可能にする。
既存の保全物を削除する判断は保存方針と復旧担当の承認に従う。
同一インストールで二つの通常保全方式を運用する期間と終点は切替承認に記録し、認定後は通常の配備や Console が旧形式へ暗黙に戻る経路を残さない。
