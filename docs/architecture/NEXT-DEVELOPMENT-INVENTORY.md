# 統合契約と検証インベントリ

## 実行経路とauthority

| 領域 | 既存実装・契約 | 接続・新規実装 | 受入証拠 |
|---|---|---|---|
| 永続化 | packages/persistence-contracts/src/index.ts → packages/persistence-postgres/src/postgres-store.ts | スキーマ互換、読み取り専用Knowledge投影 | postgres-store.test.ts、実PG |
| Knowledge | packages/core/src/knowledge/index.ts、packages/core/src/evidence、packages/api/src/persistence-routes.ts | 既存Inspector、命題、別名、関係、統合 | tests/e2e/persistence-database.acceptance.spec.ts、Core knowledge-evidence.test.ts |
| Story | modules/story/src/snapshot.ts → domain/worldState.ts、timeline.ts、readerKnowledge.ts、threadLifecycle.ts | | modules/story/src/actions.test.ts、domainテスト |
| Search | modules/search の既存Term Registryと辞書 | Knowledge AliasはPostgreSQL正本、同名一致は確定としない。Searchとの明示参照・一方向投影の接続は明示的な参照を必要とする | 既存Searchテスト、実UIで曖昧性を検証 |
| Context/MCP | modules/story/src/actions.ts、modules/mcp/src/tools.ts、既存Module Action registry、Assistantのローカル文脈 | 共通Context、プレビュー、外部AIの提出、内部LLM実行の凍結（[MCP-first](MCP-FIRST.md)） | Story fixture、MCP権限・Provider非実行・Snapshot受入 |
| Scenario | 既存Story ChangeSet / ModuleRecord | 比較、保存、stale再比較、採用提案 | 既存Storyテストと追加fixture、統合受入 |
| Release | scripts/ci-contract.mjs、既存OCI/Worker CI | | exact-head/統合main CI、署名検証、DB fingerprint |
| 更新 | deploy/quadlet、Tunnel、API lifecycle | | コントローラ単体、実Podman/VM、保存中切替 |
| 保全 | 既存PostgreSQL/履歴、codexia-work/v1 | | 暗号化バックアップ、隔離復元、実データ一致 |

## ID・状態の対応

- Project IDで全問い合わせを限定する。Document UUID / Revision UUIDは本文・Anchorの正本。投影パスは既存モジュール用の互換識別であって別ストアではない。
- Story Entity IDは従来形式を維持する。Knowledge UUIDとは作者が指定した `knowledge_id` / `storyEntityId` のみで結び付ける。同名・別名の一致は関係候補であり同一性を確定しない。対応が複数ならambiguous、対応なしならunmapped。
- Knowledge Node: proposed / confirmed / retired。Alias: proposed / confirmed / ambiguous / retired。Relation: proposed / confirmed / rejected / retired。Assertion: proposed / confirmed / rejected / retired。確定命題と客観世界事実は別概念。
- EvidenceAnchor: proposed / confirmed / needs_review / orphaned。MentionLink: proposed / confirmed / ambiguous / rejected。confirmed anchorでもhead Revisionと一致しない場合は現在の根拠に使わない。
- 世界内時間は相対整数日・範囲・不明、描写順は独立。世界状態、人物の認識、読者への開示、仮説を分離する。
- 分岐は本編Snapshot上の仮説で、未採用状態を正本に書き込まない。採用は既存作者承認の変更案。

新規テーブル・マイグレーションは通常の統合で要求しない。既存の永続化制約、Core authority、Optional停止時の執筆継続を維持する。仕様変更の必要性が生じたらmajor更新で別途明示する。

## 代表fixtureと検証

`fixtures/next-development-work.json` は共通の受入シナリオ定義。Story actionテストとDB E2Eで個別ケースを検証する。検証結果は実行時のCI artifactおよび実環境の証拠をauthorityとする。
