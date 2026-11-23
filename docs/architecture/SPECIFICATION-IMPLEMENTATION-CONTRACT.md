# 仕様駆動アーキテクチャ移行：実装契約と並列統合計画

**種別: 採用済み実装計画・技術仕様の補助。** 合意済み技術選定の正本は [Specification toolchain](SPECIFICATION-TOOLCHAIN.md)、要求・検証は [Requirements](../requirements/README.md) と [Tooling acceptance](../verification/SPECIFICATION-TOOLING-ACCEPTANCE.md)。HTTP、DB、MCP、バックアップ、画面の個別意味はそれぞれの領域正本が優先。本書は**実装workstreamの境界、依存関係、最小受入と統合条件**だけを所有し、製品要求や状態を独立して二重記載しない。実装前の計画であり、記載したツールが導入済みという意味ではない。

## 変更しない不変条件

1. Fastify v5を維持しHonoへ切替えない。TypeSpec→OpenAPI 3.1→Fastify JSON Schema/Ajv。Orvalはclient生成、Zod v4は業務/MCP/生成clientに使用する。
2. PostgreSQLは原稿等の唯一の永続正本。SQL migration/Better Auth管理schema、原稿Revision・receipt、Core単独利用可能性を保持する。
3. owner、MCP-CLIENT、SHARE-READER、SETUP、OPERATORを昇格・混同しない。MCPはread/compute/proposeまで、承認・適用は作者のみ。
4. Web UIとTailscale/SSH/Ansible管理面を分離し、Webから任意VM/Podmanコマンドや本番DB復元を提供しない。オフVMバックアップ先の指定はowner UIからできるが、実行はoperator provisioned executorと既存host lock/backup.shを再利用する。
5. Architecture AtlasのMermaid画面・状態図、LikeC4構造図、Threagile脅威と各要求の**正本所有先を明示**する。見た目の図を適合証拠としない。
6. CIのsole plan/impact authority、exact-source job/attempt/artifact identity、単一Pages publisher、Core/FullとChromium/WebKitを維持する。旧testsの削除は独立した証明力に基づき判断する。

## Workstream定義（Issue一件＝完成可能な責務）

| ID | 成果 | 主な所有パス | 先行条件 |
| --- | --- | --- | --- |
| SPEC-01 | StrictDocへ初期30件と追加採用REQの全IDを一回限り移行、source/test relation、逆引きPoC | docs/requirements/、trace専用scripts | なし |
| SPEC-02 | TypeSpec→OpenAPI3.1生成、Redocly/oasdiff、Fastify schema変換契約の検査 | 新規HTTP contract package、spec scripts | なし |
| SPEC-03 | pgTAP＋pg_catalog、SQL migrationとauth schemaの物理検証、tbls生成 | packages/persistence-postgres/tests、DB検証scripts | なし |
| STATE-01 | XState v5による原稿保存・復旧の実行機械と実DB/ブラウザー受入 | appのauthoring/save/recovery機能 | なし |
| OPS-01 | age v2 artifactのS3互換送受信、checksum、独立receipt、isolated restore fixture | deploy/backup/、S3 fixture tests | なし |
| ARCH-01 | LikeC4構造とThreagile脅威/対策、既存Mermaidとのownership維持 | architecture/security models・生成scripts | なし |
| HTTP-01 | Fastify明示routeとAjv/response schema・central admissionへ移行、catch-allを撤去 | packages/api/src/server.ts、persistence-routes.ts | SPEC-02 |
| HTTP-02 | Orval生成clientをWeb/iOSへ導入し、手書きHTTP DTO重複を除去 | app API client/生成出力 | SPEC-02、STATE-01との対象ファイル分離 |
| MCP-01 | 公式MCP SDK v2、2026 protocol、Fastify接続、conformance/権限受入 | modules/mcp/、API MCP adapter | HTTP-01（同一admission境界の固定） |
| CON-01 | /consoleのowner-session shell・認証入口・深いURL/戻り・管理ナビ | app console route shell/Workers route | なし |
| CON-02 | /console/setupの一回限りowner登録とsetup-only API/Ansible整合 | auth/setup API、console setup UI、bootstrap | CON-01 |
| CON-03 | /console/security・identityのPasskey/session/OIDC/OAuth UX・権限 | app console security/identity・Better Auth adapter | CON-01、CON-02と共有ファイルの排他 |
| BKC-01 | backup profile/draft/active・sealed credential・probe・owner session API/運用schema | 独立backup settings API、運用schema、probes | OPS-01、HTTP-01（route統合）、CON-01（共通session） |
| BKC-02 | /console/backups配置・設定フォーム・検証・activate・status/history/recovery UI | app console backup screens | CON-01、BKC-01 |
| BKC-03 | 手動/maintenance-window保全、単一host lock・writer停止・復帰・run receipt・deploy admission接続 | protected backup executor、Ansible backup stage、run tests | OPS-01、BKC-01 |
| STATE-02 | ChangeSet/認証/backupへのXState適用（状態契約・非同期・中断） | 当該UI featureごとのmachine | STATE-01、CON-03/BKC-02とファイル排他 |
| DOC-01 | StrictDoc/Scalar/LikeC4を唯一のRepository Audit Pagesへ公開・表示検証 | scripts/audit/pages/、repository-audit.yml | SPEC-01、SPEC-02、ARCH-01 |
| QUAL-01 | k6性能budgetと異常負荷・streaming regression、現行比較 | scripts/performance/、性能契約 | HTTP-01、MCP-01の受入HEAD |
| TRACE-01 | G0〜G7と実行source/run/artifact証拠、全REQと逆引き・未認定一覧の完成 | scripts/ci-contract等、trace evidence | SPEC-01/02/03と各実装完了 |

## 並列性・統合順序

**初期並列6系列:** SPEC-01、SPEC-02、SPEC-03、STATE-01、OPS-01、ARCH-01。それぞれ専用branch/worktreeを使用してownerパスを競合させない。CON-01は画面・routerのファイル所有者を固定できれば第7系列として独立着手してよい。

**依存が満たされ次第:** SPEC-02→HTTP-01/HTTP-02、HTTP-01→MCP-01、OPS-01/HTTP-01/CON-01→BKC-01、CON-01→CON-02/CON-03、BKC-01→BKC-02/BKC-03。CON-02とCON-03、HTTP-01とMCP-01、STATE-01とHTTP-02など共有ファイルがある組合せは**独立ファイルownershipを確認するまで同時変更しない**。

**統合層:** DOC-01/QUAL-01/TRACE-01は入力が確定した領域から着手できるが、全量のG7認定は必要な実装とテストの証拠が揃うまで成功扱いしない。PRの同一HEAD/CI greenは各領域のrelease/host/実機の適合証拠ではない。

## Issue・PRの共通成果契約

- Issueには Goal、Authority、対象と除外、所有パス、他Issueへの依存、実装義務、セキュリティ反例、機能・統合・CI受入、削除する旧処理を記載する。
- 実装セッションは専用worktree/branchで独立し、実装と独立したレビューを分ける。commit、push、PRは責務として必須。マージはreview/CI/規定の権限のある段階で別判定する。
- 受入は既存テストの実装コピーで代用しない。誤資格、未知route/tool、409/412、リトライ、突然の切断、部分成功、DB失敗、権限失効、暗号化/restore失敗等の該当反例を持つ。
- 追加ライブラリは [Dependency policy](DEPENDENCY-POLICY.md) に従い実導入時点の最新安定版・peer制約・lock identityを記録。不要な新規RPC、control plane、状態DB、CI pipelineを作らない。
- 既存Issue [#615](https://github.com/yohn-jp/codexia/issues/615) は独立テストの負債返済、[#215](https://github.com/yohn-jp/codexia/issues/215) はCI再利用性能、[#168](https://github.com/yohn-jp/codexia/issues/168) は実本番/物理端末の受入、[#633](https://github.com/yohn-jp/codexia/issues/633) は継続開発Supervisor。それらの既存authorityを本計画の新Issueへ無断移管しない。
- 並行中のPRについては開始時の**最新main/全Open PR**を再照合し、同一境界の差分がある場合は統合順と利用SHAを決めてから実装する。

## 設計と実装の完了状態

本書のworkstreamは**Issue化され、各Issueの受入が後続PRで証明されて初めて実装完了**となる。設計書を追加しただけでXState、S3 API、StrictDoc、TypeSpec、MCP v2等が動作していると報告しない。未実装・BLOCKED・PARTIAL・DEVIATION・VERIFIEDを区別し、全量TRACE-01はこれらを隠さず列挙する。
