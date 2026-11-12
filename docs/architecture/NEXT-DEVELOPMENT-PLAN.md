# Codexia 次期開発計画

**版:** 1.0（レビュー用計画案）  
**策定日:** 2026-11-12  
**対象:** `yohn-jp/codexia`  
**基準コミット:** [`464d2cb23a53535ae2bc48993e1e6374b1b1971b`](https://github.com/yohn-jp/codexia/commit/464d2cb23a53535ae2bc48993e1e6374b1b1971b)

## 1. 目的と完了条件

Codexiaを、原稿の執筆・作品世界の知識管理・物語の整合性検証・AIによる創作支援を一つの作品状態に基づいて行える長編創作基盤へ発展させる。PostgreSQLを唯一の正本とし、原稿から知識を蓄積し、その知識を次の執筆に還元する循環を完成させる。

次期計画の完了は、機能数や画面数ではなく、以下の実操作によって判定する。

- 原稿の一節から人物・設定・関係を参照し、未確定候補を確認・承認し、同じ原稿位置へ復帰できる。
- 設定から原稿の根拠を逆引きできる。原稿変更・削除後も根拠の状態が正しく区別される。
- 任意の場面について、世界内の状態・その人物の認識・読者への開示状態を分けて取得できる。
- 設定矛盾や伏線の問題を根拠付きで指摘でき、AI/MCPが同じ作品状態を参照する。未承認の変更は正本へ適用されない。
- 通常のアプリケーション更新が、DBマイグレーションなしで検証・切替・復旧できる。更新が失敗しても作品を失わない。

## 2. 現状と設計上のauthority

### 2.1 確認済みの資産

基準コミットの設計文書、パッケージ定義、主要エントリポイント、Story/Assistantのアクション実装を確認した。下表は存在を確認した契約・コードであり、機能全体のE2E合格や本番稼働を示すものではない。

| 領域 | 現行の資産 | 次期開発での扱い |
|---|---|---|
| 永続化 | `packages/persistence-contracts` / `persistence-postgres`。Project、Document、Revision、Knowledge、Evidence、Assertion、ChangeSet、ModuleRecord | 唯一の正本。新しいDB・別ストアを作らない |
| Knowledge | `packages/core/src/knowledge` のノード・関係・命題・統合 | 現行グラフ型と永続型の対応を明確にする |
| Evidence | `packages/core/src/evidence` のAnchor追従、辞書、候補抽出、逆引き | 既存アルゴリズムを利用し、操作導線と永続化の整合を証明する |
| Story | `modules/story/src/domain` のグラフ、年表、世界状態、伏線、読者知識 | 既存計算を再利用。PostgreSQLのID・Revision・Evidenceへの接続を強化 |
| Story UI/API | `story.timeline.query`、`story.world-state.at-scene`、`story.threads.lifecycle`、`story.reader-model.build`、既存Workbench | 新規の並行Storyシステムを作らない |
| Search | `modules/search` の辞書・索引・自動リンク | Knowledgeと用語辞書の責務整理。重複索引を作らない |
| Assistant | `assistant.qa`、`continuation`、`reader.reaction`、`stateEvents.draft` 等と文脈・出典・プレビューの実装 | 既存文脈取得の改善とMCPとの共用。新しいAI実行基盤を作らない |
| UI | Desktop/Mobile、共有保存・復旧、可変パネル、Reading | 既存シェルを維持して創作ワークフローを完成させる |
| 交換・復旧 | `codexia-work/v1`、PostgreSQLバックアップ | 作品交換と運用バックアップを区別し、未解決Evidenceを保持 |
| 配備 | Workers静的UI、Tunnel、Rootless Podman、Quadlet、SHA固定GHCR発行 | 既存構成に更新制御を追加。Kubernetes等への移行は不要 |

### 2.2 解決すべき設計上の差分

- Storyの `readStorySnapshot` は、Coreの固定Snapshotから `bible/`・`plot/`・`manuscript/` 等のファイル形状を読み、独自Story Entityを組み立てる。これはGitへの復帰を意味しないが、KnowledgeのUUIDとStoryのID、文書の正規ID、Evidenceの関係を統一的に扱えるかを確認する必要がある。単にパスを全置換するのではなく、既存の投影・互換契約と実利用を追跡する。
- CoreのKnowledge型とPersistence型には状態名・表現の相違がある。変換境界、損失の有無、正本の優先を確認し、必要な場合だけ修正する。
- RFCの軽量Lexical Linkerと、現行のOptional Search/Terminologyの責務を整合させる。本計画ではCoreが手動のKnowledge/Evidenceと確認済み参照を提供し、継続的な自動抽出・検索は既存Optional機能の明示的な有効化に従う。Core-onlyでモデルや索引を必須化しない。
- 現行Quadletは `CODEXIA_DATABASE_MIGRATE_ON_START=1`、単一API、共用 `/data` `/history`、TunnelからAPIへの直接接続を採用している。並行起動・更新用の排他と切替境界は追加設計が必要。
- WorkerとAPIは独立リリースされる。自動更新に際し、ブラウザ・新旧UI/API間の互換性を明示的に保証する必要がある。

本計画は `CORE.md`、`INTERNAL-BOUNDARIES.md`、`MODULES.md`、`MODULAR-WORKSPACE.md`、`UX-CONTRACT.md` の既存契約を維持する。矛盾するRFC記述を採用する場合は、実装前に正本の文書を明示的に改訂する。設計案を暗黙に受入条件へ昇格させない。

## 3. 基本設計原則

1. PostgreSQL以外に原稿・Knowledge・確定作品状態の正本を作らない。IndexedDBは未保存Draftの復旧専用とする。
2. 作品内の世界事実、人物の信念・知識、読者への開示、作者の未採用構想を区別する。本文に書かれたことをそのまま客観的事実と認定しない。
3. 文書ID、Revision ID、Knowledge ID、Evidence IDは安定IDを使用する。ファイル形状のパスは既存モジュール向けの投影に限定する。
4. 解析は固定Snapshotに基づく。正本への変更は既存ChangeSet・作者承認・トランザクションの契約を経由する。著者による通常編集は既存保存経路を維持する。
5. 派生データは再生成できる。背景処理の停止・失敗・モジュール無効化は執筆を阻害しない。
6. 日本語IME、ルビ、縦書き閲覧、入力復旧、別シェル、可変レイアウトを維持する。新しいエディタや状態管理基盤への置換は行わない。
7. DBスキーマ変更はメジャー更新でのみ行う。通常の自動更新では一切のDBマイグレーションを実行しない。次期機能に必要なスキーマ変更は計画的なメジャー境界へ集約し、不要な変更は避ける。

## 4. 依存関係と開発系列

```text
A0 現行機能・契約棚卸し ─┬─ A1 Knowledge / Evidence ─ A2 Temporal Story ─ A3 Narrative Intelligence
                         │                                      └─────────┬──────────────┘
                         │                                                A4 Context Engine ─ A5 Scenario Planning
                         └─ O1 Release / Update Contract ─ O2 Blue/Green ─ O3 運用受入
```

運用系列Oと創作系列Aは原則並行可能。共有API、永続契約、CI定義への変更は統合責任者が調整し、競合する作業を独立ブランチへ分割しない。各段階は「設計承認→最小実装→受入検証→統合」の順に進める。Phase番号は依存関係であって工数・納期を確約しない。

| ID | 優先 | 成果 | 前提 |
|---|---|---|---|
| A0 | P0 | 実装・契約・ギャップ一覧、代表作品fixture、次期Issueの受入条件 | なし |
| O1 | P0 | 不変digestのリリース契約、スキーマ互換ゲート、UI/API互換ポリシー | A0の配備調査 |
| O2 | P0 | VM上の更新コントローラー、安定した切替経路 | O1 |
| O3 | P0 | 障害注入・実環境受入、バックアップ・復旧手順 | O2 |
| A1 | P1 | Knowledge/Evidenceを原稿と統合するContext Dockとレビュー | A0 |
| A2 | P1 | 時系列・人物状態・認識の統一された参照 | A1 |
| A3 | P1 | 伏線、開示、設定矛盾の根拠付きレビュー | A2 |
| A4 | P2 | 既存Assistant/MCP共用のContext Package | A2、A3の参照契約 |
| A5 | P3 | 仮説・分岐構想、採用時のみ正本へ反映 | A4 |

## 5. 創作系列 — 各フェーズの仕様と受入条件

### A0 — 棚卸し・統合契約

**成果物:** 現行機能マトリクス（コード・API・UI・テストへのリンク）、ID/状態の対応表、スキーマ変更要否、統合fixture、実装Issue案。

- Core→Persistence、Story→SnapshotReader、Search→用語辞書、Assistant→Story/MCPの実際の実行経路を追跡する。KnowledgeとStoryの二重登録・未接続・型の変換損失を調査する。
- 既存CI/実環境の結果を確認し、失敗を機能追加で覆い隠さない。実装の存在と動作済みを分ける。
- fixtureには同名人物、別名、回想、意図的な嘘、人物の誤認、伏線、複数視点、本文の修正・削除、UTF-16境界、複数作品を含める。

**受入:** 各計画項目が既存機能の再利用・接続改善・新規実装・延期のどれかに分類され、担当コンポーネントと受入証拠が確定する。未確認の既存機能を「未実装」と決め付けない。

### A1 — Knowledge / Evidence統合

**作者体験:** 本文選択または装飾クリックからContext Dockを開く。対象のKnowledge、関連人物・設定、確定根拠、候補、曖昧さを確認する。原稿を離れず新規設定・関連・言及を提案でき、承認後は設定から根拠箇所へ逆引きできる。既存Knowledge/Evidenceパネルを利用し、本文を閉じずに必要情報へ到達する。

**実装:** 既存の `KnowledgeNode` / `KnowledgeRelation` / `Assertion` / `EvidenceAnchor` / `MentionLink` とCoreの辞書・Anchor・逆引きを優先利用する。関係の追加、ノード統合、別名の曖昧性解消、根拠付き命題の承認を既存トランザクションへ接続する。Story EntityとKnowledgeの対応が明確でないものは候補・未接続として扱い、推測で同一視しない。検索のTerm RegistryとKnowledge Aliasは別正本にせず、意味が同一なら明示的な参照または一方向投影で整合させる。用語の表示設定など固有の情報はSearchの責務に留める。

**受入:**
- ノード・関係・命題を作成し、複数文書の根拠を追加して再起動後に取得できる。本文にない作者設定も登録できる。
- 別名が同一文字列の複数ノードを指す場合、自動確定せず選択を求める。ノード統合は関係・根拠・履歴を失わない。
- Anchor前方の編集は位置追従、内部変更は要確認、削除は孤立として表示する。古いRevisionを現在の根拠と偽らない。
- 日本語IME・ルビ・絵文字を含む実原稿で入力と選択が失われず、Desktop/Mobileで原稿↔Knowledgeの往復ができる。
- Core-onlyでも手動Knowledge/Evidenceが利用でき、Optionalモジュールの停止によって確定データが失われない。

### A2 — Temporal Story / 世界状態

**作者体験:** シーンを選択すると、世界内の時点、作品内の描写位置、人物の状態、直前からの変化とその根拠を確認できる。回想や時点不明の場面を無理に現在順へ並べず、年表と構成を独立して参照する。

**実装:** `modules/story/src/domain/timeline.ts` と `worldState.ts` の既存推定・イベント・fold・履歴計算を評価し再利用する。状態イベントとKnowledge/Assertion/Evidenceの対応を明確にする。世界内時刻は年月日固定ではなく、相対順・範囲・不明・同時期を表現できる契約とする。シーンの描写順と世界内の因果順を分離する。作者が確定した状態・候補・競合・未知は区別する。新しい時系列DBや汎用イベントソーシング基盤を導入しない。必要な型は既存ModuleRecordまたは既存永続契約を利用できるかを先に検証する。

**受入:**
- 入隊→戦役→昇進の出来事を登録し、回想を含む描写順でも各時点の所属・地位が正しい。時間順不明の場合は不明として返す。
- 人物の所在地、所有物、所属、生死等の状態を根拠付きで取得できる。旧状態を上書き消去しない。
- 過去の状態イベントを変更すると影響する後続の派生状態が更新またはstaleとなる。関連しない本文を再解析しない。
- 同一時点の相反する確定状態は明示され、片方を無言で選択しない。

### A3 — Narrative Intelligence / 伏線・認識・整合性

**作者体験:** 章・シーン・人物ごとに、伏線の提示/進展/回収、人物の認識、読者への情報開示を確認できる。問題候補をクリックすると関連する原稿と設定へ移動する。意図的な矛盾や叙述トリックを作者が説明・除外できる。

**実装:** `threadLifecycle.ts`、`readerKnowledge.ts`、`worldState.ts` とDiagnosticsの既存整合性検査を統合する。命題の真偽、発言者・視点・モダリティ・時点・情報開示を別々に扱い、単なる言及を知識獲得と認定しない。ルールで証明できる矛盾とモデルの推測を区別する。指摘は元Snapshot・対象ID・根拠・ルール/モデル版・重要度・状態を持ち、作者が確認・却下・保留・例外指定できる。例外は適用範囲を限定し、無関係な新規問題まで抑制しない。

**受入:**
- 伏線の未回収、死亡後の登場、未取得情報の発言等のfixtureで、根拠付き指摘を得られる。
- 嘘・誤認・回想・信頼できない語り手のfixtureを、確定した客観的矛盾として誤登録しない。
- 登場人物Aには既知、Bには未知、読者には未開示という状態を別々に参照できる。
- 原稿編集後に旧指摘を現行指摘として表示しない。作者が承認した例外をRevision変更時に必要に応じて再評価する。
- 検査結果から原稿・設定へ移動し、ChangeSet経由で必要な修正のみ反映する。

### A4 — Context Engine / AI・MCP統合

**作者体験:** 「このシーンの続きを考える」「この人物の発言を見直す」「読者視点で第3章を評価する」等に応じ、対象文脈を自動選定する。外部送信前には対象範囲・送信先・目的を確認できる。回答の根拠から原稿へ戻れる。

**実装:** 既存Assistantの文脈構築・出典・Prompt preview・provider・実行キューとMCPの既存Action境界を使用する。用途別に共通のContext Packageを生成できるよう、必要な共通部分だけを抽出する。入力は固定Snapshotと対象シーン・人物・用途・知識範囲・トークン予算。出力は原稿引用、Knowledge ID、確定/候補、世界状態、視点別認識、関連伏線、任意の文体サンプル、除外理由、出典Revisionを含む。固定予算で根拠・近接性・関連性を優先し、切り捨てた情報を明示する。既存検索を活用し、埋め込みやモデルをCoreの依存にしない。

**受入:**
- 同じSnapshot・用途・制約で既存AssistantとMCPが同一の正本情報を参照する。
- 読者視点では未開示の真相、人物視点では未取得の知識を既定で混入させない。作者向け全知モードとは明確に区別する。
- 外部送信への同意がない場合、ローカルの文脈プレビューと対応するMCP権限範囲の読み取り以外は送信しない。
- AIは設定の確定や本文の書換えを直接行えない。作者承認とRevision検証を経て反映する。
- 古い文脈・根拠を使った提案はstaleとして扱い、再取得を促す。出典が欠ける場合は推測と明示する。

### A5 — Scenario Planning / 構想分岐（将来設計）

本編の正本を変更せず、複数の展開案・仮定・予定イベント・想定される世界状態を比較する。分岐はGitのブランチではなく、固定した本編Snapshotに対する仮説・変更候補の集合とする。まず設計と小さな実証を行い、既存ChangeSetとの意味・寿命・承認単位を整理する。長期保存が必要な構想はStoryの作者所有ModuleRecord等を評価する。完全な並行世界の版管理や自動マージは対象外。

**受入:** 同一の本編から2つの仮説を比較しても確定状態・検索結果・読者知識は汚染されない。採用時のみ作者承認で必要な変更を適用し、元のSnapshotが古ければ差分を再確認する。不採用案は本編に影響せず再利用できる。

## 6. 運用系列 — 自動更新計画

### O1 — リリース契約

現行のSHA固定OCIイメージとexact-main CI certificationを維持する。ポーリング対象として、CI検証済みのアプリケーションリリースを指す配布メタデータを導入する。タグの辞書順や単なるコミットの新旧で自動更新先を判定しない。

リリース情報には製品SemVer、ソースSHA、OCI digest、対象arch/profile、DB migration setのfingerprint、UI/API互換範囲、必要な設定・データ形式互換性、リリース状態を含める。信頼できる発行者の署名または既存attestationの拡張でメタデータとdigestを束縛する。既存の `0.x` バージョン期間はメジャー互換の扱いを別途明文化し、安全性をSemVer慣習に委ねない。安定チャネルへ発行されたもののみを対象とし、PRビルド・未認証・取り消されたリリースは候補にしない。

**通常更新の条件:** バージョンが前進し、同一メジャー・同一DB migration set・同一の必要な永続形式互換性・選択profile・UI/API互換範囲を満たす。実DBの適用済みmigration checksumを確認し、候補側の期待値と異なれば拒否。通常起動はマイグレーション無効、必要ならDB権限でもDDLを防止する。メジャー更新やDB変更は明示的な運用手順でのみ実施する。

**受入:** 未署名/未検証、古い版、誤profile、スキーマ差、UI非互換、digest不一致を拒否する。発行途中・GHCR障害では現行稼働を維持する。CIを迂回したリリースを自動適用しない。

### O2 — Blue/Green更新コントローラー

```text
Cloudflare Access
  ├─ UI routes → Workers Static Assets
  └─ API / other routes → Cloudflare Tunnel
                           → stable private proxy
                                ├─ Blue API (active)
                                └─ Green API (candidate)
                                      ↓
                             PostgreSQL (unchanged)
```

単一VMのRootless Podman + Quadletを維持し、固定の内部プロキシ、2スロット、ホスト上の更新制御を追加する。Tunnelの宛先は固定し、Cloudflare API操作を更新ごとに要求しない。APIやWorkerへPodmanソケット、GHCR書き込み権限、ホスト管理権限を与えない。systemd timerの既定ポーリング間隔は5分（設定変更可能）とし、永続状態と排他ロックで多重更新を防ぐ。

更新状態: idle → detected → verified → pulled → candidate-ready → draining → switched → observing → committed。失敗はrollback/blockedへ遷移する。状態とdigestを原子的に記録し、途中でVMが再起動した場合は実プロキシ・コンテナ・Writer状態を照合して復旧する。

候補は独立したキャッシュ/一時領域で起動し、外部ルートから隔離する。候補でバックグラウンドジョブ・外部送信・正本変更・共有履歴への書込みを開始しない。実装方法はA0/O1で現行API lifecycleを追跡し決定する。旧APIと候補APIの同時Writerや共有 `/data` `/history` への無制御並行アクセスを禁止する。候補のReadinessはDB接続、スキーマ一致、契約、初期化完了を確認する。

切替時に旧APIの新規書込み・ジョブ開始を止め、進行中の保存と必要なジョブを既存drain境界で完了/安全に停止させる。排他が成立してから新APIをActiveへ昇格し、安定したプロキシの転送先を変更する。切替に伴う短い受付停止・再ログインを許容する初期版とし、無停止を保証しない。セッション継続を実現する場合は既存認証境界を拡張し、DBスキーマ変更が必要ならメジャー計画へ分離する。保存結果が不明な要求は既存冪等IDで照合する。SSE/長時間ジョブは接続切断と再接続を明示的に検証する。

切替後は実API応答、認証済み読み取り、DB readiness等を一定期間（初期案5分）監視する。失敗時は新APIをdrain/fenceしてから旧APIへ戻す。旧版が新しい永続形式・UIと互換であることが確認できない場合は自動rollbackを行わず更新を停止する。成功後に旧APIを停止するが直前のdigestは保持する。UI/API混在と古いブラウザbundleを含む互換期間を設け、互換性のないUIはAPIと別々に公開しない。

**受入:**
- 更新候補検出から切替まで手動操作不要。旧API稼働中の候補検証に失敗しても旧APIは継続。
- 同じリリースの再検出、重複ポーリング、プロセス停止、VM再起動で二重Writerや状態不整合が発生しない。
- 保存中・応答損失・切替中・旧版への復帰でも、正本Revisionと冪等receipt、IndexedDB Draftを失わない。
- 不正な設定・DB不一致・health失敗・プロキシ切替失敗・切替後異常を注入し、fail-closedの動作を確認する。
- DBスキーマを自動変更しないことをテストで証明する。Tunnel、Access、API認証、CSRF、公開ポート境界を維持する。

### O3 — 運用受入・保全

更新の状態、現在/候補/直前バージョン、失敗理由、最終成功時刻、停止状態をホスト上のログ/CLIで観測できるようにする。初期版ではWeb管理画面を必須にしない。手動pause/resume、明示的なrollback、失敗版の再試行抑制を提供する。初期の自動更新有効化はoperatorの明示設定による。

実環境でWorker Routes、Tunnel、Access、API、PostgreSQL、保存/再読込、更新と復旧を確認する。DBの暗号化オフVMバックアップと孤立環境への復元演習、`/history`の保全を行う。作品JSONは履歴を含まない交換形式であり、DBバックアップに代替しない。

**受入:** 実機で正常更新・失敗更新・復帰、VM再起動、バックアップ復元に成功し、原稿ハッシュ・Revision/関連知識・承認状態が維持される。実機にアクセスできない場合は未検証として残す。Praetorium Hostedの制御契約は変更せず、初期自動更新はStandalone VM専用とする。

## 7. 共通検証・リリースガバナンス

- 既存 `scripts/ci-contract.mjs` の検証インベントリをauthorityとする。Core/Fullの型検査、unit、build、依存監査、ブラウザ、OCI、Hosted Native、certificationを省略しない。exact-head結果とmain-pushのリリースゲートを区別する。
- 各機能の必須証拠は、純粋計算のunit、実PostgreSQLでのトランザクション・scope・Revision・障害検証、Desktop/Mobileの実操作、外部AIを使用しないfixture、必要な場合の実サービス検証で構成する。
- パフォーマンスはA0の基準値と同じfixture・profile・環境で比較する。入力、場面切替、保存、参照、解析を分離し、解析をForegroundへ直列化しない。目標数値は基準計測後に設定する。
- スキーマ変更を発見した場合は変更の理由と互換性を記録する。通常更新へ紛れ込ませず、計画されたメジャーアップデートの運用手順・バックアップ・復旧試験を別途定める。
- スコープ外: Git永続化/同期、WASMによる再設計、外部Plugin Marketplace、全作品横断の知識統合、汎用イベントバス、Kubernetes、完全オフライン同期、共同編集CRDT、無条件の自動原稿修正。外部Plugin設計は既存別計画に留める。

## 8. 最初の実行単位

次の2本を独立して開始し、合流時に共有契約を一度だけ確定する。ブランチ名は実装開始時の候補であり、本計画の作成ではブランチ/Issue/PRを作成しない。

| 作業単位 | ブランチ候補 | 成果物 |
|---|---|---|
| A0 | `plan/knowledge-story-integration` | 実装経路とID対応の棚卸し、代表fixture、A1〜A4のIssue候補、必要な設計文書更新案 |
| O1 | `plan/deployment-lifecycle` | リリース互換契約、配備状態遷移、Blue/Greenの排他・履歴・切替設計、O2/O3のIssue候補 |

A0の結果が確定した時点で、A1の最小垂直スライス（本文選択→Knowledge→根拠→作者承認→逆引き→原稿復帰）を開始する。O1の承認後にO2へ進む。Storyの既存年表・伏線・世界状態・読者モデル・Assistantの文脈処理を捨てて作り直すことは禁止する。

## 9. 参照資料と未確認事項

以下は基準コミットの参照先。

- [Core](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/docs/architecture/CORE.md) / [Internal boundaries](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/docs/architecture/INTERNAL-BOUNDARIES.md) / [Reboot RFC](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/docs/architecture/CODEXIA-REBOOT-RFC.md)
- [Persistence contracts](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/packages/persistence-contracts/src/index.ts) / [Core Knowledge](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/packages/core/src/knowledge/index.ts) / [Core Evidence](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/packages/core/src/evidence/index.ts)
- [Story domain](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/modules/story/src/domain/index.ts) / [Story snapshot](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/modules/story/src/snapshot.ts) / [Story actions](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/modules/story/src/actions.ts) / [Assistant actions](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/modules/assistant/src/actions.ts)
- [Deployment](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/docs/deployment/README.md) / [API Quadlet](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/deploy/quadlet/codexia-api.container) / [Portable works](https://github.com/yohn-jp/codexia/blob/464d2cb23a53535ae2bc48993e1e6374b1b1971b/docs/authoring-portable.md)

未確認: 全経路のコード棚卸し、既存E2E実行結果、CI main-pushの認証、Cloudflare/VMの実稼働、更新コントローラーの実現方式と性能。これらはA0/O1/O3の検証対象である。本書は設計・開発計画であって実装完了・実機受入を宣言するものではない。5分間隔、監視時間、初期CLI、Standalone限定、短時間停止を許容する初期版は設計案として設定したもので、実機測定と設計承認を経て確定する。
