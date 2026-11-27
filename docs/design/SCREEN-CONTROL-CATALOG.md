# Codexia 画面・コントロール・ユーザージャーニー設計

**種別: 規範的UI/UX設計。** 本書はすべての論理画面・モーダル/シート・操作コントロールについて、ユーザー、入口、状態、ボタン、APIに要求する権限、成功後の遷移、失敗時の復帰を確定する。実際のURLとprincipalの正本は [URL/API認可設計](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)、図の正本は [画面状態遷移図](SCREEN-STATE-ATLAS.md)、保存は [Interaction contract](INTERACTION-CONTRACT.md)。**コードは実装状況の照合資料であり、デザイン決定のauthorityではない。**

## 想定利用者と許可の最小化

| 利用者 | 目的 | 許可する作業面 | 絶対に到達させない操作 |
| --- | --- | --- | --- |
| 作者（owner） | 続きを書く、構成・知識・提案の管理、公開、認証器管理 | Desktop React Web/iOS Native SwiftUI、OAuth、本人管理`/console`目標 | 管理画面からVM・SSH・DB credentialへ直接アクセス |
| 初回所有者（未登録） | 新規構築されたサービスで最初のPasskeyを登録 | `/console/setup` **目標のみ** | 作品の閲覧/編集、owner sessionへの偽装、復旧DBで新規owner |
| 公開読者 | 共有された内容を読む | `/r/:module/:project/:slug`のみ | 非公開原稿/設定/履歴、書込、作者登録 |
| 外部AI/MCP | 許可された作品を参照・解析して提案 | `/mcp`と登録済みtool。**Web画面は不要** | 作者の変更承認/適用、直接persistence、資格情報 |
| 運用者 | 初期VM構築、証明済み更新、特権バックアップ/本番復旧 | 保護済みGitHub Actions/Tailscale SSH/Ansible。**作者用Web UIからはS3保存先の指定・検証・保全要求/結果の参照のみ** | WebにVM/IAM権限や復号秘密鍵を渡すこと、導入キーでSSH認証 |

今回「閲覧者」「初回owner候補」「MCP client」を同じ`user`として扱わない。想定利用者ごとに入口・失敗時の挙動・権限が違う。単一ownerの契約を、未合意の一般編集者・管理者グループへ勝手に拡張しない。

## 全画面カタログとルーティング

画面IDは [情報設計](INFORMATION-ARCHITECTURE.md) の従来カタログと整合させる。特に **WRT-02＝Revision履歴、REV-01＝提案一覧、REV-02＝提案詳細**。CFG-01は表示設定（DISPLAY-01）と本人セキュリティ設定（PREF-01）を束ねる概念的なカテゴリであり、別のデータ正本やURLを作らない。KNO-03の局所グラフは情報設計で検討された**未採用提案**として明示し、実装済みの関係一覧/詳細に見せかけない。


**画面IDは安定した論理識別子。** 【実装】は現行Desktop React Web実装の状態であり、iOS Nativeの実装・受入を意味しない。【目標】は採用済みで未受入。iOSの開発と自動Xcode検証は一時停止中で、実機受入は延期（免除ではない）。旧Mobile Web `/mobile/`/Ionic authoring shellは製品導線から撤去済みで、対応・互換性の約束はない。iOS Nativeの表示は[SwiftUI正本](../architecture/IOS-SWIFTUI-ARCHITECTURE.md)に従い論理IDのみ共通化する。

| 画面ID | 入口・表示形態 | principal | 主タスクと通常の戻り先 | 種別 |
| --- | --- | --- | --- | --- |
| ENTRY-01 | `/` Desktop-only start → `/desktop/` | ANON | Desktop React Webを起動。iOSはnative app entryという採用目標 | 実装 |
| AUTH-01 | `/oauth/login` | 正しいsigned request→OWNER-SESSION | Passkey/連携IdPログイン → AUTH-02／中止→ENTRY | 実装 |
| AUTH-02 | `/oauth/consent` | OWNER-SESSION＋登録済みclient | scopeとclientを確認→許可/拒否→検証済みcallback | 実装 |
| LIB-01 | Desktop Web `/desktop/`・iOS Native Library（旧`/mobile/`廃止） | OWNER-API | 作品を選択/作成/取込/書出→構成・本文 | Desktop実装・iOS未受入 |
| OUT-01 | Desktop構成panel・iOS native Outline | OWNER-API | 巻/章/シーン選択・移動・検索 → 本文 | Desktop実装・iOS未受入 |
| WRT-01 | Desktop Web `/desktop/projects/:projectId/scenes/:documentId`・iOS native navigation target | OWNER-API | 編集、保存、閲覧、根拠、Revision。元の本文へ | Desktop実装・iOS未受入 |
| READ-01 | Desktop reader・iOS native Reader | OWNER-API | 文字組み/縦横/参照→同じRevisionの編集位置へ | Desktop実装・iOS未受入 |
| WRT-02 | WRT-01のRevision履歴・差分 | OWNER-API | 差分表示・履歴復元→元の本文 | 実装 |
| REC-01 | WRT-01の保存状態・競合/回復/失効 | OWNER-API＋browser local journal | 確定状態を照合・復旧→同じ文書 | 実装 |
| KNO-01 | Desktop Knowledge panel・iOS Native Knowledge | OWNER-API | 候補一覧、検索、確定→KNO-02／原稿へ | Desktop実装・iOS未受入 |
| KNO-02 | Knowledge node詳細・Evidence inspector | OWNER-API | Relation/Assertion/Text Anchor/根拠への遷移→元の文書 | 実装 |
| KNO-03 | 選択nodeを中心にした局所関係グラフ/一覧 | OWNER-API（当該projectのreadのみ） | KNO-02から開き、同じnode/元原稿へ戻す | **情報設計の未採用提案**。専用UI/URLは未実装 |
| REV-01 | Desktop ChangeSet/Module proposal・iOS Native Review | OWNER-API | 内容・作者の判断対象を選択 → REV-02 | Desktop実装・iOS未受入 |
| REV-02 | 提案の前後差分・承認/却下/適用 | OWNER-API | receiptを照合し反映された原稿/知識へ | 実装 |
| TOOL-01 | Workspaceの`module:*`可変panel | OWNER-API、MCPは独立tool側 | Moduleのread/compute/proposeと非同期job→同じ作品 | 実装 |
| JOB-01 | ヘッダーの受信箱/ジョブdialog | OWNER-API | 通知とjob確認/既読 → 元の作業 | 実装 |
| DISPLAY-01 | Theme、組版、Workspace配置 | 本人のbrowser UI state | 見た目・レイアウト変更→元の作業。原稿は無変更 | 実装 |
| PREF-01 | Desktop認証dialog→`/console/security`目標・iOS Native設定 | OWNER-SESSION（実APIはowner確認） | Passkey/セッション→元の作業 | Desktop実装・iOS未受入 |
| PUB-01 | `/r/:module/:project/:slug` | SHARE-READER | 許された公開版の読書→公開画面内で終了 | 実装 |
| CON-00 | `/console` | OWNER-SESSION | 認証状況・各管理項目へのハブ | 目標 |
| CON-01 | `/console/setup`開始・登録キー入力 | SETUP | 状態確認、キー認可→CON-02 | 目標 |
| CON-02 | `/console/setup` Passkey ceremony/確認 | SETUP | WebAuthn、owner一意確定→CON-03 | 目標 |
| CON-03 | `/console/setup` client登録と公開待ち | SETUPのread-only状態（本人作成後は本人session） | 準備確認→通常owner login | 目標 |
| CON-10 | `/console/security` Passkey管理 | OWNER-SESSION＋fresh確認 | 追加・改名・削除、現在の認証手段維持→CON-00 | Desktop Web 実装 |
| CON-11 | `/console/security` session管理 | OWNER-SESSION＋fresh確認（操作による） | 他端末終了、全他セッション終了→CON-00 | Desktop Web 実装 |
| CON-20 | `/console/identity` OIDC管理 | OWNER-SESSION＋fresh確認 | issuer/client登録・検証・リンク・有効化/無効化→CON-00 | 運用者設定状態の参照を実装。管理操作は目標 |
| CON-21 | `/console/identity` OAuth client/grants | OWNER-SESSION＋object/scope認可 | クライアント・同意の参照/許可された失効→CON-00 | 保存済み同意の参照を実装。grant失効は目標 |
| CON-30 | `/console/backups` | OWNER-SESSION | S3保存先/適用状態・off-VM保全・復旧検証の状態→各バックアップ画面 | 目標・未実装 |
| CON-31 | `/console/backups/destination` | OWNER-SESSION＋fresh（secret/active変更時） | S3 provider/endpoint/bucket/prefix/credential（write-only）を編集→CON-32 | 目標・未実装 |
| CON-32 | `/console/backups/verification` | OWNER-SESSION＋fresh（activate時） | probe→revision照合→activeの適用結果再取得→CON-30 | 目標・未実装 |
| CON-33 | `/console/backups/history` | OWNER-SESSION | backup run/暗号文receiptと失敗・未確認を表示→CON-30/34 | 目標・未実装 |
| CON-34 | `/console/backups/recovery` | OWNER-SESSIONのread-only | 隔離restore drillの証拠、OPERATOR復旧手順への説明。実本番復元はしない | 目標・未実装 |
| OPS-01 | Webではなくprotected workflow/SSH | OPERATOR | VM構築・更新・**本番**復旧（設計はデプロイ文書に委任）。保管先設定はCON-30〜34のowner UI、実際のhost backup/restoreはprotected executor/operator | 実装/目標分離 |

**iOS採用目標は独立したSwiftUI画面とUIKit/TextKit 2編集面。** Core/API、作品、Revision、receipt/回復契約を共有するがReact/Ionic部品を共有しない。OAuthはsystem authentication、refresh tokenはKeychainに置き、第二原稿DBは作らない。SwiftUI sourceは存在するが、未完了の実装・受入は開発凍結中。Capacitor/Ionic Web authoringは旧実装であり、current iOS SwiftUI appの実装根拠ではない。

## グローバルな状態・離脱ガード

すべての画面は`initializing`、`loading`、`ready`、`empty`、`recoverable-error`、`unauthorized`、`forbidden`、`not-found`を扱う。mutationを行う画面には`submitting`、`unknown-result`、`conflict`、`confirmed`を必要に応じて追加する。**空状態は通信失敗でも権限拒否でもない。**

- 保存/文書/作品切替、読書↔編集、logout、コンソール遷移の前には各クライアント固有の下書き・IME composition guardを通す。守れない場合は遷移を取り消し、その場に本文と明示エラーを残す。
- バック/キャンセルは原則として**元のURL・project・document・cursor・selection・scroll・参照元**を復元する。対象が既に削除・権限失効なら同じ作品の目次/ライブラリへ戻し、理由を明示する。
- 検索、panelの開閉、参照シートの往復は同じRevisionで行い、局所的なUI状態を失わない。古いnetwork応答はnavigation generationで破棄する。
- **保存済み**の表示条件はDBのidempotent receiptと対応する端末固有journal確定。保存要求送信後の入力は先のreceiptに含めない。競合を自動merge・上書きしない。
- destructive操作は対象名/件数/差分/戻し方、fresh verification、明示的な確認、double submit防止を必要とする。単なるtoast成功ではなく実状態を再取得して表示する。
- optional moduleが無効・読み込めない場合はTOOL-01だけを部分停止させ、原稿WRT-01を利用可能にする。Moduleはreader/compute/proposeの上限とserver approval境界を維持する。

## コントロール・導線台帳（ボタン・フォーム単位）

以下の`CTRL` IDは受入時にテスト名やスクリーンショットへ結合する。`method`は**意味上の最小操作**であり、UI固有のサーバー実装がない表示操作は`LOCAL`。すべてのAPI操作は [route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md) をさらに満たす。

| CTRL / 入口 | ラベル・トリガー | 前提・権限 | 正常遷移 | エラー・取消時の復帰 |
| --- | --- | --- | --- | --- |
| ENTRY-01.A | Desktop Webを起動 | ANON/LOCAL | `/desktop/`へ移動。iOSはNative app entry | 選択状態保存へ依存しない |
| AUTH-01.A | Passkeyでサインイン | signed OAuth request、WebAuthn | Better Auth session→AUTH-02 | cancel/UV失敗はログインのまま、鍵は残さない |
| AUTH-01.B | 外部IdPでサインイン | ownerがリンクしたactive IdP | issuer/sub確認→AUTH-02 | 未リンク・認証失敗はowner作成なし |
| AUTH-02.A | 許可して続ける | client/redirect/scope確認、OWNER-SESSION | 認可コード→登録済みcallback | 不明scopeならdisabled、grantなし |
| AUTH-02.B | 拒否して戻る | valid OAuth request | 拒否結果を登録済みredirectへ | tokenを発行しない |
| LIB-01.A | 作品を開く・最近の作業に戻る | OWNER-API、projectID一致 | OUT-01/WRT-01 | 不在/別作品/ネットワーク失敗をempty扱いしない |
| LIB-01.B | 作品を作成 | OWNER-API、`POST /api/v1/persistence/projects` | 新作品の構成に遷移 | 結果不明は同じprojectIDで再照合 |
| LIB-01.C | 作品JSONをインポート | OWNER-API、`POST /api/v1/persistence/import`、schema/hash検証 | 新project選択。既存projectは不変 | 無効JSON、重複、partialは元画面 |
| LIB-01.D | 作品JSONをエクスポート | OWNER-API、`GET …/archive`、固定snapshot | 読取だけ、保存場所はブラウザー | データ不完全なら成功ファイルを装わない |
| LIB-01.E | 離脱用 ZIP をダウンロード | OWNER-API、`GET …/open-export`、操作開始時の作品 ID と固定スナップショット | 全バイト受信後に保存用の ZIP をブラウザーに渡す | 中断、期限超過、容量超過、データ欠損は受信完了にしない。[離脱用 ZIP の実装契約](../architecture/OPEN-WORK-EXPORT-CONTRACT.md) |
| OUT-01.A | 構成検索・展開・ズーム | OWNER-APIで一覧取得後LOCAL | 同じprojectの構成を表示 | フィルター変更で本文を破棄しない |
| OUT-01.B | 文書・シーンを選択 | OWNER-API、project/document scope、transition guard | WRT-01、選択位置 | guard失敗/404は元編集を保持 |
| OUT-01.C | 巻・章・シーンを追加 | OWNER-API、`POST …/documents`、親とidempotency | 新文書を開く | concurrent parent/invalid kindはエラー |
| OUT-01.D | 名前・親・順序を変更 | OWNER-API、`PATCH …/metadata`、expectedVersion | 最新構成を再取得 | 循環/別project/staleは拒否 |
| OUT-01.E | 文書を削除 | OWNER-API、`DELETE …/documents/:id`、明示確認 | 歴史を保持し一覧へ | guard/拒否/同時変更は現状態を維持 |
| WRT-01.A | 保存 | OWNER-API、`PATCH …/documents/:id`、baseRevision+idempotency | receiptを確認して「保存済み」 | 409/412/response不明はREC-01へ |
| WRT-01.B | 読む/編集へ戻る | LOCAL、IMEとdraft guard | READ-01⇄WRT-01、同じ原稿 | guard失敗なら切替えない |
| WRT-01.C | 選択範囲をText Anchor化 | OWNER-API、確定Revision、選択UTF-16とquote hash | KNO-02の根拠へ | dirty/stale/位置不明は無効化 |
| WRT-01.D | 書式記号・組版・文字サイズ | LOCAL、CodeMirrorと表示state | editor保持／表示のみ変更 | IME/カーソルを奪わない |
| WRT-02.A | Revision履歴と差分 | OWNER-API、`GET …/revisions` | 比較のみ、本文は無変更 | 取得不可なら再試行。Draftは消さない |
| WRT-02.B | このRevisionを復元 | OWNER-API、`POST …/restore`、base/冪等、明示確認 | 新immutable RevisionとしてWRT-01へ | 競合時に現在原稿を上書きしない |
| REC-01.A | 下書きを再保護 | LOCAL IndexedDB、原稿/author同一性 | journal再確認→WRT-01 | quota/write失敗を黙って消さない |
| REC-01.B | 応答不明を再確認 | OWNER-API、同じoperation/receipt | 確定なら「保存済み」 | timeout時に別IDで重複保存しない |
| REC-01.C | 競合を比較して解決 | OWNER-API、明示選択した版 | 差分を示した上で新save | 「回復Draftを破棄」は追加確認が必要 |
| KNO-01.A | 検索・絞り込み・追加読込 | OWNER-API、`GET …/nodes` | 同じproject snapshotの一覧 | 古いカーソルや応答を混ぜない |
| KNO-01.B | Knowledge候補を保存/確定 | OWNER-API、`PUT …/nodes/:id`、version | KNO-02・同じノード | 失敗/応答不明は同一IDを照合 |
| KNO-02.A | Evidence/Anchorを開く | OWNER-API、Revision一致と対象project | 原稿の該当引用へ。戻り先保持 | orphan/staleなら位置再確認へ |
| KNO-02.B | Link・Relation・Assertionを変更 | OWNER-API、version/confirmed anchor | KNO-02を再取得 | confirmedを推測せず競合として扱う |
| KNO-02.C | Knowledgeを統合 | OWNER-API、previewDigest+projectVersion+confirm | 影響/receipt表示 | preview古さ、競合、未確認は適用不可 |
| KNO-03.A | （提案）関係グラフ/一覧へ切替・対象nodeを選択 | OWNER-APIの同一project readのみ。新規mutationなし | KNO-02の選択node・原稿への復帰文脈を保持 | 現時点では未実装。存在しないグラフを表示済みとしない |
| REV-01.A | 提案/ChangeSetを開く | OWNER-API、read-set対象の認可 | REV-02、元のproject保持 | stale/欠損を成功として扱わない |
| REV-02.A | 承認・却下・適用 | OWNER-APIだけ。ChangeSet versionと状態 | receipt後に反映文書/知識へ | MCPに渡さず、staleや未承認を拒否 |
| REV-02.B | Module提案を一覧から隠す | LOCAL、ブラウザーjournal | 一覧表示だけ変更 | **サーバー上の却下ではない**と示す |
| TOOL-01.A | 分析/外部module actionを起動 | OWNER-API、宣言されたeffect+module availability | 局所結果またはJOB-01へ | 未導入/失敗はCore執筆へ波及させない |
| JOB-01.A | job/通知を読む・再取得・既読 | OWNER-API、`/api/jobs*`/`/api/inbox*` | dialog内状態更新、元の作業維持 | stream失敗はpoll/retry、既読成功を偽装しない |
| DISPLAY-01.A | Theme・layout・組版 | LOCAL、author/device classの表示設定 | 同じ原稿・位置 | 保存設定の失敗を通知、原稿無変更 |
| PREF-01.A | セキュリティ設定を開く | OWNER-SESSION、API owner確認 | dialog/settingsまたはCON-10 | session変化で下書きを守る |
| PUB-01.A | 公開版を読む・テーマ変更 | SHARE-READER、GETのみ | 公開版のまま表示 | 失効/不明scopeでprivate APIへ遷移しない |
| CON-00.A | セキュリティ・連携先を選択 | OWNER-SESSION | CON-10/CON-20 | 401なら再認証、403なら拒否 |
| CON-01.A | 初期登録キーを検証 | SETUP、NEW_APPROVED＋短命transaction | CON-02 | expired/rate-limit/復旧中なら登録不可 |
| CON-02.A | Passkeyを作る | SETUP、WebAuthn challenge/UV、単一ownerDB制約 | 原子的確定→CON-03 | cancel/競合/応答不明はowner再生成せず照合 |
| CON-03.A | 状態更新/通常ログイン | SETUP結果readまたはOWNER-SESSION | owner確定後AUTH-01→CON-00 | 本番公開失敗時も再初期化しない |
| CON-10.A | Passkey追加・改名・削除 | OWNER-SESSION＋fresh、別の利用可能手段維持 | 同じ一覧を再取得 | 最後の手段削除・UV失敗は拒否 |
| CON-11.A | 他セッション終了 | OWNER-SESSION＋対象確認 | 最新session一覧を再取得 | 自分の現在session個別終了は無効 |
| CON-20.A | OIDC登録/検証/有効化 | OWNER-SESSION＋fresh、issuer/sub不変 | verified owner linkを保持 | 未検証providerをactiveにしない |
| CON-21.A | OAuth client/grantを確認・revoke | OWNER-SESSION、owner＋client/scope対象 | revoke receipt/状態再取得 | 既存access JWTの有効性をlogoutだけで偽らない |
| CON-00.B | バックアップ管理へ | OWNER-SESSION。保管先変更の権限とは別 | CON-30へ | 401/403時は認証・拒否表示。元のdraftは保持 |
| CON-30.A | 現在の保管先・保全状態を更新 | `GET /api/console/backups/status`、OWNER-SESSION | 設定/検証/DR証拠を区別してCON-30 | API未到達ならUNKNOWN、成功とみなさない |
| CON-30.B | 手動バックアップを要求 | `POST /api/console/backups/runs`、OWNER-SESSION＋fresh、停止の影響・確認 | 202＋run IDを保存しCON-33へ | 既存runを二重生成しない。停止・拒否・不明を区別 |
| CON-31.A | S3設定案を保存 | `PUT /api/console/backups/config/draft`、If-Match、secretはwrite-only | 設定revision取得→CON-32 | 412/422なら同じ入力を保持、秘密値を再表示しない |
| CON-32.A | S3接続検証 | `POST /api/console/backups/config/probes`、draft revision | probe IDで状態を再取得、結果がPASSEDならactivateへ | probe失敗や応答不明を保全済みにしない |
| CON-32.B | 検証済み設定を有効化 | `POST /api/console/backups/config/activate`、OWNER-SESSION＋fresh＋同一revisionのPASSED probe | 202後はoperation結果再取得→ACTIVE後CON-30 | 202をACTIVEと誤表示しない。stale/失効probeを拒否 |
| CON-30.C | S3設定を無効化 | `POST /api/console/backups/config/disable`、fresh＋影響確認 | サーバー確定後CON-30、保全済み遠隔objectは削除しない | requiredに代替が無いなら拒否、DR保証を偽装しない |
| CON-33.A | backup runとreceiptを開く | `GET /api/console/backups/runs`と`GET .../runs/:id`、OWNER-SESSION | 同じrun IDの状態と暗号文receiptを表示 | UNKNOWN/FAILED/接続断を成功扱いしない |
| CON-34.A | 独立restore証拠を表示 | `GET /api/console/backups/recovery`、OWNER-SESSION | 証拠と保護された運用手順を表示 | 実本番restore/SSH/Ansibleを実行しない |
| OPS-01.A | デプロイ/復旧を承認・実行 | OPERATOR、別管理planeと署名ではない証明書/backup | 保護されたworkflowの結果へ | Webのボタンに実装しない |

## 画面ごとの操作優先順位・視覚表示

| 画面群 | 主要CTA | 補助操作 | 危険操作の取り扱い |
| --- | --- | --- | --- |
| Entry/OAuth | 明示選択、Passkeyサインイン、認可判断 | 戻る・IdPサインイン | client/scope/redirectを事前表示。拒否しやすく |
| 作品/構成 | 続きを書く、作品を開く、文書を作成 | 検索・インポート・エクスポート | 削除は別セクション＋確認、即クリック削除を禁止 |
| 執筆/読書 | 本文の入力・保存 | 参照・履歴・組版 | recovery/競合は原稿より優先しないが消せない警告 |
| Knowledge/Review | 対象の根拠・差分確認 | フィルター、局所関係、履歴 | 「承認」と「適用」を分け、影響・revisionを示す |
| Console setup | キー確認→Passkey作成→状態確認 | 説明・再試行・登録中断 | キーの平文再表示、成功未確認でowner作成を再実行しない |
| Console security | 追加/確認/セッション終了 | 名称変更・一覧再取得 | 最後の認証器削除不可、fresh proofと結果照合 |
| Console identity | provider検証・client同意確認 | 設定の説明 | 未検証のissuer/subjectをactiveにしない |
| Console backups | S3保存先の設定→probe→再認証→有効化 | 暗号化保全点/独立DR証拠とrun履歴の参照 | secretの再表示、未確認202の成功化、公開API経由の本番復元、保全object削除を禁止 |

## 状態ごとのUIルール（商用品質の受入基準）

| 状態 | 表示・操作 | 禁止 |
| --- | --- | --- |
| loading/initializing | 対象のheader・骨格を固定。キャンセル可能な操作は保持 | loading中に「データなし」「認証成功」と表示 |
| empty | 「作品がない」「文書未選択」など原因別の開始CTA | DB/403/timeoutをempty扱い |
| submitting | 一つのmutationを二重送信できない。進捗・Cancelの意味を明記 | operation IDを変えて自動retry |
| unauthorized | 保存/未確定draftを保持し、安全な再認証 | local draft消去、無条件に別userへ切替 |
| forbidden | 権限の不足を簡潔に提示し、元の画面へ | 一時的にローカルでroleを上げる |
| not-found | 対象の存在を断定せず、safe fallback | 他projectのタイトルやmetadataを表示 |
| conflict | 自分のtextと確定DB版と差分・対象IDを表示 | 自動上書き/黙ったmerge |
| unknown-result | immutable operation/receiptを照合する導線 | duplicate save/grant consumption |
| lost connectivity | recoverable local内容と「サーバー未保存」を区別 | Offlineを正本同期済みと偽装 |
| unimplemented target | 画面やAPIが存在しない間は明示的に未提供 | 偽ボタン、静的モックで認可成功と表示 |

Desktop Webのキーボード/スクリーンリーダー/zoom/IMEと、iOS NativeのVoiceOver/Dynamic Type/Touch/IMEを**別々に**検証する。Mobile React 320px専用E2Eは対象外。modalやsheetを閉じたら発火したボタンへフォーカスを戻す。save status、本人認証、進捗、失敗は色だけに依存せず`aria-live`の過剰通知を避ける。各画面のPC/Mobile視覚基準は [UX contract](UX-CONTRACT.md) に従う。

## E2E受入トレーサビリティ

本書の各CTRL IDについて、最低限 **(A) 未認証/不適切principal、(B)正常、(C)入力不正、(D)stale・競合、(E)通信断/応答不明、(F)離脱/戻る、(G)キーボード/モバイル** を分類して記録する。すべての画面を単一E2Eへ詰めず、principal・session・project・revision・operation receiptの実値を証拠とする。

受入時に控えるのは `screen ID / control ID / URL / principal / request(method,path) / outcome HTTP / DB結果 / screenshot / source SHA`。**CON-30〜34ではさらにbackup configuration revision、probe/run/receipt IDと遠隔保全・独立restoreの異なる合否を記録する。**目標画面は実装前なら`NOT_IMPLEMENTED`と記録し、モックの成功をPASSにしない。操作フローの正本は [Screen State Atlas](SCREEN-STATE-ATLAS.md) で更新する。
