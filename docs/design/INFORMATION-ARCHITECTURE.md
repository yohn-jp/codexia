# Codexia — 創作ワークスペースの情報設計

## 位置付け

創作画面の再設計提案。受入済みの [UX contract](UX-CONTRACT.md) を具体化し、[Core](../architecture/CORE.md) と [MCP-first](../architecture/MCP-FIRST.md) の正本、認可、保存、変更提案の意味を変更しない。以下は実装済み機能の説明ではない。

## 製品モデル

Codexiaは、作品を書く、世界を理解する、外部エージェントの提案を判断するという三つの活動を、同一の作品と原稿の上で連続して行う創作環境である。データベース、モデル、パネルは道具であり、ホーム画面の主役ではない。

| 活動 | 第一の対象 | 到達点 |
| --- | --- | --- |
| 執筆 | 作品の巻・章・シーン、原稿 | 続きを書き、保護された状態で戻れる |
| 知識 | 人物・場所・出来事・設定・用語、関係、根拠 | 情報を理解し、原稿へ戻れる |
| レビュー | 作者の判断を必要とする変更提案 | 影響を理解し、承認／却下し、別の明示操作で適用する |

検索・履歴・解析・外部MCPは活動横断の道具。通常の執筆を任意moduleやmodelの稼働に依存させない。

## ナビゲーション

- 作品ライブラリ：作品の切替、作成、再開。空の作品と取得失敗を区別する。インポート／エクスポートは作品の操作メニューに置く。
- 執筆：現在の構成と本文を中心とする。最近のシーン、検索、関連知識、履歴へ本文を失わず到達できる。
- 知識：同じ作品の知識一覧、詳細、根拠、関係。執筆の参照パネルから詳細へ移り、元の本文と選択を保持して戻る。
- レビュー：Native ChangeSetと既存module proposalを権限・状態別に整理し、対象と影響を理解する。異なる適用契約を見かけ上の一括操作にしない。
- 設定：外観、組版、レイアウト、接続、任意module、アカウント。管理用の情報を通常の操作列から分離する。

執筆・知識・レビューの切替えは同じ author/project/document scope、既存の journal／navigation guard とレイアウト基盤を使う。別のルーティングライブラリ、データ正本、保存セッションを導入することは本設計の要件ではない。既存の明示的な Desktop/Mobile shell、記憶した選択と公開readerを保持する。どの領域からも現在の作品と本文へ戻れる。

## 表示の語彙

| 作者向け表示 | 意味 |
| --- | --- |
| 作品／巻／章／シーン／ノート | 既存 project/document kind と階層 |
| 原稿・履歴 | Markdown と immutable Revision |
| 下書き・保存中・保存済み・要確認 | journal、対応するDB receipt、後続入力、応答の不確実性を区別 |
| 知識・根拠・引用 | Knowledge node／Evidence／Text Anchor。候補・確定・要確認・孤立の区別を保持 |
| 変更提案・承認済み・適用済み・却下 | Native ChangeSet と module proposal の実状態、receipt |
| レイアウト編集 | Workspaceの移動、分割、resize、float、保存 |

PostgreSQL、ID、read/write set、version、receipt等は技術詳細を必要とする状況で開示する。通常時の短い表示は状態の意味を省略せず、詳細に到達可能であること。日本語の操作語彙を統一し、内部識別子と名称を混同しない。未知の型・metadataを表示変更で失わない。

## 共通デザイン言語

視覚の重心は原稿・現在の知識・変更差分。静かな中立色、十分な日本語の読み幅と行間、控えめな区切り、焦点の明確な文字階層を採用する。意味のないカード群や大きな製品ロゴではなく、作品の内容によって各画面の個性を作る。操作ボタンをすべて同じ強さで並べない。テーマ、フォーカス、色以外の状態表現、コントラストとWCAG適合を既存契約に従って統一する。

初期状態は使える配置を提供し、詳細な自由配置はレイアウト編集へ退避する。既存の保存済みカスタム配置を破壊しない。見た目のために機能を削除しない。

## 受入

- 新しい利用者が作品を開き、シーンを選び、本文を編集できる。設定やパネル組立ては不要。
- 既存利用者が再開位置へ戻り、参照・検索・提案確認を経ても入力位置と保護状態を失わない。
- 同名の知識、同名シーン、空の状態、取得失敗、権限拒否、未導入module、長い日本語ラベルに対して誤った対象や成功を表示しない。
- Core/Full、Desktop/Mobileの既存対応機能を維持し、外部MCP・DB・保存・承認境界に変更を持ち込まない。

詳細：[Desktop執筆](DESKTOP-AUTHORING.md)、[知識・レビュー](KNOWLEDGE-REVIEW.md)、[Mobile](MOBILE-AUTHORING.md)。

## 画面カタログと状態の所有

画面を増やす理由は対象や作者の仕事が変わるためであり、APIやmoduleの数に合わせて画面を作らない。以下のIDは論理的な画面識別子であって新規URL、API、DBテーブルを必須としない。

| 画面ID | 開く対象・主な操作 | 主導線・戻り先 | 既存責務 |
| --- | --- | --- | --- |
| LIB-01 | 作品一覧、最近の作業、作品作成・取込 | 起動、作品名から開く。選択作品の構成へ | PersistenceWorkspace / persistenceProjects |
| WRT-01 | 選択文書、構成、執筆・閲覧 | 作品選択、直接リンク、最近の作業。現在の原稿に留まる | outline / editor / coordinator |
| WRT-02 | 原稿の履歴、確定Revision、比較・復元 | 原稿の操作メニュー。元の編集へ | persistenceRevisions / restoreRevision |
| KNO-01 | 作品の知識一覧、絞込、候補登録 | 知識ナビゲーション。執筆に戻る | inspector / persistenceNodes |
| KNO-02 | ノード詳細、関係、根拠、命題 | 一覧・原稿参照・関係から開く。元の一覧または原稿 | KnowledgeContextInspector / native reads |
| KNO-03 | 選択ノードの局所関係 | 詳細の「関係」。一覧形式へ切替可能 | 既存node/relation projection |
| REV-01 | 作者が確認する提案一覧 | レビュー、ジョブ／通知の対象リンク | review / NativeChangeSetReview / ProposalReview |
| REV-02 | 選択提案の変更前後・根拠・承認・適用 | 一覧から。反映した原稿・知識へ | 各提案authority |
| CFG-01 | 外観・組版・配置・module・接続・アカウント | 補助操作。元の作業へ | theme / typography / Workspace / module settings |
| REC-01 | 保存と復旧の詳細・競合判断 | 状態表示またはエラーから。元の原稿へ | journal / save coordinator |
| PUB-01 | 公開reader | 既存公開URLのみ。著者UIを前提にしない | PublicModuleView |

作品未選択時はLIB-01、シーンが未作成なら作品の構成と新規作成を案内する。直接リンクがある場合はその対象の認可・取得・回復照合を優先する。最近の作業はauthor scope内の既存再開情報のみを表示する。存在しない作品、認可拒否、通信断を「空のライブラリ」に変換しない。

### URLと作業文脈

正規の文書ルートは既存の `/<shell>/projects/<projectId>/scenes/<documentId>`、作品ルートは `/<shell>/projects/<projectId>`。shellはdesktopまたはmobile。既存query/pathの読取互換とdeep linkを維持する。Mobileの `view=library|writing|inspection|tools|settings` は既存の導線として保持し、知識・レビューの新しい表示名や詳細表示を追加してもこれらのリンクを壊さない。新しい永続URL設計は本提案の必須条件ではない。

作業文脈はauthor、project、document、revision、navigation generation、選択範囲・scroll、開いている参照対象に分ける。作品／文書の選択は既存selection storeとルート、本文と復旧はcoordinator／journal、パネル配置はWorkspace、参照対象と一覧条件は表示stateに属する。別のglobal storeに本文を複製しない。再読込で復元できる範囲と同じ画面の往復で保持する範囲を区別する。

同一作品内の一覧・詳細・パネルの表示切替えは文書の選択を変えない。原稿へ戻る操作を、最後に見たKnowledgeの根拠へ移動する操作と混同しない。戻り先は直前の作業文脈に束縛し、対象の消失時には現在の構成へ戻して理由を示す。

### グローバルナビゲーションと初期画面

Desktopでは「執筆」「知識」「レビュー」を常設の第一階層とし、作品の切替・設定を分離する。執筆が初期の第一候補であり、保存済みのカスタム配置や正規リンクを上書きしない。作品一覧は現在の作品名から明示的に開く。任意moduleを上位ナビゲーションに自動で大量追加せず、関連する道具／パネル一覧へ分類する。

Mobileの上位導線はMobile設計書に従う。同じ作業面を示すため、DesktopのタブとMobileのsheetが同じURLや同一のDOMを持つ必要はない。

### 命令の分類と表示権限

- 表示操作：一覧の絞込、構成の展開、プレビュー、レイアウト編集。正本への変更ではない。
- 作者による明示変更：文書metadata、本文保存、知識候補登録・確定、関係編集、統合、履歴復元。既存author API、version、journalの境界を使う。
- 外部／moduleによる提案：MCP・module actionsが提案として登録する。正本への直接書込みと区別する。
- 提案の判断：承認、却下、適用は既存authorityで別操作。作者の許可がない時は該当操作を許可しない。UIで隠すだけでは認可にならない。

状態・遷移の詳細は [操作と復旧](INTERACTION-CONTRACT.md)、視覚の基準は [Visual system](VISUAL-SYSTEM.md) に従う。
