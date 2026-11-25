# 要求→設計→実装→検証→証拠の双方向トレーサビリティ

**種別: 規範的追跡台帳＋初期棚卸し。** 要求の採否とIDは [Requirements](../requirements/README.md)、要求内容は [Requirement register](../requirements/REQUIREMENT-REGISTER.md) が所有する。この台帳は要件を再定義せず、各obligationの設計、実装、検証、証拠を接続する。

**観測基準:** main@e02933aead466b14cbcd336905b9c2a2a2b39f06（2026-11-23）。コードとテストの**所在**を確認したが、各テストが全要求を証明すること、実行したこと、greenであることは未確認。以下の MAPPED_UNVERIFIED は合格ではない。

## レコードの完全形

| フィールド | 必須内容 |
| --- | --- |
| Requirement / obligation | REQ-ID と個々の義務 O01/O02...。正常、拒否、競合、障害、回復、性能を独立に追跡 |
| Decision / target | ACCEPTED/PROPOSED/RETIRED と現行リリース対象/将来目標 |
| Design owner | 一意の設計正本＋節/anchor＋API Operation/DB object/UI CTRL/外部IF |
| Implementation path | リポジトリパス＋symbol/route/SQLオブジェクト/設定key。処理が別層へ渡る場合は中間adapterも記録 |
| Verification | TEST-ID、再現条件、入力、期待する許可/拒否/回復、実DB/API/画面/VM等の観測点 |
| Evidence | exact SHA、run/job/attempt、artifact ID/digest、環境・profile・ブラウザー・DB、実際の結果 |
| State | UNMAPPED / MAPPED_UNVERIFIED / PARTIAL / DEVIATION / BLOCKED / VERIFIED / NOT_APPLICABLE と理由 |

多対多を許可するが、単なるファイル参照で完結としない。ブラウザー操作→admission→Core→PostgreSQL→receipt→UI復帰、HTTP/stdio MCP→OAuth→effect→提案→作者承認→DBのように**中間境界を通過する処理**も追跡する。運用要求の終点はAction、ホスト上の設定と実行証拠まで含む。

**追加採用機能（未実装）:** REQ-OPS-003にS3互換オブジェクトストレージへの暗号化済みv2バックアップの保管・検証・取得・隔離復元を追加。設計正本は [Backup](../deployment/BACKUP.md)、外部IFは [EXT-OPS-003](../architecture/EXTERNAL-INTERFACES.md)。現行backup.shとrestore drillの所在を特定しているが、S3へのアップロード・取得・権限・復元の実装と実行証拠は**未取得**。S3機能の適合状態は未実装/未検証であり、REQ-OPS-003全体をVERIFIEDにしない。

## 初期要求と実装の対応表

「テスト候補」は名前と所在を確認したもので、要求の合否・証明力は未レビュー。すべての記載済みコードパスは実装上の追跡開始点であり、全呼出経路の検証結果ではない。

| 要求 | 仕様の正本 | 実装の開始点／オブジェクト | テスト候補・不足 | 状態 |
| --- | --- | --- | --- | --- |
| REQ-CORE-001 | [Core](../architecture/CORE.md) | packages/core/src/、packages/module-runtime/ | tests/e2e/core.acceptance.spec.ts | MAPPED_UNVERIFIED |
| REQ-CORE-002 | [Core](../architecture/CORE.md) | packages/api/src/native-knowledge-actions.ts、packages/persistence-postgres/src/postgres-store.ts | tests/e2e/native-review.acceptance.spec.ts | MAPPED_UNVERIFIED |
| REQ-CORE-003 | [Core](../architecture/CORE.md) | packages/api/src/server.ts、packages/persistence-postgres/src/postgres-store.ts | tests/integration/mcp-acceptance.test.mjs | MAPPED_UNVERIFIED |
| REQ-DATA-001 | [Data model](../architecture/DATA-MODEL.md) | packages/persistence-postgres/migrations/0001-initial.sql、0003-project-workspace.sql | packages/persistence-postgres/src/postgres-store.test.ts | MAPPED_UNVERIFIED |
| REQ-DATA-002 | [DB detail](../architecture/DATABASE-DETAIL-CONTRACT.md) | document_revision、document_revision_immutable trigger、edit_operation、packages/api/src/persistence-routes.ts | tests/e2e/persistence-database.acceptance.spec.ts | MAPPED_UNVERIFIED |
| REQ-DATA-003 | [Data model](../architecture/DATA-MODEL.md) | 0001-initial.sql の複合FK、postgres-store.ts | packages/persistence-postgres/src/postgres-store.test.ts | MAPPED_UNVERIFIED |
| REQ-DATA-004 | [DB detail](../architecture/DATABASE-DETAIL-CONTRACT.md) | packages/persistence-postgres/src/migrate.ts、migration-set.ts | migration-set.test.ts、schema-maintenance.test.ts | MAPPED_UNVERIFIED |
| REQ-AUTH-001 | [API auth](../architecture/API-AUTHN-AUTHZ.md) | packages/api/src/oauth-owner.ts、oauth-token.ts、server.ts | tests/e2e/oauth-web.acceptance.spec.ts | MAPPED_UNVERIFIED |
| REQ-AUTH-002 | [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md) | packages/api/src/server.ts、persistence-routes.ts | server.test.ts、oauth-mcp.test.ts | MAPPED_UNVERIFIED |
| REQ-AUTH-003 | [MCP OAuth](../architecture/MCP-OAUTH.md) | packages/api/src/oauth-mcp.ts、modules/mcp/src/http.ts、tools.ts | tests/integration/mcp-acceptance.test.mjs | MAPPED_UNVERIFIED |
| REQ-AUTH-004 | [Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md) | `/console/setup` と `/api/auth/codexia/setup/*` の setup-only 登録経路を実装。旧SSH-forward登録と本番activateは独立の承認境界 | `tests/e2e/passkey-bootstrap.acceptance.spec.ts` と `packages/api/test/passkey-bootstrap.acceptance.test.ts` が隔離環境の候補。本番Edge・VM・owner登録は #168 で未受入 | MAPPED_UNVERIFIED |
| REQ-AUTH-005 | [Admin flow](../design/ADMIN-SCREEN-FLOW.md) | /console、/console/security、/console/identity は現行未実装 | 受入テスト未特定 | UNMAPPED |
| REQ-API-001 | [API contract](../architecture/API-CONTRACT.md) | packages/api/src/server.ts、persistence-routes.ts、各moduleのHTTP contribution | persistence-routes.test.ts。全DTO未収録 | PARTIAL |
| REQ-API-002 | [Interaction](../design/INTERACTION-CONTRACT.md) | persistence-routes.ts、postgres-store.ts、app/src/api.ts | tests/e2e/core.acceptance.spec.ts | MAPPED_UNVERIFIED |
| REQ-MCP-001 | [Modules](../architecture/MODULES.md)、[MCP v2 migration](../architecture/MCP-V2-MIGRATION.md) | modules/mcp/src/http.ts、stdio.ts、tools.ts、tools/shared.ts、tools/project.ts、tools/knowledge.ts | MCPV-001..008; tests/integration/mcp-acceptance.test.mjs; modules/mcp/src/tools.test.ts | MAPPED_UNVERIFIED |
| REQ-MCP-002 | [MCP-first](../architecture/MCP-FIRST.md)、[MCP v2 migration](../architecture/MCP-V2-MIGRATION.md) | modules/mcp/src/tools.ts、tools/shared.ts、tools/project.ts、tools/knowledge.ts | MCPV-001..008; tests/integration/mcp-acceptance.test.mjs | MAPPED_UNVERIFIED |
| REQ-UI-001 | [User flow](../design/USER-SCREEN-FLOW.md) | app/src/launcher.tsx、app/src/shells/ | tests/e2e/modular-workspace.acceptance.spec.ts | MAPPED_UNVERIFIED |
| REQ-UI-002 | [Interaction](../design/INTERACTION-CONTRACT.md) | app/src/storage/、app/src/api.ts、app/src/journal.test.ts | auth-recovery.acceptance.spec.ts、core.acceptance.spec.ts | MAPPED_UNVERIFIED |
| REQ-UI-003 | [Screen catalog](../design/SCREEN-CONTROL-CATALOG.md) | app/src/App.tsx、app/src/components/、app/src/shells/ | ui-v1.acceptance.spec.ts。全CTRL ID未照合 | PARTIAL |
| REQ-UI-004 | [UX](../design/UX-CONTRACT.md) | app/src/editor/、app/src/shells/ | core.acceptance.spec.ts。IME実機は別証拠 | MAPPED_UNVERIFIED |
| REQ-UI-005 | [UX](../design/UX-CONTRACT.md) | app/src/components/、app/src/shells/ | redesign-visual.acceptance.spec.ts。支援技術は別証拠 | PARTIAL |
| REQ-UI-006 | [XState machine](../design/XSTATE-STATE-MACHINE-CONTRACT.md)・[Screen Atlas](../design/SCREEN-STATE-ATLAS.md) | machine未導入。原稿保存/復旧は既存app controllerが観測開始点 | XST-001〜006。v5 actor/machineと独立のブラウザー受入が未実施 | UNMAPPED |
| REQ-EXT-001 | [External IF](../architecture/EXTERNAL-INTERFACES.md) | deploy/cloudflare/ui-routes.json、public-protocol-paths.json、terraform/ | scripts/verification/infrastructure/deployment-config.mjs | MAPPED_UNVERIFIED |
| REQ-EXT-002 | [External IF](../architecture/EXTERNAL-INTERFACES.md) | packages/contracts/src/oauth-metadata.ts、packages/api/src/better-auth.ts、modules/mcp/src/http.ts | oauth-metadata.test.ts | MAPPED_UNVERIFIED |
| REQ-OPS-001 | [Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md) | deploy/ansible/site.yml、auth-runtime.yml | test-auth-runtime-integration.sh。setup-onlyが未実装 | PARTIAL |
| REQ-OPS-002 | [Update flow](../deployment/UPDATE-FLOW.md) | deploy/update-compatibility.json、frontend-compatibility.json、.github/workflows/backend-release.yml | deploy/ansible/test-push-app-lifecycle.sh | MAPPED_UNVERIFIED |
| REQ-OPS-003 | [Backup](../deployment/BACKUP.md) | deploy/backup/、deploy/ansible/restore-drill.yml | 隔離復元の実行証拠未取得 | MAPPED_UNVERIFIED |
| REQ-OPS-004 | [Backup console](../architecture/BACKUP-CONSOLE-CONTRACT.md)、[Admin flow](../design/ADMIN-SCREEN-FLOW.md) | /console/backups、config/secret store、Fastify BKC-001〜007は全て目標・未実装 | BKC-T01〜04/09/10、CON-30〜32とCTRL | UNMAPPED |
| REQ-OPS-005 | [Backup console](../architecture/BACKUP-CONSOLE-CONTRACT.md)、[Backup](../deployment/BACKUP.md) | rootless executor、BKC-008〜010、protected host lock/durable runは追加未実装 | BKC-T05〜10、CON-33/34、隔離host receipt | UNMAPPED |
| REQ-QUAL-001 | [Test architecture](TEST-ARCHITECTURE-OPTIMIZATION.md) | tests/e2e/、tests/integration/、packages/配下test | 義務別の証明力は未監査 | PARTIAL |
| REQ-QUAL-002 | [CI/CD](CI-CD.md) | .github/workflows/verify.yml、scripts/ci/impact/plan.mjs | exact-sourceのrun/artifact未結合 | MAPPED_UNVERIFIED |
| REQ-QUAL-003 | [UX](../design/UX-CONTRACT.md) | scripts/performance/ | 条件固定の計測証拠未取得 | UNMAPPED |
| REQ-TRACE-001 | [Requirements](../requirements/README.md) | この台帳とAPI・DB・外部IFの初期契約 | 全件逆走査・自動gate未実施 | PARTIAL |

## MCP v2 migration verification crosswalk

The accepted MCP requirements remain the conformance authorities; `MCPV-001..008` are verification-plan IDs from [MCP-V2-MIGRATION](../architecture/MCP-V2-MIGRATION.md), not product conformance statuses. Source locations and test case names below are trace candidates. `NOT_RUN` means no exact-source run/artifact was verified for this change. No MCPV item is marked PASS or VERIFIED here.

MCP-specific source mapping was refreshed against current main `af9a7115` (Fastify HTTP platform migration) plus the local SDK v2 tool source changes. The repository requirement-trace gate checks deterministic UIDs/MIDs, source-path and line-range validity, each declared TEST-ID against its case name/source file, explicit requirement parents, and reverse-surface mappings; these checks do not replace protocol, Inspector, OAuth-client, PostgreSQL, or hosted exact-source evidence.

| Plan ID | Requirement link | Source/test candidate | Trace state and remaining evidence |
| --- | --- | --- | --- |
| MCPV-001 | REQ-MCP-001, REQ-MCP-002 | `modules/mcp/src/tools.test.ts`: “native MCP schemas bound UUID reads and accept only the seven ordinary native ChangeSet operations” (`TEST-MCPV-001-001`); package TypeScript check | MAPPED_UNVERIFIED; verify all registered tools compile and input/output schemas validate at runtime; exact run NOT_RUN |
| MCPV-002 | REQ-MCP-001 | `npx @modelcontextprotocol/conformance server --url <isolated-url>/mcp --requirements 2026-07-28` per migration design | UNMAPPED; no isolated protocol-conformance run or required-scenario report is attached; exact run NOT_RUN |
| MCPV-003 | REQ-MCP-001 | MCP Inspector CLI/Web per migration design | UNMAPPED; no interop/reconnect/version-negotiation record is attached; exact run NOT_RUN |
| MCPV-004 | REQ-MCP-001, REQ-MCP-002 | `tests/integration/mcp-acceptance.test.mjs`: “native Knowledge MCP tools preserve PostgreSQL scope, proposal, replay, review and receipt over both transports” (`TEST-MCPV-004-001`); `packages/api/src/server.test.ts`: “admits registered MCP OAuth clients by exact operation scope without owner rights” (`TEST-MCPV-004-002`) | PARTIAL; current candidates do not by themselves prove revoked clients, every scope boundary, owner separation, or all cross-project denials; exact run NOT_RUN |
| MCPV-005 | REQ-MCP-001 | same native Knowledge PostgreSQL scenario (`TEST-MCPV-004-001`) | PARTIAL; source includes project scope, replay, author review/application, and receipt checks; the PostgreSQL restart dimension and exact execution evidence remain outstanding; exact run NOT_RUN |
| MCPV-006 | REQ-MCP-001 | `tests/integration/mcp-acceptance.test.mjs`: “MCP cancellation stops real NLP worker jobs through stdio and Streamable HTTP” (`TEST-MCPV-006-001`) | PARTIAL; cancellation is a candidate slice; invalid headers, oversized inputs, shutdown/drain, and cross-request/client isolation remain separate obligations; exact run NOT_RUN |
| MCPV-007 | REQ-MCP-001 | isolated 2026-only and explicitly bounded 2025 fallback scenarios per migration design | UNMAPPED; no protocol-era execution result is attached; exact run NOT_RUN |
| MCPV-008 | REQ-MCP-001, REQ-MCP-002 | external MCP client OAuth PKCE, token refresh, project selection, and Tool/Result interaction per migration design | UNMAPPED; owner OAuth tests or local signed-token fixtures do not establish external MCP client interop; exact run NOT_RUN |

`TEST-MCP-CORE-001-001` links the existing external Assistant admission/no-provider-call case to REQ-MCP-002; it is not a substitute for MCPV-002 protocol conformance. The case names are declared in StrictDoc nodes, and their source file relations use line coordinates. The Better Auth integration case for real MCP OAuth PKCE issuance remains pending and is not mapped until its exact test title and source range are available. Keep these mappings at MAPPED_UNVERIFIED/PARTIAL until the named cases are reviewed and exact-source evidence is captured.

## E2E追跡例 — 保存・競合・復旧

1. REQ-DATA-002:O01（Revision不変）→ DATA-MODEL → 0001-initial.sql の document_revision と document_revision_immutable → Postgres実装 → UPDATE/DELETE拒否の実DBテスト → exact-sourceの結果。
2. REQ-API-002:O01（競合時に偽成功を返さない）→ INTERACTION-CONTRACT / API-CONTRACT → PATCH /api/v1/persistence/projects/:p/documents/:d → persistence-routes.ts → postgres-store.ts → 409/元の原稿保全/receiptのAPI・ブラウザーE2E → 実行結果。
3. REQ-UI-002:O01（保存範囲の正しい表示）→ SCREEN-CONTROL-CATALOG / INTERACTION-CONTRACT → journalとUI保存controller → API → DB receipt → 応答損失・追加編集・再読込・容量不足のブラウザー受入結果。

**上記は必要な追跡経路の例であり、実行確認済みの証明ではない。** 途中で接続先が欠ければPARTIALである。

## 実装からの逆走査を必須にする

| 走査元 | 仕様との対応付け対象 |
| --- | --- |
| packages/api/src/server.ts、persistence-routes.ts、Better Auth、各module HTTP contribution | 全 method+route、入力・出力DTO、拒否、エラー |
| modules/mcp/src/tools/、module action manifest | 全tool名、effect、scope、input/output Schema |
| packages/persistence-postgres/migrations/、認証スキーマ | 全table/column/index/FK/trigger/roleとmigration |
| app/src/ | 全画面・CTRL/CTA・状態・遷移・認可 |
| ios/**/Sources/ | Native iOS SwiftUI view型とtransport入口。source declarationは実機・挙動の受入証拠ではない |
| deploy/cloudflare/terraform/、deploy/ansible/ | IaC resource、playbook、inventory設定。宣言と実環境適用・収束の証拠を区別 |
| deploy/、.github/workflows/ | Edge、IaC、更新、秘密管理、バックアップ、CI gate |
| 全test、tests/e2e、tests/integration | どのobligationを何の期待値で証明するか |

「対応要求なし」は正本への自動編入を意味しない。仕様外/旧設計残骸/内部補助/新規提案を区別し、ownerと理由を記録する。

## 将来の自動検証への受入条件

- ID重複、参照先欠落、未採用要件への実装対応、正本所有の重複を検出する。
- 全route+method、MCP tool、DB object、画面CTRL、外部IFから採用済み要求へ逆走査し、未対応を検出する。
- スキーマと実装の差分、権限差、未実装の設計目標、変更された実装の影響要求・試験を提示する。
- VERIFIEDは該当義務のexact-source証拠を持つ場合のみ。追加したMarkdownやCIの存在だけでは昇格させない。

## 生成された追跡結果

義務を追加・修正するときは [Requirement register](../requirements/REQUIREMENT-REGISTER.md) の StrictDoc node を編集する。
既存の `requirements-trace` は、node の義務 ID、設計・実装参照、TEST ID を `trace-report.json` の `obligationTrace` に出力し、実装側から見つかった要素と義務の対応を `reverseTrace` に記録する。
両方の表は同じ義務 ID で照合できる。
識別子が分からない要素や、観測できない範囲と必要な証拠は、生成結果の残件として残る。

`caseExecutions` の結果は、そのテストケースが実際に実行されたことを示す。
GitHub Actions 上の実行では同じレポートの `execution` が source SHA、run、attempt、job、task を保持し、既存の Verify が選択した証拠 ZIP の ID・ダイジェストと照合する。
製品側の各義務は、実装の識別子、必要な試験とその証明力、対応する環境と証拠が揃うまで、既存の適合状態を保つ。
公開 Pages は StrictDoc HTML と JSON を既存 publisher から配布する。
実行レポートは Verify の証拠で参照する。
