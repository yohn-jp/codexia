---
Grammar: STRICTDOC-GRAMMAR.gra.md
---
# Codexia accepted requirement register

この文書が採用済み製品要求の唯一の編集正本である。HTML/JSONはStrictDocから生成する派生物。元の33件のREQ-IDと検証可能な要求文を一度だけ移行した。実装候補とテスト候補のリンクは適合証拠ではない。

## REQ-CORE-001

**MID**: 92e471d983d9375170f8efc2eb20eb43
**UID**: REQ-CORE-001
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [System design](../architecture/SYSTEM-DESIGN.md)、[Core](../architecture/CORE.md)
**Implementation identifiers**: packages/core/src/; packages/module-runtime/
**Verification identifiers**: tests/e2e/core.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

Optional module停止・未導入でも作品作成、執筆、保存、履歴、復元を継続する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/SYSTEM-DESIGN.md
- **Type**: File
  **Path**: docs/architecture/CORE.md
- **Type**: File
  **Path**: tests/e2e/core.acceptance.spec.ts

## REQ-CORE-002

**MID**: fddfda8c0e816de124b2f7206e7f78cd
**UID**: REQ-CORE-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Core](../architecture/CORE.md)、[Modules](../architecture/MODULES.md)
**Implementation identifiers**: packages/api/src/native-knowledge-actions.ts; packages/persistence-postgres/src/postgres-store.ts
**Verification identifiers**: tests/e2e/native-review.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

module/MCPの変更は提案を経由し、作者承認・再検査前に原稿を直接変更しない

**Relations**:

- **Type**: File
  **Path**: docs/architecture/CORE.md
- **Type**: File
  **Path**: docs/architecture/MODULES.md
- **Type**: File
  **Path**: packages/api/src/native-knowledge-actions.ts
- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.ts
- **Type**: File
  **Path**: tests/e2e/native-review.acceptance.spec.ts

## REQ-CORE-003

**MID**: c44c1b1260eb80b27eefb84ad6b51406
**UID**: REQ-CORE-003
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Core](../architecture/CORE.md)
**Implementation identifiers**: packages/api/src/server.ts; packages/persistence-postgres/src/postgres-store.ts
**Verification identifiers**: tests/integration/mcp-acceptance.test.mjs
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

Snapshotをproject/versionへ固定し、古い参照や別projectの結果を現行状態として使わない

**Relations**:

- **Type**: File
  **Path**: docs/architecture/CORE.md
- **Type**: File
  **Path**: packages/api/src/server.ts
- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.ts
- **Type**: File
  **Path**: tests/integration/mcp-acceptance.test.mjs

## REQ-DATA-001

**MID**: e5307f1475469b659a8d449fc5a0e200
**UID**: REQ-DATA-001
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: packages/persistence-postgres/migrations/0001-initial.sql; 0003-project-workspace.sql
**Verification identifiers**: packages/persistence-postgres/src/postgres-store.test.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

原稿・構成・Revision・Knowledge・Evidence・ChangeSet・module recordの正本はPostgreSQLのみ

**Relations**:

- **Type**: File
  **Path**: docs/architecture/DATA-MODEL.md
- **Type**: File
  **Path**: packages/persistence-postgres/migrations/0001-initial.sql
- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.test.ts

## REQ-DATA-002

**MID**: 007dd05315cc86292a93e108e688d796
**UID**: REQ-DATA-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Data model](../architecture/DATA-MODEL.md)、[Core](../architecture/CORE.md)
**Implementation identifiers**: document_revision; document_revision_immutable trigger; edit_operation; packages/api/src/persistence-routes.ts
**Verification identifiers**: tests/e2e/persistence-database.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

原稿revisionは不変で、保存・復元は整合性を守る新RevisionとDB receiptで表す

**Relations**:

- **Type**: File
  **Path**: docs/architecture/DATA-MODEL.md
- **Type**: File
  **Path**: docs/architecture/CORE.md
- **Type**: File
  **Path**: packages/api/src/persistence-routes.ts
- **Type**: File
  **Path**: tests/e2e/persistence-database.acceptance.spec.ts

## REQ-DATA-003

**MID**: 7ed62661666f111b1326977dd407e519
**UID**: REQ-DATA-003
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: 0001-initial.sql の複合FK; postgres-store.ts
**Verification identifiers**: packages/persistence-postgres/src/postgres-store.test.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

project境界をすべての関連オブジェクト・階層・根拠・提案の参照と書込で保持する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/DATA-MODEL.md
- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.test.ts

## REQ-DATA-004

**MID**: 2fd422dfc7f2115ff4a44f858905d5b8
**UID**: REQ-DATA-004
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Data model](../architecture/DATA-MODEL.md)、[Update flow](../deployment/UPDATE-FLOW.md)
**Implementation identifiers**: packages/persistence-postgres/src/migrate.ts; migration-set.ts
**Verification identifiers**: packages/persistence-postgres/src/migration-set.test.ts; packages/persistence-postgres/src/schema-maintenance.test.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

既存migrationのchecksum/fingerprintを検証し、未承認のDB schema変更をアプリ更新で行わない

**Relations**:

- **Type**: File
  **Path**: docs/architecture/DATA-MODEL.md
- **Type**: File
  **Path**: docs/deployment/UPDATE-FLOW.md
- **Type**: File
  **Path**: packages/persistence-postgres/src/migrate.ts
- **Type**: File
  **Path**: packages/persistence-postgres/src/migration-set.test.ts
- **Type**: File
  **Path**: packages/persistence-postgres/src/schema-maintenance.test.ts

## REQ-AUTH-001

**MID**: ed2b65f98d9d2d9b409105157c1629cf
**UID**: REQ-AUTH-001
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md)
**Implementation identifiers**: packages/api/src/oauth-owner.ts; oauth-token.ts; server.ts
**Verification identifiers**: tests/e2e/oauth-web.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

owner APIはCodexia発行OAuth bearerを署名・audience・scope・ownerとして検証する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/API-AUTHN-AUTHZ.md
- **Type**: File
  **Path**: packages/api/src/oauth-owner.ts
- **Type**: File
  **Path**: tests/e2e/oauth-web.acceptance.spec.ts

## REQ-AUTH-002

**MID**: dbadd0a9d5ffe4d1daca067a90a4b332
**UID**: REQ-AUTH-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: packages/api/src/server.ts; persistence-routes.ts; packages/api/src/better-auth.ts (API-OWNER-SESSION-001 read-only OWNER-SESSION confirmation)
**Verification identifiers**: packages/api/src/server.test.ts; packages/api/src/oauth-mcp.test.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

HTTP methodとpathだけでなくprincipal・project・object・revision・effectでfail-closed認可する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/ROUTE-AUTHORIZATION-CONTRACT.md
- **Type**: File
  **Path**: docs/architecture/API-CONTRACT.md
- **Type**: File
  **Path**: packages/api/src/server.ts
- **Type**: File
  **Path**: packages/api/src/server.test.ts
- **Type**: File
  **Path**: packages/api/src/oauth-mcp.test.ts

## REQ-AUTH-003

**MID**: a2f6832213e2e0d2e71082b0c87a2e0e
**UID**: REQ-AUTH-003
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [MCP OAuth](../architecture/MCP-OAUTH.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: packages/api/src/oauth-mcp.ts; modules/mcp/src/http.ts; tools.ts
**Verification identifiers**: tests/integration/mcp-acceptance.test.mjs
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

MCP clientは割当projectとread/compute/proposeまで。承認/applyやowner私有操作を行えない

**Relations**:

- **Type**: File
  **Path**: docs/architecture/MCP-OAUTH.md
- **Type**: File
  **Path**: docs/architecture/ROUTE-AUTHORIZATION-CONTRACT.md
- **Type**: File
  **Path**: packages/api/src/oauth-mcp.ts
- **Type**: File
  **Path**: modules/mcp/src/http.ts
- **Type**: File
  **Path**: tests/integration/mcp-acceptance.test.mjs

## REQ-AUTH-004

**MID**: 98f28a41293b47032faa301b09ce740e
**UID**: REQ-AUTH-004
**Decision status**: ACCEPTED
**Conformance status**: UNMAPPED
**Applicability**: FUTURE_TARGET
**Design owner**: [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md)、[Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md)
**Implementation identifiers**: 目標の /console/setup と setup-only API は現行未実装。旧bootstrapを目標仕様と混同しない
**Verification identifiers**: tests/e2e/passkey-bootstrap.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／**目標・未実装**; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

Passkey-firstの初回owner登録は一回限りsetup資格、owner不在、認証ceremonyを満たす

**Relations**:

- **Type**: File
  **Path**: docs/architecture/API-AUTHN-AUTHZ.md
- **Type**: File
  **Path**: docs/deployment/INITIAL-DEPLOYMENT-FLOW.md
- **Type**: File
  **Path**: tests/e2e/passkey-bootstrap.acceptance.spec.ts

## REQ-AUTH-005

**MID**: 962171018b777bef7028ea6af006f662
**UID**: REQ-AUTH-005
**Decision status**: ACCEPTED
**Conformance status**: UNMAPPED
**Applicability**: FUTURE_TARGET
**Design owner**: [Admin screen flow](../design/ADMIN-SCREEN-FLOW.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: /console; /console/security; /console/identity は現行未実装
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／**目標・未実装**; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

`/console`管理、Passkey/session、OIDC設定はowner権限と再認証に拘束する

**Relations**:

- **Type**: File
  **Path**: docs/design/ADMIN-SCREEN-FLOW.md
- **Type**: File
  **Path**: docs/architecture/ROUTE-AUTHORIZATION-CONTRACT.md

## REQ-API-001

**MID**: 1da786a43f72f653d2cd7d1a3551d9f6
**UID**: REQ-API-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [API contract](../architecture/API-CONTRACT.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: packages/api/src/server.ts; persistence-routes.ts; 各moduleのHTTP contribution
**Verification identifiers**: packages/api/src/persistence-routes.test.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／設計台帳の全面検証待ち; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

APIの入口、body/query、レスポンス、エラー、認可、競合、冪等性をmethod/path/Operationで特定する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/API-CONTRACT.md
- **Type**: File
  **Path**: docs/architecture/ROUTE-AUTHORIZATION-CONTRACT.md
- **Type**: File
  **Path**: packages/api/src/server.ts
- **Type**: File
  **Path**: packages/api/src/persistence-routes.test.ts

## REQ-API-002

**MID**: 8ffbcb3626affc11f13e649ed5cf1a02
**UID**: REQ-API-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Core](../architecture/CORE.md)、[Interaction contract](../design/INTERACTION-CONTRACT.md)
**Implementation identifiers**: persistence-routes.ts; postgres-store.ts; app/src/api.ts
**Verification identifiers**: tests/e2e/core.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

作者向けMutationでrequest identity・precondition・receiptを確認し、競合/応答不明を偽成功にしない

**Relations**:

- **Type**: File
  **Path**: docs/architecture/CORE.md
- **Type**: File
  **Path**: docs/design/INTERACTION-CONTRACT.md
- **Type**: File
  **Path**: app/src/api.ts
- **Type**: File
  **Path**: tests/e2e/core.acceptance.spec.ts

## REQ-MCP-001

**MID**: d88c4eafb567643571dfdac39b451bbf
**UID**: REQ-MCP-001
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [MCP-first](../architecture/MCP-FIRST.md)、[Modules](../architecture/MODULES.md)
**Implementation identifiers**: modules/mcp/src/http.ts; stdio.ts; tools.ts
**Verification identifiers**: tests/integration/mcp-acceptance.test.mjs
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

stdioとHTTPのMCPは同じCore action/effect境界に到達し、独立writerを持たない

**Relations**:

- **Type**: File
  **Path**: docs/architecture/MCP-FIRST.md
- **Type**: File
  **Path**: docs/architecture/MODULES.md
- **Type**: File
  **Path**: modules/mcp/src/http.ts
- **Type**: File
  **Path**: tests/integration/mcp-acceptance.test.mjs

## REQ-MCP-002

**MID**: cd52c2dfae742db14351fecaa42331c7
**UID**: REQ-MCP-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [MCP-first](../architecture/MCP-FIRST.md)
**Implementation identifiers**: modules/mcp/src/tools.ts; tools/shared.ts
**Verification identifiers**: tests/integration/mcp-acceptance.test.mjs
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

外部AIによる推論とCodexia内のCore編集を分離し、内部LLM API拡張を再開しない

**Relations**:

- **Type**: File
  **Path**: docs/architecture/MCP-FIRST.md
- **Type**: File
  **Path**: modules/mcp/src/tools.ts
- **Type**: File
  **Path**: tests/integration/mcp-acceptance.test.mjs

## REQ-UI-001

**MID**: b67567c59a7c147a08ef65e95b62bbd4
**UID**: REQ-UI-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [UX contract](../design/UX-CONTRACT.md)、[iOS architecture](../architecture/IOS-SWIFTUI-ARCHITECTURE.md)
**Implementation identifiers**: app/src/launcher.tsx; app/src/shells/
**Verification identifiers**: tests/e2e/modular-workspace.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: Desktop web mapping exists; iOS implementation and physical-device acceptance remain unverified, so this cross-platform requirement is only partial.

Desktop React WebとiOS SwiftUIはUIを共有せず、共通のCore/API・Revision・保存/復旧契約を満たす。Mobile Web/PWA作者UIは対象外

**Relations**:

- **Type**: File
  **Path**: docs/design/UX-CONTRACT.md
- **Type**: File
  **Path**: docs/architecture/IOS-SWIFTUI-ARCHITECTURE.md
- **Type**: File
  **Path**: app/src/launcher.tsx
- **Type**: File
  **Path**: tests/e2e/modular-workspace.acceptance.spec.ts

## REQ-UI-002

**MID**: 340d6519232659932dbdaec6237e7b82
**UID**: REQ-UI-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Interaction contract](../design/INTERACTION-CONTRACT.md)、[UX contract](../design/UX-CONTRACT.md)
**Implementation identifiers**: app/src/storage/; app/src/api.ts; app/src/journal.test.ts
**Verification identifiers**: tests/e2e/auth-recovery.acceptance.spec.ts; tests/e2e/core.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

未送信/保存中/DB確定/応答不明を区別し、下書きを黙って捨てない

**Relations**:

- **Type**: File
  **Path**: docs/design/INTERACTION-CONTRACT.md
- **Type**: File
  **Path**: docs/design/UX-CONTRACT.md
- **Type**: File
  **Path**: app/src/api.ts
- **Type**: File
  **Path**: app/src/journal.test.ts
- **Type**: File
  **Path**: tests/e2e/auth-recovery.acceptance.spec.ts
- **Type**: File
  **Path**: tests/e2e/core.acceptance.spec.ts

## REQ-UI-003

**MID**: 36bebb605863f74dde54ec6552d3a350
**UID**: REQ-UI-003
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Screen catalog](../design/SCREEN-CONTROL-CATALOG.md)、[State Atlas](../design/SCREEN-STATE-ATLAS.md)
**Implementation identifiers**: app/src/App.tsx; app/src/components/; app/src/shells/
**Verification identifiers**: tests/e2e/ui-v1.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／設計済み・適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

画面、操作、遷移、戻り先、エラー、principalを画面ID/CTRL IDで特定する

**Relations**:

- **Type**: File
  **Path**: docs/design/SCREEN-CONTROL-CATALOG.md
- **Type**: File
  **Path**: docs/design/SCREEN-STATE-ATLAS.md
- **Type**: File
  **Path**: app/src/App.tsx
- **Type**: File
  **Path**: tests/e2e/ui-v1.acceptance.spec.ts

## REQ-UI-004

**MID**: 2f4e5f4c69d3f698da4db40133a73bb0
**UID**: REQ-UI-004
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [UX contract](../design/UX-CONTRACT.md)
**Implementation identifiers**: app/src/editor/; app/src/shells/
**Verification identifiers**: tests/e2e/core.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

IME、選択、focus、編集中の遅延・画面移動でも原稿と復旧可能性を保持する

**Relations**:

- **Type**: File
  **Path**: docs/design/UX-CONTRACT.md
- **Type**: File
  **Path**: tests/e2e/core.acceptance.spec.ts

## REQ-UI-005

**MID**: 0350c31a526959de6554b0a6c1ff960f
**UID**: REQ-UI-005
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [UX contract](../design/UX-CONTRACT.md)
**Implementation identifiers**: app/src/components/; app/src/shells/
**Verification identifiers**: tests/e2e/redesign-visual.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

適用可能なWCAG 2.2 A/AA、keyboard、reflow等の受入義務を満たす

**Relations**:

- **Type**: File
  **Path**: docs/design/UX-CONTRACT.md
- **Type**: File
  **Path**: tests/e2e/redesign-visual.acceptance.spec.ts

## REQ-UI-006

**MID**: 75284b8b389d3d311edce1c19e4029c6
**UID**: REQ-UI-006
**Decision status**: ACCEPTED
**Conformance status**: UNMAPPED
**Applicability**: FUTURE_TARGET
**Design owner**: [XState contract](../design/XSTATE-STATE-MACHINE-CONTRACT.md)、[Screen Atlas](../design/SCREEN-STATE-ATLAS.md)
**Implementation identifiers**: machine未導入。原稿保存/復旧は既存app controllerが観測開始点
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／XState v5導入は**目標・未実装**; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

原稿保存・復旧、ChangeSet、認証、バックアップの複雑な状態と失敗・競合・接続断を決定的な遷移と独立テストで検証し、未確認の副作用を成功表示にしない

**Relations**:

- **Type**: File
  **Path**: docs/design/XSTATE-STATE-MACHINE-CONTRACT.md
- **Type**: File
  **Path**: docs/design/SCREEN-STATE-ATLAS.md

## REQ-EXT-001

**MID**: a3a584fb55f4b2aa688acf1243deb5f3
**UID**: REQ-EXT-001
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Deployment](../deployment/README.md)、[System design](../architecture/SYSTEM-DESIGN.md)
**Implementation identifiers**: deploy/cloudflare/ui-routes.json; public-protocol-paths.json; terraform/
**Verification identifiers**: scripts/verify-deployment-config.mjs
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

Edgeの静的UI配信とAPI/Tunnelのルーティングを分け、AccessをCore認可の代わりにしない

**Relations**:

- **Type**: File
  **Path**: docs/deployment/README.md
- **Type**: File
  **Path**: docs/architecture/SYSTEM-DESIGN.md
- **Type**: File
  **Path**: deploy/cloudflare/ui-routes.json
- **Type**: File
  **Path**: scripts/verify-deployment-config.mjs

## REQ-EXT-002

**MID**: e752ee48cf448d04c76e06aaad7394f5
**UID**: REQ-EXT-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)、[External interfaces](../architecture/EXTERNAL-INTERFACES.md)
**Implementation identifiers**: packages/contracts/src/oauth-metadata.ts; packages/api/src/better-auth.ts; modules/mcp/src/http.ts
**Verification identifiers**: packages/contracts/src/oauth-metadata.test.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

OAuth/OIDC、MCP、公開readerの外部境界はscope/audience/公開範囲を個別に検証する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/ROUTE-AUTHORIZATION-CONTRACT.md
- **Type**: File
  **Path**: docs/architecture/EXTERNAL-INTERFACES.md
- **Type**: File
  **Path**: packages/contracts/src/oauth-metadata.ts
- **Type**: File
  **Path**: packages/api/src/better-auth.ts
- **Type**: File
  **Path**: modules/mcp/src/http.ts
- **Type**: File
  **Path**: packages/contracts/src/oauth-metadata.test.ts

## REQ-OPS-001

**MID**: 5f8a8fd04ffea1957b4289dd57c5e2a2
**UID**: REQ-OPS-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md)
**Implementation identifiers**: deploy/ansible/site.yml; auth-runtime.yml
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／一部目標・適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

新規VMのbootstrap、owner登録、公開、復旧を明示した別状態として扱う

**Relations**:

- **Type**: File
  **Path**: docs/deployment/INITIAL-DEPLOYMENT-FLOW.md
- **Type**: File
  **Path**: deploy/ansible/site.yml

## REQ-OPS-002

**MID**: ce4f2bf883e22452b4a76a7a5d58e84a
**UID**: REQ-OPS-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Update flow](../deployment/UPDATE-FLOW.md)、[CI/CD](../verification/CI-CD.md)
**Implementation identifiers**: deploy/update-compatibility.json; frontend-compatibility.json; .github/workflows/backend-release.yml
**Verification identifiers**: deploy/ansible/test-push-app-lifecycle.sh
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

更新はexact-source検証、互換性、snapshot保全、失敗時停止/rollback規則を守る

**Relations**:

- **Type**: File
  **Path**: docs/deployment/UPDATE-FLOW.md
- **Type**: File
  **Path**: docs/verification/CI-CD.md
- **Type**: File
  **Path**: deploy/update-compatibility.json
- **Type**: File
  **Path**: .github/workflows/backend-release.yml
- **Type**: File
  **Path**: deploy/ansible/test-push-app-lifecycle.sh

## REQ-OPS-003

**MID**: e4124266c15f499a077b6ff54563008b
**UID**: REQ-OPS-003
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Backup](../deployment/BACKUP.md)
**Implementation identifiers**: deploy/backup/; deploy/ansible/restore-drill.yml
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／S3対応は未実装・適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

バックアップと隔離復元でPostgreSQL正本と運用状態の復旧を検証する。**S3互換ストレージへのage暗号化済みバックアップの転送・検証・取得・隔離復元をサポートする（追加機能は未実装）**

**Relations**:

- **Type**: File
  **Path**: docs/deployment/BACKUP.md
- **Type**: File
  **Path**: deploy/ansible/restore-drill.yml

## REQ-OPS-004

**MID**: 4c77b2e2f9b1aa8aef0dd51ae3d35222
**UID**: REQ-OPS-004
**Decision status**: ACCEPTED
**Conformance status**: UNMAPPED
**Applicability**: FUTURE_TARGET
**Design owner**: [Backup console](../architecture/BACKUP-CONSOLE-CONTRACT.md)、[Admin flow](../design/ADMIN-SCREEN-FLOW.md)
**Implementation identifiers**: /console/backups; config/secret store; Fastify BKC-001〜007は全て目標・未実装
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／画面/API/secret storeは**未実装**; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

ownerは管理コンソールからS3互換バックアップ先のdraft/検証/有効化/停止を操作できる。資格情報write-only、revisionとfresh再認証、operator保護のlocal staging/age鍵の非変更を保証する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/BACKUP-CONSOLE-CONTRACT.md
- **Type**: File
  **Path**: docs/design/ADMIN-SCREEN-FLOW.md

## REQ-OPS-005

**MID**: 8aff323e8c18bb058160c82a27869785
**UID**: REQ-OPS-005
**Decision status**: ACCEPTED
**Conformance status**: UNMAPPED
**Applicability**: FUTURE_TARGET
**Design owner**: [Backup console](../architecture/BACKUP-CONSOLE-CONTRACT.md)、[Backup](../deployment/BACKUP.md)
**Implementation identifiers**: rootless executor; BKC-008〜010; protected host lock/durable runは追加未実装
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／executor/画面/ジョブは**未実装**; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

ownerが手動保全を要求してrun/暗号文/独立復旧証拠を区別して確認でき、実副作用は既存host lock/backup.shと保護されたexecutorだけが実施。本番復元・遠隔削除をWebから禁止する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/BACKUP-CONSOLE-CONTRACT.md
- **Type**: File
  **Path**: docs/deployment/BACKUP.md

## REQ-QUAL-001

**MID**: 9bfc3694283aff3d376a2a615a38f4bd
**UID**: REQ-QUAL-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Test architecture](../verification/TEST-ARCHITECTURE-OPTIMIZATION.md)
**Implementation identifiers**: tests/e2e/; tests/integration/; packages/配下test
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

テストは契約の正常/異常/境界と実DB/API/UI/hostを分け、モックでは境界統合を証明しない

**Relations**:

- **Type**: File
  **Path**: docs/verification/TEST-ARCHITECTURE-OPTIMIZATION.md

## REQ-QUAL-002

**MID**: 430a641c09fcc6c2f116d72d7d1db617
**UID**: REQ-QUAL-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [CI/CD](../verification/CI-CD.md)
**Implementation identifiers**: .github/workflows/verify.yml; scripts/ci-impact.mjs
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

CIは選択タスク、exact-source、成果物IDと必須gateを証明し、未実行/欠落をPASSとしない

**Relations**:

- **Type**: File
  **Path**: docs/verification/CI-CD.md
- **Type**: File
  **Path**: .github/workflows/verify.yml
- **Type**: File
  **Path**: scripts/ci-impact.mjs

## REQ-QUAL-003

**MID**: b33da6513a3ef2c6dc165912550fccab
**UID**: REQ-QUAL-003
**Decision status**: ACCEPTED
**Conformance status**: UNMAPPED
**Applicability**: CURRENT
**Design owner**: [UX contract](../design/UX-CONTRACT.md)、[Performance](../performance/README.md)
**Implementation identifiers**: scripts/performance/
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／計測状態未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

INP p75、CLS p75の品質目安に加え、原稿入力・保存・復旧の別々の実測で評価する

**Relations**:

- **Type**: File
  **Path**: docs/design/UX-CONTRACT.md
- **Type**: File
  **Path**: docs/performance/README.md

## REQ-TRACE-001

**MID**: 5178ac05b8be2783fc02a6a8f24dc3cf
**UID**: REQ-TRACE-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Requirements governance](README.md)、[Traceability register](../verification/TRACEABILITY-REGISTER.md)
**Implementation identifiers**: この台帳とAPI・DB・外部IFの初期契約
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: TEST-TRC-01-001, TEST-TRC-02-001, TEST-TRC-02-002, TEST-TRC-03-001, TEST-TRC-04-001, TEST-TRC-04-002, TEST-TRC-05-001, TEST-TRC-05-002, TEST-TRC-05-003, TEST-TRC-07-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／**構築中**; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

すべての採用済み要求のobligationを正本→実装→検証→証拠まで双方向に追跡する

**Relations**:

- **Type**: File
  **Path**: docs/requirements/README.md
- **Type**: File
  **Path**: docs/verification/TRACEABILITY-REGISTER.md

## TEST-TRC-01-001

**Type**: TEST
**MID**: e3482a445ad89e23de0934b7060fb831
**UID**: TEST-TRC-01-001
**Case name**: rejects duplicate requirement UIDs and unstable MIDs
**Exact-run reference**: NOT_RUN

Reject a duplicate REQ UID and a non-deterministic MID before any trace result can be accepted.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-02-001

**Type**: TEST
**MID**: 142f8d11bd7808018d86a61ae7ad234b
**UID**: TEST-TRC-02-001
**Case name**: normalizes only the observed StrictDoc HTML volatility
**Exact-run reference**: NOT_RUN

Normalize the observed search index timestamp and volatile shell MID while preserving requirement MIDs and ordinary source text.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-03-001

**Type**: TEST
**MID**: 0b50405ac994547b312f8858a5c6373c
**UID**: TEST-TRC-03-001
**Case name**: rejects missing files and ranges beyond the referenced source
**Exact-run reference**: NOT_RUN

Reject a deleted File relation and a line range outside the referenced source file.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-04-001

**Type**: TEST
**MID**: f0fa01e090c0dd89617942f1bf473c0d
**UID**: TEST-TRC-04-001
**Case name**: reports discovered runtime surfaces that lack an explicit classification
**Exact-run reference**: NOT_RUN

Keep a discovered route or database object visible as unclassified until it has a reasoned requirement or non-requirement classification.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-04-002

**Type**: TEST
**MID**: 08934503ff235c4aeddbf3cfbefc600f
**UID**: TEST-TRC-04-002
**Case name**: discovers an unclassified SQL object from source instead of trusting cached inventory data
**Exact-run reference**: NOT_RUN

Derive bounded inventory entries from current source files so an unclassified SQL table or route fixture cannot be hidden by an unchanged cached discovered list.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-05-001

**Type**: TEST
**MID**: 140994365cbcd7dbb64e9fb7c5684b96
**UID**: TEST-TRC-05-001
**Case name**: requires complete exact GitHub run identity when running in Actions
**Exact-run reference**: NOT_RUN

Require the repository, SHA, run ID, attempt, job, and task before recording a GitHub Actions run reference.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-05-002

**Type**: TEST
**MID**: 8f0c942ae1d8c4ada43721d71cc2c230
**UID**: TEST-TRC-05-002
**Case name**: keeps local execution as NOT_RUN instead of inventing a CI link
**Exact-run reference**: NOT_RUN

Record local verification as NOT_RUN with no synthesized workflow URL.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-05-003

**Type**: TEST
**MID**: 579c4dfa47305f4a4ba796d297302a2d
**UID**: TEST-TRC-05-003
**Case name**: requires each TEST-ID to resolve to a declared requirement and a real test case
**Exact-run reference**: NOT_RUN

Reject test IDs with an absent parent requirement, missing case name, or source-file text that does not contain the declared case name.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-07-001

**Type**: TEST
**MID**: 3771602c3129d2aeeb52306a21e8013b
**UID**: TEST-TRC-07-001
**Case name**: renders every requirement UID from the staged StrictDoc HTML page
**Exact-run reference**: NOT_RUN

Use Playwright to open the generated static page and verify that every UID in the generated JSON is visible in the browser.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.browser.mjs

## TEST-TRC-02-002

**Type**: TEST
**MID**: e1f17904a09691d2dd5d777e2639577e
**UID**: TEST-TRC-02-002
**Case name**: canonicalizes only StrictDoc search index object keys and set membership order
**Exact-run reference**: NOT_RUN

Canonicalize StrictDoc search-index keys and unordered set membership while preserving all other generated JavaScript text.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs
