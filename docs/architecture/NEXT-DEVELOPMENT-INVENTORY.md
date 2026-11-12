# 次期開発 統合契約・実装インベントリ (A0)

基準: main 464d2cb23a53535ae2bc48993e1e6374b1b1971b / 計画 #26。各PRは未統合。実装成果物と受入結果を混同しない。

## 実行経路とauthority

| 領域 | 既存実装・契約 | 接続・新規実装 | 受入証拠 |
|---|---|---|---|
| 永続化 | packages/persistence-contracts/src/index.ts → packages/persistence-postgres/src/postgres-store.ts | #28 #36 スキーマ互換、#61 読み取り専用Knowledge投影 | postgres-store.test.ts、実PG |
| Knowledge | packages/core/src/knowledge/index.ts、packages/core/src/evidence、packages/api/src/persistence-routes.ts | #40 #55 #63 既存Inspector、命題、別名、関係、統合 | tests/e2e/persistence-database.acceptance.spec.ts、Core knowledge-evidence.test.ts |
| Story | modules/story/src/snapshot.ts → domain/worldState.ts、timeline.ts、readerKnowledge.ts、threadLifecycle.ts | #32 #34 #47 #59 #61 | modules/story/src/actions.test.ts、domainテスト |
| Search | modules/search の既存Term Registryと辞書 | Knowledge AliasはPostgreSQL正本、同名一致は確定としない。Searchとの明示参照・一方向投影は未接続 | 既存Searchテスト、実UIで曖昧性受入が残る |
| Assistant/MCP | modules/assistant/src/actions.ts、既存Module Action registry | #47 #61 共通Context、プレビュー、同意、既存provider queue | Assistantテスト、Story fixture、MCP権限・外部送信受入 |
| Scenario | 既存Story ChangeSet / ModuleRecord | #47 #59 比較、保存、stale再比較、採用提案 | 既存Storyテストと追加fixture、統合受入 |
| Release | scripts/ci-contract.mjs、既存OCI/Worker CI | #28 #30 #36 #38 #43 #49 #51 | exact-head/統合main CI、署名検証、DB fingerprint |
| 更新 | deploy/quadlet、Tunnel、API lifecycle | #45 #53 | コントローラ単体、実Podman/VM、保存中切替 |
| 保全 | 既存PostgreSQL/履歴、codexia-work/v1 | #53 #57 | 暗号化バックアップ、隔離復元、実データ一致 |

## ID・状態の対応

- Project IDで全問い合わせを限定する。Document UUID / Revision UUIDは本文・Anchorの正本。投影パスは既存モジュール用の互換識別であって別ストアではない。
- Story Entity IDは従来形式を維持する。Knowledge UUIDとは作者が指定した `knowledge_id` / `storyEntityId` のみで結び付ける。同名・別名の一致は関係候補であり同一性を確定しない。対応が複数ならambiguous、対応なしならunmapped。
- Knowledge Node: proposed / confirmed / retired。Alias: proposed / confirmed / ambiguous / retired。Relation: proposed / confirmed / rejected / retired。Assertion: proposed / confirmed / rejected / retired。確定命題と客観世界事実は別概念。
- EvidenceAnchor: proposed / confirmed / needs_review / orphaned。MentionLink: proposed / confirmed / ambiguous / rejected。confirmed anchorでもhead Revisionと一致しない場合は現在の根拠に使わない。
- 世界内時間は相対整数日・範囲・不明、描写順は独立。世界状態、人物の認識、読者への開示、仮説を分離する。
- 分岐は本編Snapshot上の仮説で、未採用状態を正本に書き込まない。採用は既存作者承認の変更案。

新規テーブル・マイグレーションは今回のPR群で要求しない。既存の永続化制約、Core authority、Optional停止時の執筆継続を維持する。仕様変更の必要性が生じたらmajor更新で別途明示する。

## 代表fixtureと受入計画

`fixtures/next-development-work.json` は共通の受入シナリオ定義。既存Story actionテストやDB E2Eで個別ケースを使用する。全ケースが実行済みであることを意味しない。

| フェーズ | 実装PR | 残る検証・接続 |
|---|---|---|
| A1 | #40 #55 #61 #63 | Search Alias連携、未リンク作者命題、実PG統合・競合・履歴、全操作とIME |
| A2 | #47 #61 | 全イベント型とnative assertionの明示関連、後続再計算、回想・不明・競合の統合受入 |
| A3 | #47 #59 | 伏線・認識・例外の全fixture、診断のRevision失効、本文復帰 |
| A4 | #47 #61 | 既存用途別Assistantの既定経路収束、MCP実権限、関連伏線・文体・検索の選定、トークン・同意検証 |
| A5 | #47 #59 | 永続・失効・承認の実PG受入 |
| O1 | #28 #30 #36 #38 #43 #49 #51 | 署名鍵・保護環境・安定版公開、exact-main認証 |
| O2 | #45 #53 | 実際の旧新APIとDB/プロキシの排他、障害注入、再起動、SSE |
| O3 | #53 #57 | 実VM・暗号化オフVM・復元受入 |

CIは個別headと統合mainを区別し、全PRのCIがgreenとは宣言しない。レビュー・マージは後続の収束工程。実環境・性能測定は未実施であり、合格として扱わない。
