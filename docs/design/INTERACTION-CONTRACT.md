# Codexia — 操作・状態・復旧の詳細設計

## 位置付け

[UX contract](UX-CONTRACT.md) の状態・遷移を具体化する設計提案。画面上の言葉や状態表示を整理するが、保存、認可、提案、正本を決める既存のCore／API／journalの契約が優先される。新たな保存プロトコルやデータ正本を導入しない。

## 状態表示の決定表

対象のdocumentとgenerationに紐づく `ActiveDocument`、pending operation、journal、DB receiptが権威である。単一の「成功／失敗」boolや通信状態から本文の保存状態を作らない。

| 観測できる条件 | 主表示 | 詳細・許可する行動 |
| --- | --- | --- |
| 初期取得または回復照合中 | 原稿を確認中 | 読取対象、照合中であること。照合完了前に編集可を偽装しない |
| dirtyかつrecovery=pending | 入力を保護中 | 現在の入力はまだブラウザに確定していない。離脱にはguard |
| dirtyかつrecovery=stored、DB要求なし | 下書き | この端末・ブラウザに保護、DB未反映。通常保存へ |
| save=saving、対象generationと入力が一致 | 保存中 | 送信対象の本文は保護済み。receipt待ち |
| save=saving、後続入力あり | 保存中・新しい入力あり | 送信した版と後続入力のjournal状態を区別。後続入力をDB済みにしない |
| dirty=false、save=saved、recovery=stored、競合／不明なし | 保存済み | 確定Revisionと照合済みjournalを示す |
| remoteConflictあり | 競合・比較が必要 | ブラウザの下書きとDB最新版を保持。比較し明示的な選択 |
| recovery=failed | 下書き保護に失敗 | 今の入力が失われるリスク。無関係な遷移をguardで止め、保護を再試行 |
| recovery=other-tab | 別タブの下書きを確認 | 他tabの記録を上書きせず、最新の回復状態を確認 |
| DB応答失敗／不明 | 保存結果を要確認 | 確定できた保護範囲。既存operationを照合。同一operationの再試行のみ |
| API認証失効／権限拒否 | 認証が必要／編集権限なし | 最新の入力を保護したうえで認証を再確認。権限を緩めない |

同じ条件で競合と保存中などが重なるときは、対処が必要な状態を主表示にし、副状態を詳細に残す。現在の `desktopDurabilityFor` / `desktopDurabilityDetail` は4種の表示を返す。変更は既存stateから上の表示を導出する責務に限り、同じ意味の別state machineをUIだけで作らない。

### 通常保存・再開

```text
入力 → journal記録中 → 下書き保護済み → DB保存要求 → receipt照合
  ↘ 後続入力（独立generation）                 ↘ 応答不明 → 同一操作照合
                     ↘ 失敗／競合 → 保護状態と比較・回復
```

通常の自動保存（現在はjournal記録後900msの遅延）と明示保存のauthorityを共有する。遅延変更は別途性能測定に基づく。UIがタイマー経過から保存成功を作らない。通信が切れても、権限と保護条件が確認できる範囲の編集は既存契約に従い、完全offline同期を約束しない。

## 操作の共通シーケンス

| 操作 | 許可と開始 | 待機・完了 | 失敗・戻り先 |
| --- | --- | --- | --- |
| 起動・直接リンク | version、session、persistence、対象取得と回復照合 | 表示可能な情報を先に出す。照合後に編集可 | SSO時に独自トークンフォームを出さない。API不明、権限、DB不良を区別 |
| 同一原稿の一時参照 | 既存guardで必要なjournal保護 | sheet/panel表示、editor状態を保持 | guard拒否ならその場に理由、元の入力とfocus |
| 別文書・別作品 | author/project/document、navigation generation、guard | 正規ルートの対象が確定したら遷移 | 遅延・古い応答を破棄、入力を保持 |
| 構成変更 | stable ID、expectedVersion、必要な確認、guard | APIの結果から構成を更新 | 競合時は最新状態、対象行とフォーム保持 |
| 保存 | dirty、回復記録、base revision、operation ID | receiptとjournalの対応、後続入力は別 | 既存pending操作を照合、勝手な再実行なし |
| 履歴閲覧 | 対象文書／revisionを確認 | 読取専用の過去本文 | 現行本文と混ぜない。戻れば元の編集 |
| 復元 | 対象revision、clean、競合なし、guard | 新しいRevisionの確定を確認 | staleなら最新版再取得と比較 |
| 知識候補作成 | 名前・型・project、author API | candidate保存結果 | 失敗時フォーム保持、confirmedにしない |
| 根拠作成・引用移動 | 確定Revisionと正規anchor、scope、guard | 正規結果、現位置は一致検証後のみ選択 | 古い根拠・要確認・孤立を明示 |
| 知識統合 | 同型・対象、previewDigestとprojectVersion、明示確認 | 既存apply結果からnode/relation/根拠を更新 | 競合時の適用禁止、旧previewの利用禁止 |
| 提案承認・却下 | proposal authority、ID、version、権限 | 正規の状態再取得 | 不明時に同じ提案の照合、正本未適用 |
| 提案適用 | 承認済み、適用対象・version、既存guard | receiptと正本更新、保護中本文を維持 | stale/replay/unknownの既存処理。自動承認・新規適用なし |
| 配置変更／保存 | Workspace guardとcatalog | 現配置の変化／明示的なlayout保存 | 元layout保持、原稿保存成功と表示しない |
| サインアウト・shell変更 | protectTransitionと現在scope | Access logout／既存token logout／Hosted logoutまたは既存shell切替 | 保護できない時は遷移拒否。復帰時は同一authorで照合 |

認証モードは `api.version` が示す既存情報を利用する。AccessのSSOモード、ローカルのトークンモード、Hosted grantを別々に扱う。Accessログアウトは他のAccessアプリのセッションにも影響するため、明示操作として説明できる導線を設ける。再認証のためのトップレベル遷移は入力を失わない既存の回復契約を優先する。Bearerをブラウザ作者権限として利用しない。UI改善のため認証エンドポイントを追加・緩和しない。

## 実装境界

| 所有者 | 変えてよいpresentation | 保持すべき契約 |
| --- | --- | --- |
| launcher / PersistenceEntry | 入り口、状態表示 | 既存shell選択、auth mode、scope |
| PersistenceWorkspace controller | 表示用projection、画面構成 | canonical input、journal、guard、save/recovery、API |
| DesktopShell / MobileShell | 各プラットフォームの操作面 | shell identity、Mobile route/history、IMEとfocus |
| Workspace | 初期preset、chrome、操作配置 | schema、catalog、layout persistence、lifetime |
| ManuscriptInput / MobileReadingPager | chromeと既存組版の見せ方 | CodeMirror state、ルビ、読み方向、位置 |
| KnowledgeContextInspector / NativeChangeSetReview | 一覧・詳細・人が読める差分 | native ID、scope、version、preview、receipt、author authority |
| module contributions | 登録済み道具の提示 | availability、effect、snapshot、Core/Full、内部LLM freeze |

コンポーネント分割は責務の分離に役立つ範囲で許容するが、同じ状態と操作を別実装することは避ける。React stateの整理を理由に新規状態管理ライブラリを追加しない。

## 受入マトリクス

以下は実装後の観測要件であり試験結果ではない。既存のテストを拡張する場合は、対応する受入シナリオを実際に証明する最小限の追加とする。

| 観測対象 | fixture・操作 | 必須の結果 | 既存確認経路 |
| --- | --- | --- | --- |
| 起動・再認証 | 直接リンク、SSO失効、既存Draft | 正しいscope、トークン不要、復旧保持 | auth-recovery.acceptance.spec.ts |
| 構成と原稿 | 複数巻・章、同名シーン、移動・順序変更 | stable ID、実DBのmetadata、衝突時非上書き | persistence-database.acceptance.spec.ts |
| 保存 | 後続入力、通信断、応答損失、別tab、競合 | UI表示とjournal／receipt一致、入力保持 | core.acceptance.spec.ts / persistence-database.acceptance.spec.ts |
| 配置 | 3プリセット、カスタム、壊れた保存値、Core-only | 復元可能、原稿非変更、全操作への代替手段 | modular-workspace.acceptance.spec.ts |
| 根拠 | 確定・古い・曖昧・孤立anchor、同名ノード | 正確な対象、偽の位置確定なし | persistence-database.acceptance.spec.ts |
| レビュー | 未承認、承認のみ、適用、stale、応答損失、replay | 正本とreceipt一致、許可されない変更なし | native-review.acceptance.spec.ts / review-contributions.acceptance.spec.ts |
| Mobile | 参照sheet、戻る、IME、キーボード、狭幅 | 同一editor、位置保持、守られた遷移 | ui-v1.acceptance.spec.ts / modular-workspace.acceptance.spec.ts |
| 表示 | 長い日本語、3テーマ、Core/Full、module無効 | 実レンダリングで重心、contrast、focus、overflow確認 | [Visual system](VISUAL-SYSTEM.md) |

全体の受入はUX-CONTRACTのS-A各条件と[Verification](../verification/README.md)を維持する。ブラウザの実操作、DB状態・receipt、スクリーンショットを別種の証拠として確認する。外部IdP・本番Tunnel、物理端末・実IME等の環境固有要件はシミュレーション結果と区別する。
