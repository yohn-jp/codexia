# Codexia 画面・コントロール・ユーザージャーニー設計

**種別: 規範的UI/UX設計。** 本書はすべての論理画面・モーダル/シート・操作コントロールについて、ユーザー、入口、状態、ボタン、APIに要求する権限、成功後の遷移、失敗時の復帰を確定する。実際のURLとprincipalの正本は [URL/API認可設計](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)、図の正本は [画面状態遷移図](SCREEN-STATE-ATLAS.md)、保存は [Interaction contract](INTERACTION-CONTRACT.md)。**コードは実装状況の照合資料であり、デザイン決定のauthorityではない。**

## 想定利用者と許可の最小化

| 利用者 | 目的 | 許可する作業面 | 絶対に到達させない操作 |
| --- | --- | --- | --- |
| 作者（owner） | 続きを書く、構成・知識・提案の管理、公開、認証器管理 | Desktop/Mobile/iOS、OAuth、本人管理`/console`目標 | 管理画面からVM・SSH・DB credentialへ直接アクセス |
| 初回所有者（未登録） | 新規構築されたサービスで最初のPasskeyを登録 | `/console/setup` **目標のみ** | 作品の閲覧/編集、owner sessionへの偽装、復旧DBで新規owner |
| 公開読者 | 共有された内容を読む | `/r/:module/:project/:slug`のみ | 非公開原稿/設定/履歴、書込、作者登録 |
| 外部AI/MCP | 許可された作品を参照・解析して提案 | `/mcp`と登録済みtool。**Web画面は不要** | 作者の変更承認/適用、直接persistence、資格情報 |
| 運用者 | 初期VM構築、証明済み更新、バックアップ/復旧 | 保護済みGitHub Actions/Tailscale SSH/Ansible。**作者用Web UIではない** | ブラウザー上で機微secretを配布、導入キーでSSH認証 |

今回「閲覧者」「初回owner候補」「MCP client」を同じ`user`として扱わない。想定利用者ごとに入口・失敗時の挙動・権限が違う。単一ownerの契約を、未合意の一般編集者・管理者グループへ勝手に拡張しない。

## 全画面カタログとルーティング

**画面IDは安定した論理識別子。** 【実装】は現行mainの機能／【目標】は採用済み仕様だが専用画面やAPIの受入が未完了。shell内パネルに独立URLを強制しない。

| 画面ID | 入口・表示形態 | principal | 主タスクと通常の戻り先 | 種別 |
| --- | --- | --- | --- | --- |
| ENTRY-01 | `/` | ANON | Desktop/Mobileの選択 → 同じoriginの明示shell | 実装 |
| AUTH-01 | `/oauth/login` | 正しいsigned request→OWNER-SESSION | Passkey/連携IdPログイン → AUTH-02／中止→ENTRY | 実装 |
| AUTH-02 | `/oauth/consent` | OWNER-SESSION＋登録済みclient | scopeとclientを確認→許可/拒否→検証済みcallback | 実装 |
| LIB-01 | `/desktop/`・`/mobile/?view=library`、`/projects/:id` | OWNER-API | 作品を選択/作成/取込/書出→構成・本文 | 実装 |
| OUT-01 | 同じshellの構成panel・Mobile参照sheet | OWNER-API | 巻/章/シーン選択・移動・検索 → 本文 | 実装 |
| WRT-01 | `/<shell>/projects/:projectId/scenes/:documentId` | OWNER-API | 編集、保存、閲覧、根拠、Revision。元の本文へ | 実装 |
| READ-01 | WRT-01の読書表示、Mobileページャー | OWNER-API | 文字組み/縦横/参照→同じRevisionの編集位置へ | 実装 |
| REV-01 | WRT-01のRevision履歴・差分 | OWNER-API | 差分表示・履歴復元→元の本文 | 実装 |
| REC-01 | WRT-01の保存状態・競合/回復/失効 | OWNER-API＋browser local journal | 確定状態を照合・復旧→同じ文書 | 実装 |
| KNO-01 | Desktop Knowledge panel / Mobile `view=inspection` | OWNER-API | 候補一覧、検索、確定→KNO-02／原稿へ | 実装 |
| KNO-02 | Knowledge node詳細・Evidence inspector | OWNER-API | Relation/Assertion/Text Anchor/根拠への遷移→元の文書 | 実装 |
| REVIEW-01 | Native ChangeSet・Module proposal一覧 / Mobile `view=tools` | OWNER-API | 内容・作者の判断対象を選択 → REVIEW-02 | 実装 |
| REVIEW-02 | 提案の前後差分・承認/却下/適用 | OWNER-API | receiptを照合し反映された原稿/知識へ | 実装 |
| TOOL-01 | Workspaceの`module:*`可変panel | OWNER-API、MCPは独立tool側 | Moduleのread/compute/proposeと非同期job→同じ作品 | 実装 |
| JOB-01 | ヘッダーの受信箱/ジョブdialog | OWNER-API | 通知とjob確認/既読 → 元の作業 | 実装 |
| DISPLAY-01 | Theme、組版、Workspace配置 | 本人のbrowser UI state | 見た目・レイアウト変更→元の作業。原稿は無変更 | 実装 |
| PREF-01 | Desktop認証dialog、Mobile`view=settings` | OWNER-SESSION（実APIはowner確認） | Passkey/セッション→元の作業 | 実装 |
| PUB-01 | `/r/:module/:project/:slug` | SHARE-READER | 許された公開版の読書→公開画面内で終了 | 実装 |
| CON-00 | `/console` | OWNER-SESSION | 認証状況・各管理項目へのハブ | 目標 |
| CON-01 | `/console/setup`開始・登録キー入力 | SETUP | 状態確認、キー認可→CON-02 | 目標 |
| CON-02 | `/console/setup` Passkey ceremony/確認 | SETUP | WebAuthn、owner一意確定→CON-03 | 目標 |
| CON-03 | `/console/setup` client登録と公開待ち | SETUPのread-only状態（本人作成後は本人session） | 準備確認→通常owner login | 目標 |
| CON-10 | `/console/security` Passkey管理 | OWNER-SESSION＋fresh確認 | 追加・改名・削除、現在の認証手段維持→CON-00 | 目標 |
| CON-11 | `/console/security` session管理 | OWNER-SESSION＋fresh確認（操作による） | 他端末終了、全他セッション終了→CON-00 | 目標 |
| CON-20 | `/console/identity` OIDC管理 | OWNER-SESSION＋fresh確認 | issuer/client登録・検証・リンク・有効化/無効化→CON-00 | 目標 |
| CON-21 | `/console/identity` OAuth client/grants | OWNER-SESSION＋object/scope認可 | クライアント・同意の参照/許可された失効→CON-00 | 目標 |
| OPS-01 | Webではなくprotected workflow/SSH | OPERATOR | VM構築・更新・復旧（設計はデプロイ文書に委任） | 実装/目標分離 |

**インストール版iOS**はMobileの同じ文章・作品/Revision/回復契約を共有し、OAuthはsystem browser、token storageはKeychain。`capacitor://localhost`内で既存Webを読み直すだけでは認証が成立しない。別の原稿DBやSwiftUI画面を設けない。

## グローバルな状態・離脱ガード

すべての画面は`initializing`、`loading`、`ready`、`empty`、`recoverable-error`、`unauthorized`、`forbidden`、`not-found`を扱う。mutationを行う画面には`submitting`、`unknown-result`、`conflict`、`confirmed`を必要に応じて追加する。**空状態は通信失敗でも権限拒否でもない。**

- 保存/文書/作品切替、読書↔編集、Desktop↔Mobile、logout、コンソール遷移の前には共有の下書き・IME composition guardを通す。守れない場合は遷移を取り消し、その場に本文と明示エラーを残す。
- バック/キャンセルは原則として**元のURL・project・document・cursor・selection・scroll・参照元**を復元する。対象が既に削除・権限失効なら同じ作品の目次/ライブラリへ戻し、理由を明示する。
- 検索、panelの開閉、参照シートの往復は同じRevisionで行い、局所的なUI状態を失わない。古いnetwork応答はnavigation generationで破棄する。
- **保存済み**の表示条件はDBのidempotent receiptと対応するbrowser journal確定。保存要求送信後の入力は先のreceiptに含めない。競合を自動merge・上書きしない。
- destructive操作は対象名/件数/差分/戻し方、fresh verification、明示的な確認、double submit防止を必要とする。単なるtoast成功ではなく実状態を再取得して表示する。
- optional moduleが無効・読み込めない場合はTOOL-01だけを部分停止させ、原稿WRT-01を利用可能にする。Moduleはreader/compute/proposeの上限とserver approval境界を維持する。

## コントロール・導線台帳（ボタン・フォーム単位）

以下の`CTRL` IDは受入時にテスト名やスクリーンショットへ結合する。`method`は**意味上の最小操作**であり、UI固有のサーバー実装がない表示操作は`LOCAL`。すべてのAPI操作は [route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md) をさらに満たす。

| CTRL / 入口 | ラベル・トリガー | 前提・権限 | 正常遷移 | エラー・取消時の復帰 |
| --- | --- | --- | --- | --- |
| ENTRY-01.A | Desktop/Mobileを選択 | ANON/LOCAL | 選択した`/desktop`/`/mobile`、明示選択を記憶 | storage拒否でも選択できる |
| AUTH-01.A | Passkeyでサインイン | signed OAuth request、WebAuthn | Better Auth session→AUTH-02 | cancel/UV失敗はログインのまま、鍵は残さない |
| AUTH-01.B | 外部IdPでサインイン | ownerがリンクしたactive IdP | issuer/sub確認→AUTH-02 | 未リンク・認証失敗はowner作成なし |
| AUTH-02.A | 許可して続ける | client/redirect/scope確認、OWNER-SESSION | 認可コード→登録済みcallback | 不明scopeならdisabled、grantなし |
| AUTH-02.B | 拒否して戻る | valid OAuth request | 拒否結果を登録済みredirectへ | tokenを発行しない |
| LIB-01.A | 作品を開く・最近の作業に戻る | OWNER-API、projectID一致 | OUT-01/WRT-01 | 不在/別作品/ネットワーク失敗をempty扱いしない |
| LIB-01.B | 作品を作成 | OWNER-API、`POST /api/v1/persistence/projects` | 新作品の構成に遷移 | 結果不明は同じprojectIDで再照合 |
| LIB-01.C | 作品JSONをインポート | OWNER-API、`POST /api/v1/persistence/import`、schema/hash検証 | 新project選択。既存projectは不変 | 無効JSON、重複、partialは元画面 |
| LIB-01.D | 作品JSONをエクスポート | OWNER-API、`GET …/archive`、固定snapshot | 読取だけ、保存場所はブラウザー | データ不完全なら成功ファイルを装わない |
| OUT-01.A | 構成検索・展開・ズーム | OWNER-APIで一覧取得後LOCAL | 同じprojectの構成を表示 | フィルター変更で本文を破棄しない |
| OUT-01.B | 文書・シーンを選択 | OWNER-API、project/document scope、transition guard | WRT-01、選択位置 | guard失敗/404は元編集を保持 |
| OUT-01.C | 巻・章・シーンを追加 | OWNER-API、`POST …/documents`、親とidempotency | 新文書を開く | concurrent parent/invalid kindはエラー |
| OUT-01.D | 名前・親・順序を変更 | OWNER-API、`PATCH …/metadata`、expectedVersion | 最新構成を再取得 | 循環/別project/staleは拒否 |
| OUT-01.E | 文書を削除 | OWNER-API、`DELETE …/documents/:id`、明示確認 | 歴史を保持し一覧へ | guard/拒否/同時変更は現状態を維持 |
| WRT-01.A | 保存 | OWNER-API、`PATCH …/documents/:id`、baseRevision+idempotency | receiptを確認して「保存済み」 | 409/412/response不明はREC-01へ |
| WRT-01.B | 読む/編集へ戻る | LOCAL、IMEとdraft guard | READ-01⇄WRT-01、同じ原稿 | guard失敗なら切替えない |
| WRT-01.C | 選択範囲をText Anchor化 | OWNER-API、確定Revision、選択UTF-16とquote hash | KNO-02の根拠へ | dirty/stale/位置不明は無効化 |
| WRT-01.D | 書式記号・組版・文字サイズ | LOCAL、CodeMirrorと表示state | editor保持／表示のみ変更 | IME/カーソルを奪わない |
| REV-01.A | Revision履歴と差分 | OWNER-API、`GET …/revisions` | 比較のみ、本文は無変更 | 取得不可なら再試行。Draftは消さない |
| REV-01.B | このRevisionを復元 | OWNER-API、`POST …/restore`、base/冪等、明示確認 | 新immutable RevisionとしてWRT-01へ | 競合時に現在原稿を上書きしない |
| REC-01.A | 下書きを再保護 | LOCAL IndexedDB、原稿/author同一性 | journal再確認→WRT-01 | quota/write失敗を黙って消さない |
| REC-01.B | 応答不明を再確認 | OWNER-API、同じoperation/receipt | 確定なら「保存済み」 | timeout時に別IDで重複保存しない |
| REC-01.C | 競合を比較して解決 | OWNER-API、明示選択した版 | 差分を示した上で新save | 「回復Draftを破棄」は追加確認が必要 |
| KNO-01.A | 検索・絞り込み・追加読込 | OWNER-API、`GET …/nodes` | 同じproject snapshotの一覧 | 古いカーソルや応答を混ぜない |
| KNO-01.B | Knowledge候補を保存/確定 | OWNER-API、`PUT …/nodes/:id`、version | KNO-02・同じノード | 失敗/応答不明は同一IDを照合 |
| KNO-02.A | Evidence/Anchorを開く | OWNER-API、Revision一致と対象project | 原稿の該当引用へ。戻り先保持 | orphan/staleなら位置再確認へ |
| KNO-02.B | Link・Relation・Assertionを変更 | OWNER-API、version/confirmed anchor | KNO-02を再取得 | confirmedを推測せず競合として扱う |
| KNO-02.C | Knowledgeを統合 | OWNER-API、previewDigest+projectVersion+confirm | 影響/receipt表示 | preview古さ、競合、未確認は適用不可 |
| REVIEW-01.A | 提案/ChangeSetを開く | OWNER-API、read-set対象の認可 | REVIEW-02、元のproject保持 | stale/欠損を成功として扱わない |
| REVIEW-02.A | 承認・却下・適用 | OWNER-APIだけ。ChangeSet versionと状態 | receipt後に反映文書/知識へ | MCPに渡さず、staleや未承認を拒否 |
| REVIEW-02.B | Module提案を一覧から隠す | LOCAL、ブラウザーjournal | 一覧表示だけ変更 | **サーバー上の却下ではない**と示す |
| TOOL-01.A | 分析/外部module actionを起動 | OWNER-API、宣言されたeffect+module availability | 局所結果またはJOB-01へ | 未導入/失敗はCore執筆へ波及させない |
| JOB-01.A | job/通知を読む・再取得・既読 | OWNER-API、`/api/jobs*`/`/api/inbox*` | dialog内状態更新、元の作業維持 | stream失敗はpoll/retry、既読成功を偽装しない |
| DISPLAY-01.A | Theme・layout・組版 | LOCAL、author/device classの表示設定 | 同じ原稿・位置 | 保存設定の失敗を通知、原稿無変更 |
| PREF-01.A | セキュリティ設定を開く | OWNER-SESSION、API owner確認 | 現行dialog/settings、目標はCON-10 | session変化で下書きを守る |
| PUB-01.A | 公開版を読む・テーマ変更 | SHARE-READER、GETのみ | 公開版のまま表示 | 失効/不明scopeでprivate APIへ遷移しない |
| CON-00.A | セキュリティ・連携先を選択 | OWNER-SESSION | CON-10/CON-20 | 401なら再認証、403なら拒否 |
| CON-01.A | 初期登録キーを検証 | SETUP、NEW_APPROVED＋短命transaction | CON-02 | expired/rate-limit/復旧中なら登録不可 |
| CON-02.A | Passkeyを作る | SETUP、WebAuthn challenge/UV、単一ownerDB制約 | 原子的確定→CON-03 | cancel/競合/応答不明はowner再生成せず照合 |
| CON-03.A | 状態更新/通常ログイン | SETUP結果readまたはOWNER-SESSION | owner確定後AUTH-01→CON-00 | 本番公開失敗時も再初期化しない |
| CON-10.A | Passkey追加・改名・削除 | OWNER-SESSION＋fresh、別の利用可能手段維持 | 同じ一覧を再取得 | 最後の手段削除・UV失敗は拒否 |
| CON-11.A | 他セッション終了 | OWNER-SESSION＋対象確認 | 最新session一覧を再取得 | 自分の現在session個別終了は無効 |
| CON-20.A | OIDC登録/検証/有効化 | OWNER-SESSION＋fresh、issuer/sub不変 | verified owner linkを保持 | 未検証providerをactiveにしない |
| CON-21.A | OAuth client/grantを確認・revoke | OWNER-SESSION、owner＋client/scope対象 | revoke receipt/状態再取得 | 既存access JWTの有効性をlogoutだけで偽らない |
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

キーボードのみ・スクリーンリーダー・200%拡大・320CSS px・IME・Touch・WebKit/iOSで操作の順序と戻り先が成立すること。modalやsheetを閉じたら発火したボタンへフォーカスを戻す。save status、本人認証、進捗、失敗は色だけに依存せず`aria-live`の過剰通知を避ける。各画面のPC/Mobile視覚基準は [UX contract](UX-CONTRACT.md) に従う。

## E2E受入トレーサビリティ

本書の各CTRL IDについて、最低限 **(A) 未認証/不適切principal、(B)正常、(C)入力不正、(D)stale・競合、(E)通信断/応答不明、(F)離脱/戻る、(G)キーボード/モバイル** を分類して記録する。すべての画面を単一E2Eへ詰めず、principal・session・project・revision・operation receiptの実値を証拠とする。

受入時に控えるのは `screen ID / control ID / URL / principal / request(method,path) / outcome HTTP / DB結果 / screenshot / source SHA`。目標画面は実装前なら`NOT_IMPLEMENTED`と記録し、モックの成功をPASSにしない。操作フローの正本は [Screen State Atlas](SCREEN-STATE-ATLAS.md) で更新する。
