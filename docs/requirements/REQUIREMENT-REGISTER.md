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
**Test IDs**: TEST-CORE-001-001
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

## OBL-REQ-CORE-001-O01

**Type**: OBLIGATION
**MID**: f48e7869132615dd5f981973829b8ec8
**UID**: OBL-REQ-CORE-001-O01
**Design reference**: [System design](../architecture/SYSTEM-DESIGN.md)、[Core](../architecture/CORE.md)
**Implementation identifiers**: packages/api/src/persistence-routes.ts; app/src/persistence/PersistenceWorkspace.tsx
**Test IDs**: TEST-CORE-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

Optional module停止・未導入でも作品作成、執筆、保存、履歴、復元を継続する

**Relations**:

- **Type**: Parent
  **ID**: REQ-CORE-001
- **Type**: File
  **Path**: packages/api/src/persistence-routes.ts
  **Lines**: 222, 237
- **Type**: File
  **Path**: app/src/persistence/PersistenceWorkspace.tsx

## REQ-CORE-002

**MID**: fddfda8c0e816de124b2f7206e7f78cd
**UID**: REQ-CORE-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Core](../architecture/CORE.md)、[Modules](../architecture/MODULES.md)
**Implementation identifiers**: packages/api/src/native-knowledge-actions.ts; packages/persistence-postgres/src/postgres-store.ts
**Verification identifiers**: tests/e2e/native-review.acceptance.spec.ts
**Test IDs**: TEST-CORE-002-001
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

## OBL-REQ-CORE-002-O01

**Type**: OBLIGATION
**MID**: f630a50db80fb29dc7887323f93b6a66
**UID**: OBL-REQ-CORE-002-O01
**Design reference**: [Core](../architecture/CORE.md)、[Modules](../architecture/MODULES.md)
**Implementation identifiers**: packages/api/src/native-knowledge-actions.ts; packages/persistence-postgres/src/postgres-store.ts
**Test IDs**: TEST-CORE-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

module/MCPの変更は提案を経由し、作者承認・再検査前に原稿を直接変更しない

**Relations**:

- **Type**: Parent
  **ID**: REQ-CORE-002

- **Type**: File
  **Path**: packages/api/src/native-knowledge-actions.ts

- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.ts

## REQ-CORE-003

**MID**: c44c1b1260eb80b27eefb84ad6b51406
**UID**: REQ-CORE-003
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Core](../architecture/CORE.md)
**Implementation identifiers**: packages/api/src/server.ts; packages/persistence-postgres/src/postgres-store.ts
**Verification identifiers**: tests/integration/mcp-acceptance.test.mjs
**Test IDs**: TEST-CORE-003-001
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

## OBL-REQ-CORE-003-O01

**Type**: OBLIGATION
**MID**: e6dc945711cd5059ddd0fa0ae1967af8
**UID**: OBL-REQ-CORE-003-O01
**Design reference**: [Core](../architecture/CORE.md)
**Implementation identifiers**: packages/api/src/server.ts; packages/persistence-postgres/src/postgres-store.ts
**Test IDs**: TEST-CORE-003-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

Snapshotをproject/versionへ固定し、古い参照や別projectの結果を現行状態として使わない

**Relations**:

- **Type**: Parent
  **ID**: REQ-CORE-003

- **Type**: File
  **Path**: packages/api/src/server.ts

- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.ts

## REQ-DATA-001

**MID**: e5307f1475469b659a8d449fc5a0e200
**UID**: REQ-DATA-001
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: packages/persistence-postgres/migrations/0001-initial.sql; 0003-project-workspace.sql
**Verification identifiers**: packages/persistence-postgres/src/postgres-store.test.ts
**Test IDs**: TEST-DATA-001-001
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

## OBL-REQ-DATA-001-O01

**Type**: OBLIGATION
**MID**: 587009b33333c1d20a24054bb84fcc06
**UID**: OBL-REQ-DATA-001-O01
**Design reference**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: packages/persistence-postgres/migrations/0001-initial.sql
**Test IDs**: TEST-DATA-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

原稿・構成・Revision・Knowledge・Evidence・ChangeSet・module recordの正本はPostgreSQLのみ

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-001

- **Type**: File
  **Path**: packages/persistence-postgres/migrations/0001-initial.sql

## REQ-DATA-002

**MID**: 007dd05315cc86292a93e108e688d796
**UID**: REQ-DATA-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Data model](../architecture/DATA-MODEL.md)、[Core](../architecture/CORE.md)
**Implementation identifiers**: document_revision; document_revision_immutable trigger; edit_operation; packages/api/src/persistence-routes.ts
**Verification identifiers**: tests/e2e/persistence-database.acceptance.spec.ts
**Test IDs**: TEST-DATA-002-001, TEST-DATA-002-002
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

## OBL-REQ-DATA-002-O01

**Type**: OBLIGATION
**MID**: 6fe5dbbfcfc87b5afcb11e6acfc21a9f
**UID**: OBL-REQ-DATA-002-O01
**Design reference**: [Data model](../architecture/DATA-MODEL.md)、[Core](../architecture/CORE.md)
**Implementation identifiers**: packages/api/src/persistence-routes.ts
**Test IDs**: TEST-DATA-002-001, TEST-DATA-002-002
**Exact-run reference**: NOT_RUN
**Comment**: Broad whole-requirement candidate mapping; decomposition into the specific obligations below is incomplete and exact-source certification remains unverified.

原稿revisionは不変で、保存・復元は整合性を守る新RevisionとDB receiptで表す

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-002

- **Type**: File
  **Path**: packages/api/src/persistence-routes.ts

## REQ-DATA-003

**MID**: 7ed62661666f111b1326977dd407e519
**UID**: REQ-DATA-003
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: 0001-initial.sql の複合FK; postgres-store.ts
**Verification identifiers**: packages/persistence-postgres/src/postgres-store.test.ts
**Test IDs**: TEST-DATA-003-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

project境界をすべての関連オブジェクト・階層・根拠・提案の参照と書込で保持する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/DATA-MODEL.md
- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.test.ts

## OBL-REQ-DATA-003-O01

**Type**: OBLIGATION
**MID**: 7e42cc0ab0f57e7a7742882ac1150d85
**UID**: OBL-REQ-DATA-003-O01
**Design reference**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: packages/persistence-postgres/migrations/0001-initial.sql
**Test IDs**: TEST-DATA-003-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

project境界をすべての関連オブジェクト・階層・根拠・提案の参照と書込で保持する

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-003
- **Type**: File
  **Path**: packages/persistence-postgres/migrations/0001-initial.sql
  **Lines**: 130, 135

## REQ-DATA-004

**MID**: 2fd422dfc7f2115ff4a44f858905d5b8
**UID**: REQ-DATA-004
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Data model](../architecture/DATA-MODEL.md)、[Update flow](../deployment/UPDATE-FLOW.md)
**Implementation identifiers**: packages/persistence-postgres/src/migrate.ts; migration-set.ts
**Verification identifiers**: packages/persistence-postgres/src/migration-set.test.ts; packages/persistence-postgres/src/schema-maintenance.test.ts
**Test IDs**: TEST-DATA-004-001
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

## OBL-REQ-DATA-004-O01

**Type**: OBLIGATION
**MID**: 38e9159a4e5adf2a4eaa16e6974ae275
**UID**: OBL-REQ-DATA-004-O01
**Design reference**: [Data model](../architecture/DATA-MODEL.md)、[Update flow](../deployment/UPDATE-FLOW.md)
**Implementation identifiers**: packages/persistence-postgres/src/migrate.ts
**Test IDs**: TEST-DATA-004-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

既存migrationのchecksum/fingerprintを検証し、未承認のDB schema変更をアプリ更新で行わない

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-004

- **Type**: File
  **Path**: packages/persistence-postgres/src/migrate.ts

## REQ-AUTH-001

**MID**: ed2b65f98d9d2d9b409105157c1629cf
**UID**: REQ-AUTH-001
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md)
**Implementation identifiers**: packages/api/src/oauth-owner.ts; oauth-token.ts; server.ts
**Verification identifiers**: tests/e2e/oauth-web.acceptance.spec.ts
**Test IDs**: TEST-AUTH-001-001
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

## OBL-REQ-AUTH-001-O01

**Type**: OBLIGATION
**MID**: d9ff68cdbd1e9aacb2f1dce8c3329274
**UID**: OBL-REQ-AUTH-001-O01
**Design reference**: [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md)
**Implementation identifiers**: packages/api/src/oauth-owner.ts
**Test IDs**: TEST-AUTH-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

owner APIはCodexia発行OAuth bearerを署名・audience・scope・ownerとして検証する

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-001

- **Type**: File
  **Path**: packages/api/src/oauth-owner.ts

## REQ-AUTH-002

**MID**: dbadd0a9d5ffe4d1daca067a90a4b332
**UID**: REQ-AUTH-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: packages/api/src/server.ts; persistence-routes.ts
**Verification identifiers**: packages/api/src/server.test.ts; packages/api/src/oauth-mcp.test.ts
**Test IDs**: TEST-AUTH-002-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

HTTP methodとpathだけでなくprincipal・project・object・revision・effectでfail-closed認可する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/ROUTE-AUTHORIZATION-CONTRACT.md
- **Type**: File
  **Path**: packages/api/src/server.ts
- **Type**: File
  **Path**: packages/api/src/server.test.ts
- **Type**: File
  **Path**: packages/api/src/oauth-mcp.test.ts

## OBL-REQ-AUTH-002-O01

**Type**: OBLIGATION
**MID**: 776050b1910f9ec630205e8d81b4583a
**UID**: OBL-REQ-AUTH-002-O01
**Design reference**: [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: packages/api/src/server.ts
**Test IDs**: TEST-AUTH-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

HTTP methodとpathだけでなくprincipal・project・object・revision・effectでfail-closed認可する

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-002

- **Type**: File
  **Path**: packages/api/src/server.ts

## REQ-AUTH-003

**MID**: a2f6832213e2e0d2e71082b0c87a2e0e
**UID**: REQ-AUTH-003
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [MCP OAuth](../architecture/MCP-OAUTH.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: packages/api/src/oauth-mcp.ts; modules/mcp/src/http.ts; tools.ts
**Verification identifiers**: tests/integration/mcp-acceptance.test.mjs
**Test IDs**: TEST-AUTH-003-001, TEST-AUTH-003-002
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

## OBL-REQ-AUTH-003-O01

**Type**: OBLIGATION
**MID**: 80542f6c2058d64041c4ee2f99c6e995
**UID**: OBL-REQ-AUTH-003-O01
**Design reference**: [MCP OAuth](../architecture/MCP-OAUTH.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: packages/api/src/oauth-mcp.ts; modules/mcp/src/http.ts
**Test IDs**: TEST-AUTH-003-001, TEST-AUTH-003-002
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

MCP clientは割当projectとread/compute/proposeまで。承認/applyやowner私有操作を行えない

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-003

- **Type**: File
  **Path**: packages/api/src/oauth-mcp.ts

- **Type**: File
  **Path**: modules/mcp/src/http.ts

## REQ-AUTH-004

**MID**: 98f28a41293b47032faa301b09ce740e
**UID**: REQ-AUTH-004
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md)、[Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md)
**Implementation identifiers**: /console/setup、setup-only Fastify、codexia_auth.owner_setup、Ansible の protected owner-setup operation。公開経路と初回配備の運用受入は別途確認する
**Verification identifiers**: tests/e2e/passkey-bootstrap.acceptance.spec.ts, packages/api/test/passkey-bootstrap.acceptance.test.ts
**Test IDs**: TEST-AUTH-004-001
**Exact-run reference**: NOT_RUN
**Comment**: 初回登録を実装。Cloudflare 経路、使い捨て VM の配備と運用受入の証跡待ち。

Passkey-firstの初回owner登録は一回限りsetup資格、owner不在、認証ceremonyを満たす

**Relations**:

- **Type**: File
  **Path**: docs/architecture/API-AUTHN-AUTHZ.md
- **Type**: File
  **Path**: docs/deployment/INITIAL-DEPLOYMENT-FLOW.md
- **Type**: File
  **Path**: tests/e2e/passkey-bootstrap.acceptance.spec.ts
- **Type**: File
  **Path**: app/src/console/ConsoleSetup.tsx
- **Type**: File
  **Path**: packages/api/src/owner-setup.ts
- **Type**: File
  **Path**: packages/api/test/passkey-bootstrap.acceptance.test.ts
- **Type**: File
  **Path**: deploy/ansible/owner-setup.yml

## OBL-REQ-AUTH-004-O01

**Type**: OBLIGATION
**MID**: 3b0c65af649c6eb349022e21fbe542a6
**UID**: OBL-REQ-AUTH-004-O01
**Design reference**: [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md)、[Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md)
**Implementation identifiers**: app/src/console/ConsoleSetup.tsx; packages/api/src/owner-setup.ts; deploy/ansible/owner-setup.yml
**Surface identifiers**: ansibleSource=deploy/ansible/prepare-owner-activation.yml
**Test IDs**: TEST-AUTH-004-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

Passkey-firstの初回owner登録は一回限りsetup資格、owner不在、認証ceremonyを満たす

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-004

- **Type**: File
  **Path**: app/src/console/ConsoleSetup.tsx

- **Type**: File
  **Path**: packages/api/src/owner-setup.ts

- **Type**: File
  **Path**: deploy/ansible/owner-setup.yml

- **Type**: File
  **Path**: deploy/ansible/prepare-owner-activation.yml

## REQ-AUTH-005

**MID**: 962171018b777bef7028ea6af006f662
**UID**: REQ-AUTH-005
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: FUTURE_TARGET
**Design owner**: [Admin screen flow](../design/ADMIN-SCREEN-FLOW.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: app/src/console/ConsoleEntry.tsx; packages/api/src/owner-security.ts; `/console/security`; `/console/identity`
**Verification identifiers**: tests/e2e/auth-recovery.acceptance.spec.ts; packages/api/src/better-auth.test.ts; packages/api/src/owner-security.test.ts
**Test IDs**: TEST-AUTH-005-001
**Exact-run reference**: NOT_RUN
**Comment**: Desktop Web の Passkey・セッション管理と連携情報の参照を実装。OIDC 設定の登録・検証・有効化と OAuth grant 失効は目標。

`/console`管理、Passkey/session、OIDC設定はowner権限と再認証に拘束する

**Relations**:

- **Type**: File
  **Path**: docs/design/ADMIN-SCREEN-FLOW.md
- **Type**: File
  **Path**: docs/architecture/ROUTE-AUTHORIZATION-CONTRACT.md
- **Type**: File
  **Path**: app/src/console/ConsoleEntry.tsx
- **Type**: File
  **Path**: packages/api/src/owner-security.ts
- **Type**: File
  **Path**: tests/e2e/auth-recovery.acceptance.spec.ts

## OBL-REQ-AUTH-005-O01

**Type**: OBLIGATION
**MID**: 53a8b9037ebbb65c5e04b1b797ccf099
**UID**: OBL-REQ-AUTH-005-O01
**Design reference**: [Admin screen flow](../design/ADMIN-SCREEN-FLOW.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: app/src/console/ConsoleEntry.tsx; packages/api/src/owner-security.ts
**Test IDs**: TEST-AUTH-005-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

`/console`管理、Passkey/session、OIDC設定はowner権限と再認証に拘束する

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-005

- **Type**: File
  **Path**: app/src/console/ConsoleEntry.tsx

- **Type**: File
  **Path**: packages/api/src/owner-security.ts

## REQ-API-001

**MID**: 1da786a43f72f653d2cd7d1a3551d9f6
**UID**: REQ-API-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [API contract](../architecture/API-CONTRACT.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: packages/api/src/server.ts; persistence-routes.ts; 各moduleのHTTP contribution
**Verification identifiers**: packages/api/src/persistence-routes.test.ts
**Test IDs**: TEST-API-001-001
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

## OBL-REQ-API-001-O01

**Type**: OBLIGATION
**MID**: 4f4a92eac39e5a67333e045ec8782a64
**UID**: OBL-REQ-API-001-O01
**Design reference**: [API contract](../architecture/API-CONTRACT.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)
**Implementation identifiers**: packages/api/src/server.ts
**Test IDs**: TEST-API-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

APIの入口、body/query、レスポンス、エラー、認可、競合、冪等性をmethod/path/Operationで特定する

**Relations**:

- **Type**: Parent
  **ID**: REQ-API-001

- **Type**: File
  **Path**: packages/api/src/server.ts

## REQ-API-002

**MID**: 8ffbcb3626affc11f13e649ed5cf1a02
**UID**: REQ-API-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Core](../architecture/CORE.md)、[Interaction contract](../design/INTERACTION-CONTRACT.md)
**Implementation identifiers**: persistence-routes.ts; postgres-store.ts; app/src/api-documents.ts
**Verification identifiers**: tests/e2e/core.acceptance.spec.ts
**Test IDs**: TEST-API-002-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

作者向けMutationでrequest identity・precondition・receiptを確認し、競合/応答不明を偽成功にしない

**Relations**:

- **Type**: File
  **Path**: docs/architecture/CORE.md
- **Type**: File
  **Path**: docs/design/INTERACTION-CONTRACT.md
- **Type**: File
  **Path**: app/src/api-documents.ts
- **Type**: File
  **Path**: tests/e2e/core.acceptance.spec.ts

## OBL-REQ-API-002-O01

**Type**: OBLIGATION
**MID**: 2054c8ca1ebb89dfc9c67169bd819bf3
**UID**: OBL-REQ-API-002-O01
**Design reference**: [Core](../architecture/CORE.md)、[Interaction contract](../design/INTERACTION-CONTRACT.md)
**Implementation identifiers**: app/src/api-documents.ts
**Test IDs**: TEST-API-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Broad whole-requirement candidate mapping; decomposition into the specific obligations below is incomplete and exact-source certification remains unverified.

作者向けMutationでrequest identity・precondition・receiptを確認し、競合/応答不明を偽成功にしない

**Relations**:

- **Type**: Parent
  **ID**: REQ-API-002

- **Type**: File
  **Path**: app/src/api-documents.ts

## REQ-MCP-001

**MID**: d88c4eafb567643571dfdac39b451bbf
**UID**: REQ-MCP-001
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [MCP-first](../architecture/MCP-FIRST.md)、[Modules](../architecture/MODULES.md)、[MCP v2 migration](../architecture/MCP-V2-MIGRATION.md)
**Implementation identifiers**: modules/mcp/src/http.ts; modules/mcp/src/stdio.ts; modules/mcp/src/tools.ts; modules/mcp/src/tools/shared.ts; modules/mcp/src/tools/project.ts; modules/mcp/src/tools/knowledge.ts
**Verification identifiers**: MCPV-001..008; tests/integration/mcp-acceptance.test.mjs; modules/mcp/src/tools.test.ts; packages/api/test/better-auth.integration.test.ts
**Test IDs**: TEST-MCPV-001-001, TEST-MCPV-001-002, TEST-MCPV-004-001, TEST-MCPV-004-002, TEST-MCPV-006-001, TEST-MCPV-006-002, TEST-MCPV-006-003, TEST-MCPV-006-004, TEST-MCPV-006-005, TEST-MCPV-007-001, TEST-MCPV-007-002, TEST-MCPV-007-003, TEST-MCPV-007-004, TEST-MCPV-004-003
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
  **Lines**: 408, 780
- **Type**: File
  **Path**: docs/architecture/MCP-V2-MIGRATION.md
  **Lines**: 78, 85

## OBL-REQ-MCP-001-O01

**Type**: OBLIGATION
**MID**: e32620abf2dfe0ecf7a094cafd8f3e17
**UID**: OBL-REQ-MCP-001-O01
**Design reference**: [MCP-first](../architecture/MCP-FIRST.md)、[Modules](../architecture/MODULES.md)
**Implementation identifiers**: modules/mcp/src/http.ts; modules/mcp/src/stdio.ts; modules/mcp/src/tools.ts
**Test IDs**: TEST-MCPV-004-001; TEST-MCPV-004-002; TEST-MCPV-006-001; TEST-MCPV-006-002; TEST-MCPV-006-003; TEST-MCPV-006-004; TEST-MCPV-006-005, TEST-MCPV-004-003
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

stdioとHTTPのMCPは同じCore action/effect境界に到達し、独立writerを持たない

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001

- **Type**: File
  **Path**: modules/mcp/src/http.ts
- **Type**: File
  **Path**: modules/mcp/src/stdio.ts
- **Type**: File
  **Path**: modules/mcp/src/tools.ts
  **Lines**: 1, 25
- **Type**: File
  **Path**: docs/architecture/MCP-V2-MIGRATION.md
  **Lines**: 78, 85

## REQ-MCP-002

**MID**: cd52c2dfae742db14351fecaa42331c7
**UID**: REQ-MCP-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [MCP-first](../architecture/MCP-FIRST.md)、[MCP v2 migration](../architecture/MCP-V2-MIGRATION.md)
**Implementation identifiers**: modules/mcp/src/tools.ts; modules/mcp/src/tools/shared.ts; modules/mcp/src/tools/project.ts; modules/mcp/src/tools/knowledge.ts
**Verification identifiers**: tests/integration/mcp-acceptance.test.mjs; MCPV-001..008
**Test IDs**: TEST-MCP-CORE-001-001
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
  **Lines**: 888, 966
- **Type**: File
  **Path**: docs/architecture/MCP-V2-MIGRATION.md
  **Lines**: 78, 85

## OBL-REQ-MCP-002-O01

**Type**: OBLIGATION
**MID**: d226d181f7a78354bf16607e64ed06e6
**UID**: OBL-REQ-MCP-002-O01
**Design reference**: [MCP-first](../architecture/MCP-FIRST.md)
**Implementation identifiers**: modules/mcp/src/tools.ts; modules/mcp/src/tools/shared.ts
**Test IDs**: TEST-MCP-CORE-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

外部AIによる推論とCodexia内のCore編集を分離し、内部LLM API拡張を再開しない

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-002

- **Type**: File
  **Path**: modules/mcp/src/tools.ts
- **Type**: File
  **Path**: modules/mcp/src/tools/shared.ts
  **Lines**: 12, 80
- **Type**: File
  **Path**: tests/integration/mcp-acceptance.test.mjs
  **Lines**: 888, 966
- **Type**: File
  **Path**: docs/architecture/MCP-V2-MIGRATION.md
  **Lines**: 78, 85

## REQ-UI-001

**MID**: b67567c59a7c147a08ef65e95b62bbd4
**UID**: REQ-UI-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [UX contract](../design/UX-CONTRACT.md)、[iOS architecture](../architecture/IOS-SWIFTUI-ARCHITECTURE.md)
**Implementation identifiers**: app/src/launcher.tsx; app/src/shells/
**Verification identifiers**: tests/e2e/modular-workspace.acceptance.spec.ts
**Test IDs**: TEST-UI-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Desktop web mapping exists; iOS implementation and physical-device acceptance remain unverified, so this cross-platform requirement is only partial.

作者用Desktop React Webの正式対応はWindows Chromium（Chrome/Edge）に限定する。DesktopとiOS SwiftUIはUIを共有せず、共通のCore/API・Revision・保存/復旧契約を満たす。Mobile Web/PWA作者UIは対象外。旧Mobile撤去の受入条件および独立した公開reader/外部認証契約は維持する

**Relations**:

- **Type**: File
  **Path**: docs/design/UX-CONTRACT.md
- **Type**: File
  **Path**: docs/architecture/IOS-SWIFTUI-ARCHITECTURE.md
- **Type**: File
  **Path**: app/src/launcher.tsx
- **Type**: File
  **Path**: tests/e2e/modular-workspace.acceptance.spec.ts

## OBL-REQ-UI-001-O01

**Type**: OBLIGATION
**MID**: f207ea617780f2a05b318ccc1874a257
**UID**: OBL-REQ-UI-001-O01
**Design reference**: [UX contract](../design/UX-CONTRACT.md)、[iOS architecture](../architecture/IOS-SWIFTUI-ARCHITECTURE.md)
**Implementation identifiers**: app/src/launcher.tsx
**Surface identifiers**: nativeIosView=LibraryView; nativeIosView=AccountScreen; nativeIosView=ProjectScreen; nativeIosView=ProductEditorScreen; nativeIosView=FixtureProjectView; nativeIosView=FixtureListView; nativeIosView=FixtureEditorDestination; nativeIosView=AuthoringView
**Test IDs**: TEST-UI-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

作者用Desktop React Webの正式対応はWindows Chromium（Chrome/Edge）に限定する。DesktopとiOS SwiftUIはUIを共有せず、共通のCore/API・Revision・保存/復旧契約を満たす。Mobile Web/PWA作者UIは対象外。旧Mobile撤去の受入条件および独立した公開reader/外部認証契約は維持する

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-001

- **Type**: File
  **Path**: app/src/launcher.tsx

- **Type**: File
  **Path**: ios/CodexiaApp/Sources/CodexiaApp.swift

- **Type**: File
  **Path**: ios/CodexiaEditor/Sources/CodexiaEditor/AuthoringView.swift

## REQ-UI-002

**MID**: 340d6519232659932dbdaec6237e7b82
**UID**: REQ-UI-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Interaction contract](../design/INTERACTION-CONTRACT.md)、[UX contract](../design/UX-CONTRACT.md)
**Implementation identifiers**: app/src/storage/; app/src/application/persistence-save-protocol.ts; app/src/journal.test.ts
**Verification identifiers**: tests/e2e/auth-recovery.acceptance.spec.ts; tests/e2e/core.acceptance.spec.ts
**Test IDs**: TEST-UI-002-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

未送信/保存中/DB確定/応答不明を区別し、下書きを黙って捨てない

**Relations**:

- **Type**: File
  **Path**: docs/design/INTERACTION-CONTRACT.md
- **Type**: File
  **Path**: docs/design/UX-CONTRACT.md
- **Type**: File
  **Path**: app/src/application/persistence-save-protocol.ts
- **Type**: File
  **Path**: app/src/journal.test.ts
- **Type**: File
  **Path**: tests/e2e/auth-recovery.acceptance.spec.ts
- **Type**: File
  **Path**: tests/e2e/core.acceptance.spec.ts

## OBL-REQ-UI-002-O01

**Type**: OBLIGATION
**MID**: 375573280f98b604ac8b6f18d376e847
**UID**: OBL-REQ-UI-002-O01
**Design reference**: [Interaction contract](../design/INTERACTION-CONTRACT.md)、[UX contract](../design/UX-CONTRACT.md)
**Implementation identifiers**: app/src/application/persistence-save-protocol.ts
**Test IDs**: TEST-UI-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Broad whole-requirement candidate mapping; decomposition into the specific obligations below is incomplete and exact-source certification remains unverified.

未送信/保存中/DB確定/応答不明を区別し、下書きを黙って捨てない

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-002

- **Type**: File
  **Path**: app/src/application/persistence-save-protocol.ts

## REQ-UI-003

**MID**: 36bebb605863f74dde54ec6552d3a350
**UID**: REQ-UI-003
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Screen catalog](../design/SCREEN-CONTROL-CATALOG.md)、[State Atlas](../design/SCREEN-STATE-ATLAS.md)
**Implementation identifiers**: app/src/App.tsx; app/src/components/; app/src/shells/
**Verification identifiers**: tests/e2e/ui-v1.acceptance.spec.ts
**Test IDs**: TEST-UI-003-001
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

## OBL-REQ-UI-003-O01

**Type**: OBLIGATION
**MID**: 6129fe71966b7841314c39b71c52cddf
**UID**: OBL-REQ-UI-003-O01
**Design reference**: [Screen catalog](../design/SCREEN-CONTROL-CATALOG.md)、[State Atlas](../design/SCREEN-STATE-ATLAS.md)
**Implementation identifiers**: app/src/App.tsx
**Test IDs**: TEST-UI-003-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

画面、操作、遷移、戻り先、エラー、principalを画面ID/CTRL IDで特定する

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-003

- **Type**: File
  **Path**: app/src/App.tsx

## REQ-UI-004

**MID**: 2f4e5f4c69d3f698da4db40133a73bb0
**UID**: REQ-UI-004
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [UX contract](../design/UX-CONTRACT.md)
**Implementation identifiers**: app/src/editor/; app/src/shells/
**Verification identifiers**: tests/e2e/core.acceptance.spec.ts
**Test IDs**: TEST-UI-004-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

IME、選択、focus、編集中の遅延・画面移動でも原稿と復旧可能性を保持する

**Relations**:

- **Type**: File
  **Path**: docs/design/UX-CONTRACT.md
- **Type**: File
  **Path**: tests/e2e/core.acceptance.spec.ts

## OBL-REQ-UI-004-O01

**Type**: OBLIGATION
**MID**: cc5211ab48ff071e1224a01e69710c4a
**UID**: OBL-REQ-UI-004-O01
**Design reference**: [UX contract](../design/UX-CONTRACT.md)
**Implementation identifiers**: app/src/editor/ManuscriptInput.tsx; app/src/editor/cm/compositionGuard.ts
**Test IDs**: TEST-UI-004-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

IME、選択、focus、編集中の遅延・画面移動でも原稿と復旧可能性を保持する

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-004
- **Type**: File
  **Path**: app/src/editor/ManuscriptInput.tsx
- **Type**: File
  **Path**: app/src/editor/cm/compositionGuard.ts

## REQ-UI-005

**MID**: 0350c31a526959de6554b0a6c1ff960f
**UID**: REQ-UI-005
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [UX contract](../design/UX-CONTRACT.md)
**Implementation identifiers**: app/src/components/; app/src/shells/
**Verification identifiers**: tests/e2e/redesign-visual.acceptance.spec.ts
**Test IDs**: TEST-UI-005-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

適用可能なWCAG 2.2 A/AA、keyboard、reflow等の受入義務を満たす

**Relations**:

- **Type**: File
  **Path**: docs/design/UX-CONTRACT.md
- **Type**: File
  **Path**: tests/e2e/redesign-visual.acceptance.spec.ts

## OBL-REQ-UI-005-O01

**Type**: OBLIGATION
**MID**: e888cfbfa2be257121c132812e3289e2
**UID**: OBL-REQ-UI-005-O01
**Design reference**: [UX contract](../design/UX-CONTRACT.md)
**Implementation identifiers**: app/src/workspace/Workspace.tsx
**Test IDs**: TEST-UI-005-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

適用可能なWCAG 2.2 A/AA、keyboard、reflow等の受入義務を満たす

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-005
- **Type**: File
  **Path**: app/src/workspace/Workspace.tsx
  **Lines**: 426, 447

## REQ-UI-006

**MID**: 75284b8b389d3d311edce1c19e4029c6
**UID**: REQ-UI-006
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [XState contract](../design/XSTATE-STATE-MACHINE-CONTRACT.md)、[Screen Atlas](../design/SCREEN-STATE-ATLAS.md)
**Implementation identifiers**: app/src/application/persistence-save-machine.ts; app/src/persistence/PersistenceWorkspace.tsx; app/src/persistence/native-review-machine.ts; app/src/settings/owner-passkey-reauth-machine.ts; app/src/settings/owner-grant-revocation-machine.ts
**Verification identifiers**: app/src/persistence/native-review-machine.test.ts; app/src/settings/owner-passkey-reauth-machine.test.ts; app/src/settings/owner-grant-revocation-machine.test.ts; tests/e2e/native-review.acceptance.spec.ts; tests/e2e/oauth-web.acceptance.spec.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／XState v5 はWRT-01/REC-01、Native ChangeSetレビュー、Passkey再認証、OAuth同意撤回で部分導入済み。バックアップは未実装; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

原稿保存・復旧、ChangeSet、認証、バックアップの複雑な状態と失敗・競合・接続断を決定的な遷移と独立テストで検証し、未確認の副作用を成功表示にしない

**Relations**:

- **Type**: File
  **Path**: docs/design/XSTATE-STATE-MACHINE-CONTRACT.md
- **Type**: File
  **Path**: docs/design/SCREEN-STATE-ATLAS.md

## OBL-REQ-UI-006-O01

**Type**: OBLIGATION
**MID**: 0c54e429ce48db0abde06145b4640017
**UID**: OBL-REQ-UI-006-O01
**Design reference**: [XState contract](../design/XSTATE-STATE-MACHINE-CONTRACT.md)、[Screen Atlas](../design/SCREEN-STATE-ATLAS.md)
**Implementation identifiers**: app/src/application/persistence-save-machine.ts; app/src/persistence/PersistenceWorkspace.tsx; app/src/persistence/native-review-machine.ts; app/src/settings/owner-passkey-reauth-machine.ts; app/src/settings/owner-grant-revocation-machine.ts
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

原稿保存・復旧、ChangeSet、認証、バックアップの複雑な状態と失敗・競合・接続断を決定的な遷移と独立テストで検証し、未確認の副作用を成功表示にしない

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-006
- **Type**: File
  **Path**: app/src/application/persistence-save-machine.ts
  **Lines**: 88, 89
- **Type**: File
  **Path**: app/src/persistence/PersistenceWorkspace.tsx
  **Lines**: 439, 445
- **Type**: File
  **Path**: app/src/persistence/native-review-machine.ts
- **Type**: File
  **Path**: app/src/settings/owner-passkey-reauth-machine.ts
- **Type**: File
  **Path**: app/src/settings/owner-grant-revocation-machine.ts

## REQ-EXT-001

**MID**: a3a584fb55f4b2aa688acf1243deb5f3
**UID**: REQ-EXT-001
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Deployment](../deployment/README.md)、[System design](../architecture/SYSTEM-DESIGN.md)
**Implementation identifiers**: deploy/cloudflare/ui-routes.json; public-protocol-paths.json; terraform/
**Verification identifiers**: scripts/verification/infrastructure/deployment-config.mjs
**Test IDs**: TEST-EXT-001-001
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
  **Path**: scripts/verification/infrastructure/deployment-config.mjs

## OBL-REQ-EXT-001-O01

**Type**: OBLIGATION
**MID**: 38f8a579218352387edacbee564f0d62
**UID**: OBL-REQ-EXT-001-O01
**Design reference**: [Deployment](../deployment/README.md)、[System design](../architecture/SYSTEM-DESIGN.md)
**Implementation identifiers**: deploy/cloudflare/ui-routes.json; scripts/verification/infrastructure/deployment-config.mjs
**Surface identifiers**: iacResource=cloudflare_zero_trust_access_application.codexia; iacResource=cloudflare_zero_trust_access_application.identity_probe; iacResource=cloudflare_zero_trust_access_application.public_protocol; iacResource=terraform_data.public_oauth_edge_readiness; iacResource=cloudflare_zero_trust_tunnel_cloudflared.codexia; iacResource=cloudflare_dns_record.codexia; iacResource=cloudflare_zero_trust_tunnel_cloudflared_config.codexia; iacResource=cloudflare_worker.frontend; iacResource=cloudflare_workers_route.frontend; iacResource=cloudflare_workers_route.origin
**Test IDs**: TEST-EXT-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

Edgeの静的UI配信とAPI/Tunnelのルーティングを分け、AccessをCore認可の代わりにしない

**Relations**:

- **Type**: Parent
  **ID**: REQ-EXT-001

- **Type**: File
  **Path**: deploy/cloudflare/ui-routes.json

- **Type**: File
  **Path**: scripts/verification/infrastructure/deployment-config.mjs

- **Type**: File
  **Path**: deploy/cloudflare/terraform/main.tf

## REQ-EXT-002

**MID**: e752ee48cf448d04c76e06aaad7394f5
**UID**: REQ-EXT-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)、[External interfaces](../architecture/EXTERNAL-INTERFACES.md)
**Implementation identifiers**: packages/contracts/src/oauth-metadata.ts; packages/api/src/better-auth.ts; modules/mcp/src/http.ts
**Verification identifiers**: packages/contracts/src/oauth-metadata.test.ts
**Test IDs**: TEST-EXT-002-001
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

## OBL-REQ-EXT-002-O01

**Type**: OBLIGATION
**MID**: be2e78e6b8d67707146f62d4b4029872
**UID**: OBL-REQ-EXT-002-O01
**Design reference**: [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)、[External interfaces](../architecture/EXTERNAL-INTERFACES.md)
**Implementation identifiers**: packages/contracts/src/oauth-metadata.ts; packages/api/src/better-auth.ts; modules/mcp/src/http.ts
**Test IDs**: TEST-EXT-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

OAuth/OIDC、MCP、公開readerの外部境界はscope/audience/公開範囲を個別に検証する

**Relations**:

- **Type**: Parent
  **ID**: REQ-EXT-002

- **Type**: File
  **Path**: packages/contracts/src/oauth-metadata.ts

- **Type**: File
  **Path**: packages/api/src/better-auth.ts

- **Type**: File
  **Path**: modules/mcp/src/http.ts

## REQ-OPS-001

**MID**: 5f8a8fd04ffea1957b4289dd57c5e2a2
**UID**: REQ-OPS-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md)
**Implementation identifiers**: deploy/ansible/site.yml; auth-runtime.yml
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: TEST-OPS-001-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／一部目標・適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

新規VMのbootstrap、owner登録、公開、復旧を明示した別状態として扱う

**Relations**:

- **Type**: File
  **Path**: docs/deployment/INITIAL-DEPLOYMENT-FLOW.md
- **Type**: File
  **Path**: deploy/ansible/site.yml

## OBL-REQ-OPS-001-O01

**Type**: OBLIGATION
**MID**: b1a5dc144cb722c750aeea9c4cb2f85f
**UID**: OBL-REQ-OPS-001-O01
**Design reference**: [Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md)
**Implementation identifiers**: deploy/ansible/site.yml
**Surface identifiers**: ansibleSource=deploy/ansible/auth-runtime.yml; ansibleSource=deploy/ansible/base-runtime.yml; ansibleSource=deploy/ansible/base-secrets.yml; ansibleSource=deploy/ansible/bootstrap-secret-escrow.yml; ansibleSource=deploy/ansible/deploy-ssh-key.yml; ansibleSource=deploy/ansible/host-validate.yml; ansibleSource=deploy/ansible/host.yml; ansibleSource=deploy/ansible/inspect.yml; ansibleSource=deploy/ansible/inventory.example.yml; ansibleSource=deploy/ansible/managed-bootstrap-secrets.yml; ansibleSource=deploy/ansible/owner-setup.yml; ansibleSource=deploy/ansible/preflight-observe.yml; ansibleSource=deploy/ansible/recreate-missing-app-database.yml; ansibleSource=deploy/ansible/site.yml; ansibleSource=deploy/ansible/verify-base-db-container.yml; ansibleSource=deploy/ansible/verify-base-tunnel-container.yml; ansibleSource=deploy/ansible/verify-bootstrap-escrow.yml; ciWorkflow=.github/workflows/bootstrap-recovery.yml; ciWorkflow=.github/workflows/initial-preservation.yml
**Test IDs**: TEST-OPS-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

新規VMのbootstrap、owner登録、公開、復旧を明示した別状態として扱う

**Relations**:

- **Type**: Parent
  **ID**: REQ-OPS-001

- **Type**: File
  **Path**: deploy/ansible/site.yml

- **Type**: File
  **Path**: deploy/ansible/auth-runtime.yml

- **Type**: File
  **Path**: deploy/ansible/base-runtime.yml

- **Type**: File
  **Path**: deploy/ansible/base-secrets.yml

- **Type**: File
  **Path**: deploy/ansible/deploy-ssh-key.yml

- **Type**: File
  **Path**: deploy/ansible/host-validate.yml

- **Type**: File
  **Path**: deploy/ansible/host.yml

- **Type**: File
  **Path**: deploy/ansible/inspect.yml

- **Type**: File
  **Path**: deploy/ansible/inventory.example.yml

- **Type**: File
  **Path**: deploy/ansible/owner-setup.yml

- **Type**: File
  **Path**: deploy/ansible/preflight-observe.yml

- **Type**: File
  **Path**: deploy/ansible/recreate-missing-app-database.yml

- **Type**: File
  **Path**: deploy/ansible/verify-base-db-container.yml

- **Type**: File
  **Path**: deploy/ansible/verify-base-tunnel-container.yml

- **Type**: File
  **Path**: deploy/ansible/bootstrap-secret-escrow.yml

- **Type**: File
  **Path**: deploy/ansible/managed-bootstrap-secrets.yml

- **Type**: File
  **Path**: deploy/ansible/verify-bootstrap-escrow.yml

- **Type**: File
  **Path**: .github/workflows/bootstrap-recovery.yml

- **Type**: File
  **Path**: .github/workflows/initial-preservation.yml

## REQ-OPS-002

**MID**: ce4f2bf883e22452b4a76a7a5d58e84a
**UID**: REQ-OPS-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [Update flow](../deployment/UPDATE-FLOW.md)、[CI/CD](../verification/CI-CD.md)
**Implementation identifiers**: deploy/update-compatibility.json; frontend-compatibility.json; .github/workflows/backend-release.yml
**Verification identifiers**: deploy/ansible/test-push-app-lifecycle.sh
**Test IDs**: TEST-OPS-002-001
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

## OBL-REQ-OPS-002-O01

**Type**: OBLIGATION
**MID**: 56539a1c84fb09cfed6287762023ff6c
**UID**: OBL-REQ-OPS-002-O01
**Design reference**: [Update flow](../deployment/UPDATE-FLOW.md)、[CI/CD](../verification/CI-CD.md)
**Implementation identifiers**: deploy/update-compatibility.json; .github/workflows/backend-release.yml; deploy/ansible/test-push-app-lifecycle.sh
**Surface identifiers**: iacResource=cloudflare_worker_version.candidate; iacResource=cloudflare_worker.frontend; iacResource=terraform_data.public_oauth_edge_readiness; iacResource=cloudflare_workers_route.frontend; ansibleSource=deploy/ansible/deploy-lifecycle-fixture.yml; ansibleSource=deploy/ansible/deploy-prepare.yml; ansibleSource=deploy/ansible/deploy-transaction.yml; ansibleSource=deploy/ansible/deploy.yml; ansibleSource=deploy/ansible/verify-deploy-base-runtime.yml
**Test IDs**: TEST-OPS-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

更新はexact-source検証、互換性、snapshot保全、失敗時停止/rollback規則を守る

**Relations**:

- **Type**: Parent
  **ID**: REQ-OPS-002

- **Type**: File
  **Path**: deploy/update-compatibility.json

- **Type**: File
  **Path**: .github/workflows/backend-release.yml

- **Type**: File
  **Path**: deploy/ansible/test-push-app-lifecycle.sh

- **Type**: File
  **Path**: deploy/cloudflare/terraform/initial-frontend-version/main.tf

- **Type**: File
  **Path**: deploy/cloudflare/terraform/main.tf

- **Type**: File
  **Path**: deploy/ansible/deploy-lifecycle-fixture.yml

- **Type**: File
  **Path**: deploy/ansible/deploy-prepare.yml

- **Type**: File
  **Path**: deploy/ansible/deploy-transaction.yml

- **Type**: File
  **Path**: deploy/ansible/deploy.yml

- **Type**: File
  **Path**: deploy/ansible/verify-deploy-base-runtime.yml

## REQ-OPS-003

**MID**: e4124266c15f499a077b6ff54563008b
**UID**: REQ-OPS-003
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Backup](../deployment/BACKUP.md)
**Implementation identifiers**: `deploy/backup/backup.sh`, `deploy/backup/s3_transfer.py`, `deploy/ansible/restore-drill.yml`
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: TEST-OPS-003-001
**Exact-run reference**: NOT_RUN
**Comment**: S3互換の転送と隔離復元の実装を参照する。AWS S3での転送と読み戻し、および独立した復旧ホストでの復元は受入証拠が必要。

バックアップと隔離復元でPostgreSQL正本と運用状態の復旧を検証する。
S3互換ストレージへのage暗号化済みバックアップの転送、検証、取得、および隔離復元をサポートする。

**Relations**:

- **Type**: File
  **Path**: docs/deployment/BACKUP.md
- **Type**: File
  **Path**: deploy/backup/s3_transfer.py
- **Type**: File
  **Path**: deploy/ansible/restore-drill.yml

## OBL-REQ-OPS-003-O01

**Type**: OBLIGATION
**MID**: c2b97bf1e5ffaeba8abf5c29e5729378
**UID**: OBL-REQ-OPS-003-O01
**Design reference**: [Backup](../deployment/BACKUP.md)
**Implementation identifiers**: deploy/ansible/restore-drill.yml
**Surface identifiers**: ansibleSource=deploy/ansible/restore-drill.yml
**Test IDs**: TEST-OPS-003-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

バックアップと隔離復元でPostgreSQL正本と運用状態の復旧を検証する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-OPS-003

- **Type**: File
  **Path**: deploy/ansible/restore-drill.yml

## OBL-REQ-OPS-003-O02

**Type**: OBLIGATION
**MID**: 3b0d4955a5e6732c8786dc25527f603a
**UID**: OBL-REQ-OPS-003-O02
**Design reference**: [Backup](../deployment/BACKUP.md)、[Backup console contract](../architecture/BACKUP-CONSOLE-CONTRACT.md)
**Implementation identifiers**: `S3BackupTransfer.upload_artifact`, `S3BackupTransfer.download_artifact`, `restore-drill.yml`
**Test IDs**: NOT_ASSIGNED
**Exact-run reference**: NOT_RUN
**Comment**: AWS S3での転送と読み戻し、および独立した復旧ホストでの復元について、対象ソースに紐づく証拠が必要。

S3互換ストレージへのage暗号化済みバックアップの転送、検証、取得、および隔離復元をサポートする。

**Relations**:

- **Type**: Parent
  **ID**: REQ-OPS-003

- **Type**: File
  **Path**: deploy/backup/s3_transfer.py

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

## OBL-REQ-OPS-004-O01

**Type**: OBLIGATION
**MID**: 7697c8d75f77faffd9e000e9b2db06b2
**UID**: OBL-REQ-OPS-004-O01
**Design reference**: [Backup console](../architecture/BACKUP-CONSOLE-CONTRACT.md)、[Admin flow](../design/ADMIN-SCREEN-FLOW.md)
**Implementation identifiers**: UNMAPPED (candidate source file not identified)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

ownerは管理コンソールからS3互換バックアップ先のdraft/検証/有効化/停止を操作できる。資格情報write-only、revisionとfresh再認証、operator保護のlocal staging/age鍵の非変更を保証する

**Relations**:

- **Type**: Parent
  **ID**: REQ-OPS-004

## REQ-OPS-005

**MID**: 8aff323e8c18bb058160c82a27869785
**UID**: REQ-OPS-005
**Decision status**: ACCEPTED
**Conformance status**: UNMAPPED
**Applicability**: FUTURE_TARGET
**Design owner**: [Backup console](../architecture/BACKUP-CONSOLE-CONTRACT.md)、[Backup](../deployment/BACKUP.md)
**Implementation identifiers**: BKC-008〜010; protected rootless executor; durable run queue; shared host lock
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: BKC-008〜010とホスト実行基盤を実装。画面はIssue #666。実際の保管先と独立復旧ホストでの適合認定は別証拠を要する。

ownerが手動保全を要求してrun/暗号文/独立復旧証拠を区別して確認でき、実副作用は既存host lock/backup.shと保護されたexecutorだけが実施。本番復元・遠隔削除をWebから禁止する

**Relations**:

- **Type**: File
  **Path**: docs/architecture/BACKUP-CONSOLE-CONTRACT.md
- **Type**: File
  **Path**: docs/deployment/BACKUP.md

## OBL-REQ-OPS-005-O01

**Type**: OBLIGATION
**MID**: fe1292405731f817303d8340e74e674e
**UID**: OBL-REQ-OPS-005-O01
**Design reference**: [Backup console](../architecture/BACKUP-CONSOLE-CONTRACT.md)、[Backup](../deployment/BACKUP.md)
**Implementation identifiers**: UNMAPPED (candidate source file not identified)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

ownerが手動保全を要求してrun/暗号文/独立復旧証拠を区別して確認でき、実副作用は既存host lock/backup.shと保護されたexecutorだけが実施。本番復元・遠隔削除をWebから禁止する

**Relations**:

- **Type**: Parent
  **ID**: REQ-OPS-005

## REQ-QUAL-001

**MID**: 9bfc3694283aff3d376a2a615a38f4bd
**UID**: REQ-QUAL-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Test architecture](../verification/TEST-ARCHITECTURE-OPTIMIZATION.md)
**Implementation identifiers**: tests/e2e/; tests/integration/; packages/配下test
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: TEST-QUAL-001-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

テストは契約の正常/異常/境界と実DB/API/UI/hostを分け、モックでは境界統合を証明しない

**Relations**:

- **Type**: File
  **Path**: docs/verification/TEST-ARCHITECTURE-OPTIMIZATION.md

## OBL-REQ-QUAL-001-O01

**Type**: OBLIGATION
**MID**: 62309ca44d6dfc7d3809c3b7c170bd84
**UID**: OBL-REQ-QUAL-001-O01
**Design reference**: [Test architecture](../verification/TEST-ARCHITECTURE-OPTIMIZATION.md)
**Implementation identifiers**: scripts/ci/impact/contract.mjs; .github/workflows/verify.yml
**Test IDs**: TEST-QUAL-001-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

テストは契約の正常/異常/境界と実DB/API/UI/hostを分け、モックでは境界統合を証明しない

**Relations**:

- **Type**: Parent
  **ID**: REQ-QUAL-001
- **Type**: File
  **Path**: scripts/ci/impact/contract.mjs
- **Type**: File
  **Path**: .github/workflows/verify.yml

## REQ-QUAL-002

**MID**: 430a641c09fcc6c2f116d72d7d1db617
**UID**: REQ-QUAL-002
**Decision status**: ACCEPTED
**Conformance status**: MAPPED_UNVERIFIED
**Applicability**: CURRENT
**Design owner**: [CI/CD](../verification/CI-CD.md)
**Implementation identifiers**: .github/workflows/verify.yml; scripts/ci/impact/plan.mjs
**Verification identifiers**: NOT_ASSIGNED (initial trace ledger has no resolvable test file)
**Test IDs**: TEST-QUAL-002-001
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／適合未認定; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

CIは選択タスク、exact-source、成果物IDと必須gateを証明し、未実行/欠落をPASSとしない

**Relations**:

- **Type**: File
  **Path**: docs/verification/CI-CD.md
- **Type**: File
  **Path**: .github/workflows/verify.yml
- **Type**: File
  **Path**: scripts/ci/impact/plan.mjs

## OBL-REQ-QUAL-002-O01

**Type**: OBLIGATION
**MID**: 0cfaf3b35ae9ac319c02611733dc2fc8
**UID**: OBL-REQ-QUAL-002-O01
**Design reference**: [CI/CD](../verification/CI-CD.md)
**Implementation identifiers**: .github/workflows/verify.yml; scripts/ci/impact/plan.mjs
**Surface identifiers**: ciWorkflow=.github/workflows/verify.yml
**Test IDs**: TEST-QUAL-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

CIは選択タスク、exact-source、成果物IDと必須gateを証明し、未実行/欠落をPASSとしない

**Relations**:

- **Type**: Parent
  **ID**: REQ-QUAL-002

- **Type**: File
  **Path**: .github/workflows/verify.yml

- **Type**: File
  **Path**: scripts/ci/impact/plan.mjs

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

## OBL-REQ-QUAL-003-O01

**Type**: OBLIGATION
**MID**: e872dec9510925c3657296aea82ce557
**UID**: OBL-REQ-QUAL-003-O01
**Design reference**: [UX contract](../design/UX-CONTRACT.md)、[Performance](../performance/README.md)
**Implementation identifiers**: UNMAPPED (candidate source file not identified)
**Test IDs**: NOT_ASSIGNED (no standalone TEST-ID exists in the initial trace ledger)
**Exact-run reference**: NOT_RUN
**Comment**: Candidate references only; obligation-level decomposition and exact-source certification remain unverified.

INP p75、CLS p75の品質目安に加え、原稿入力・保存・復旧の別々の実測で評価する

**Relations**:

- **Type**: Parent
  **ID**: REQ-QUAL-003

## REQ-TRACE-001

**MID**: 5178ac05b8be2783fc02a6a8f24dc3cf
**UID**: REQ-TRACE-001
**Decision status**: ACCEPTED
**Conformance status**: PARTIAL
**Applicability**: CURRENT
**Design owner**: [Requirements governance](README.md)、[Traceability register](../verification/TRACEABILITY-REGISTER.md)
**Implementation identifiers**: この台帳とAPI・DB・外部IFの初期契約
**Verification identifiers**: scripts/strictdoc/verify.test.mjs; scripts/audit/specifications.test.mjs; scripts/ci/evidence/trace-receipt.test.mjs
**Test IDs**: TEST-TRC-01-001, TEST-TRC-02-001, TEST-TRC-02-002, TEST-TRC-03-001, TEST-TRC-04-001, TEST-TRC-04-002, TEST-TRC-05-001, TEST-TRC-05-002, TEST-TRC-05-003, TEST-TRC-07-001, TEST-TRC-07-002, TEST-TRC-08-001, TEST-TRC-04-003, TEST-TRC-05-004, TEST-TRC-06-001, TEST-TRC-06-002
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／**構築中**; candidate file references remain MAPPED_UNVERIFIED and do not establish pass or full obligation coverage.

すべての採用済み要求のobligationを正本→実装→検証→証拠まで双方向に追跡する

**Relations**:

- **Type**: File
  **Path**: docs/requirements/README.md
- **Type**: File
  **Path**: docs/verification/TRACEABILITY-REGISTER.md

## OBL-REQ-TRACE-001-O01

**Type**: OBLIGATION
**MID**: 8f9ebbb8fb98f1bec1d72619b3835d64
**UID**: OBL-REQ-TRACE-001-O01
**Design reference**: [Requirements governance](README.md)、[Traceability register](../verification/TRACEABILITY-REGISTER.md)
**Implementation identifiers**: scripts/strictdoc/verify.mjs
**Test IDs**: TEST-TRC-01-001
**Exact-run reference**: NOT_RUN
**Comment**: One explicit criterion only; remaining traceability criteria are separate obligations below. Exact-source certification remains unverified.

各採用REQ-IDがStrictDoc requirement nodeとして一度だけ定義され、IDの欠落・重複を検査できる

**Relations**:

- **Type**: File
  **Path**: docs/requirements/REQUIREMENT-REGISTER.md

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.mjs

## OBL-REQ-TRACE-001-O02

**Type**: OBLIGATION
**MID**: 0966fc7db2c488c5abd936cd7db8556f
**UID**: OBL-REQ-TRACE-001-O02
**Design reference**: docs/requirements/STRICTDOC-TRACEABILITY.md
**Implementation identifiers**: scripts/strictdoc/verify.mjs
**Test IDs**: TEST-TRC-02-001; TEST-TRC-02-002
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

StrictDoc Markdown parsing and same-input HTML/JSON export are repeatable within the recorded version and observed normalization rules.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001

- **Type**: File
  **Path**: scripts/strictdoc/verify.mjs
  **Lines**: 684, 744

## OBL-REQ-TRACE-001-O03

**Type**: OBLIGATION
**MID**: 1e736c2a4c3d45d1ba659c1f0c85cfe6
**UID**: OBL-REQ-TRACE-001-O03
**Design reference**: docs/requirements/STRICTDOC-TRACEABILITY.md
**Implementation identifiers**: scripts/strictdoc/verify.mjs
**Test IDs**: TEST-TRC-03-001
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

A requirement-to-source relation must use a repository file path and any declared line range must remain within the source file.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001

- **Type**: File
  **Path**: scripts/strictdoc/verify.mjs
  **Lines**: 83, 147

## OBL-REQ-TRACE-001-O04

**Type**: OBLIGATION
**MID**: 6a8582691c1bc79a39f22ad3e99ee2b0
**UID**: OBL-REQ-TRACE-001-O04
**Design reference**: docs/requirements/STRICTDOC-TRACEABILITY.md
**Implementation identifiers**: scripts/strictdoc/verify.mjs
**Test IDs**: TEST-TRC-04-001; TEST-TRC-04-002, TEST-TRC-04-003
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

Reverse inventory keeps discovered HTTP routes, MCP tools, database objects, Desktop UI controls, Native iOS views, and IaC resources or Ansible sources visible when classification or requirement mapping is missing.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001

- **Type**: File
  **Path**: scripts/strictdoc/verify.mjs
  **Lines**: 475, 480

## OBL-REQ-TRACE-001-O05

**Type**: OBLIGATION
**MID**: f108acf33cf12b70e9072e7828390202
**UID**: OBL-REQ-TRACE-001-O05
**Design reference**: docs/requirements/STRICTDOC-TRACEABILITY.md
**Implementation identifiers**: scripts/strictdoc/verify.mjs
**Test IDs**: TEST-TRC-05-001; TEST-TRC-05-002; TEST-TRC-05-003, TEST-TRC-05-004
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

Execution references retain exact repository, source SHA, run, attempt, job, task, and observed case result; local execution remains NOT_RUN.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001

- **Type**: File
  **Path**: scripts/strictdoc/verify.mjs
  **Lines**: 481, 499

## OBL-REQ-TRACE-001-O06

**Type**: OBLIGATION
**MID**: b08ae2a844fd70c84798b3e5c2606a83
**UID**: OBL-REQ-TRACE-001-O06
**Design reference**: docs/requirements/STRICTDOC-TRACEABILITY.md
**Implementation identifiers**: scripts/strictdoc/verify.test.mjs
**Test IDs**: TEST-TRC-01-001; TEST-TRC-03-001; TEST-TRC-04-001; TEST-TRC-04-002, TEST-TRC-04-003, TEST-TRC-05-004, TEST-TRC-06-001, TEST-TRC-06-002
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

Fault injection rejects duplicate requirement IDs, missing or out-of-range file references, and unclassified reverse inventory entries.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001

- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## OBL-REQ-TRACE-001-O07

**Type**: OBLIGATION
**MID**: a0b534c63b2f6a4249115f574cb2bcac
**UID**: OBL-REQ-TRACE-001-O07
**Design reference**: docs/requirements/STRICTDOC-TRACEABILITY.md
**Implementation identifiers**: scripts/strictdoc/verify.browser.mjs
**Test IDs**: TEST-TRC-07-001
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

The staged static StrictDoc page renders every requirement UID in the browser check.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001

- **Type**: File
  **Path**: scripts/strictdoc/verify.browser.mjs
  **Lines**: 70, 90

## OBL-REQ-TRACE-001-O08

**Type**: OBLIGATION
**MID**: 5bfdcec3e2f8dbfabaf2f48f81f6b297
**UID**: OBL-REQ-TRACE-001-O08
**Design reference**: [StrictDoc traceability](STRICTDOC-TRACEABILITY.md)
**Implementation identifiers**: scripts/audit/specifications.mjs; scripts/audit/traceability-ui.js; scripts/audit/traceability.css; scripts/pages-ui/navigation.mjs
**Surface identifiers**: ciWorkflow=.github/workflows/repository-audit.yml
**Test IDs**: TEST-TRC-08-001
**Exact-run reference**: NOT_RUN
**Comment**: Dashboard projection and browser operation are source-bound. Candidate requirement IDs remain navigation hints and never become accepted relations.

Requirementsから実装・テストへ、実装面から義務へ移動できる静的ページを生成する。適合状態、分類、候補、参照欠落、未実行状態を区別し、設計正本・実装・TEST-ID・同一source SHAの実行証拠へ直接リンクする。

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001

- **Type**: File
  **Path**: docs/requirements/STRICTDOC-TRACEABILITY.md
- **Type**: File
  **Path**: scripts/audit/specifications.mjs
- **Type**: File
  **Path**: scripts/audit/traceability-ui.js
- **Type**: File
  **Path**: scripts/audit/traceability.css
- **Type**: File
  **Path**: scripts/audit/specifications.browser.mjs
- **Type**: File
  **Path**: .github/workflows/repository-audit.yml

## OBL-REQ-TRACE-001-O09

**Type**: OBLIGATION
**MID**: cfcbe4617d5a8e5ba96f52635d2e21d6
**UID**: OBL-REQ-TRACE-001-O09
**Design reference**: [StrictDoc traceability](STRICTDOC-TRACEABILITY.md)、[Tooling acceptance](../verification/SPECIFICATION-TOOLING-ACCEPTANCE.md)
**Implementation identifiers**: .github/workflows/repository-audit.yml; scripts/verification/artifacts/pages-live-ux.mjs; scripts/audit/traceability-ui.js
**Surface identifiers**: ciWorkflow=.github/workflows/repository-audit.yml
**Test IDs**: TEST-TRC-07-002
**Exact-run reference**: NOT_RUN
**Comment**: The registered fixture checks the publication verifier. Public acceptance relies on the producer's own post-deployment check.

Repository Audit Pagesの公開確認は正規URLで配信中のHTML・JSON・manifestと対象SHAを照合する。PR previewおよび公開後の照合が未完了のsiteはTRC-07の公開確認を保留する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: .github/workflows/repository-audit.yml
- **Type**: File
  **Path**: scripts/verification/artifacts/pages-live-ux.mjs
- **Type**: File
  **Path**: scripts/audit/traceability-ui.js

## OBL-REQ-API-002-O02

**Type**: OBLIGATION
**MID**: ad50ca5561638f31c50b903a29477981
**UID**: OBL-REQ-API-002-O02
**Design reference**: docs/architecture/API-CONTRACT.md; docs/design/INTERACTION-CONTRACT.md
**Implementation identifiers**: API-PERSIST-007
**Surface identifiers**: httpOperation=PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}
**Test IDs**: TEST-API-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

The document save operation binds author request identity, base revision precondition, idempotency identity and database receipt; conflict or uncertain response is not represented as success.

**Relations**:

- **Type**: Parent
  **ID**: REQ-API-002

- **Type**: File
  **Path**: packages/api/src/persistence-routes.ts
  **Lines**: 368, 403

## OBL-REQ-DATA-002-O02

**Type**: OBLIGATION
**MID**: 0d4dc9d2f913e49708a6689e1490df6e
**UID**: OBL-REQ-DATA-002-O02
**Design reference**: docs/architecture/DATA-MODEL.md
**Implementation identifiers**: document_revision_immutable
**Surface identifiers**: objectId=document_revision_immutable
**Test IDs**: TEST-DATA-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

A persisted document revision rejects mutation and deletion.

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-002

- **Type**: File
  **Path**: packages/persistence-postgres/migrations/0001-initial.sql
  **Lines**: 60, 62

## OBL-REQ-DATA-002-O03

**Type**: OBLIGATION
**MID**: 4a8f75df53d052043d83da6905248eae
**UID**: OBL-REQ-DATA-002-O03
**Design reference**: docs/architecture/DATA-MODEL.md; docs/architecture/API-CONTRACT.md
**Implementation identifiers**: edit_operation; API-PERSIST-007
**Surface identifiers**: objectId=edit_operation; httpOperation=PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}
**Test IDs**: TEST-DATA-002-002
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

A save or restore creates a new immutable revision and a database receipt for the author operation.

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-002

- **Type**: File
  **Path**: packages/api/src/persistence-routes.ts
  **Lines**: 368, 403

- **Type**: File
  **Path**: packages/persistence-postgres/migrations/0001-initial.sql
  **Lines**: 64, 82

## OBL-REQ-UI-002-O02

**Type**: OBLIGATION
**MID**: 2e4c67561042509e3d3d139bd9421578
**UID**: OBL-REQ-UI-002-O02
**Design reference**: docs/design/INTERACTION-CONTRACT.md; docs/design/SCREEN-CONTROL-CATALOG.md
**Implementation identifiers**: WRT-01.A; REC-01.A; REC-01.B
**Surface identifiers**: controlId=WRT-01.A; controlId=REC-01.A; controlId=REC-01.B
**Test IDs**: TEST-UI-002-001
**Exact-run reference**: NOT_RUN
**Comment**: Explicit criterion; source and test references are candidates only; no independent certification is implied.

A recovery draft is durably journaled before remote write, and an unknown response can be reconciled with the same operation identity.

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-002

- **Type**: File
  **Path**: app/src/storage/journal.ts
  **Lines**: 314, 330

- **Type**: File
  **Path**: app/src/editor/postgresEvidenceAdapter.ts
  **Lines**: 73, 80

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

Keep discovered HTTP routes, MCP tools, database objects, Desktop UI controls, Native iOS views, Terraform resources, and Ansible sources visible as unclassified until each has a reasoned requirement or non-requirement classification.

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

## TEST-TRC-08-001

**Type**: TEST
**MID**: 7554b5f2d31df6dadb5d2307590bf5a5
**UID**: TEST-TRC-08-001
**Case name**: projects obligations, reverse surfaces, and evidence links without conformance promotion
**Exact-run reference**: NOT_RUN

Verify the public Requirements projection preserves explicit obligation links, candidate-only classifications, declared test sources, source SHA links, and existing conformance states.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/audit/specifications.test.mjs

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

## TEST-MCPV-001-001

**Type**: TEST
**MID**: 553a90f344c0743e6be1b613946071da
**UID**: TEST-MCPV-001-001
**Case name**: native MCP schemas bound UUID reads and accept only the seven ordinary native ChangeSet operations
**Exact-run reference**: NOT_RUN

Verify the registered native Knowledge schemas reject invalid UUIDs and out-of-contract operations. This is a runtime-schema test candidate; it does not establish full SDK protocol conformance or a hosted exact-source result.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: modules/mcp/src/tools.test.ts
  **Lines**: 273, 273

## TEST-MCP-CORE-001-001

**Type**: TEST
**MID**: b304ab460592f7f49cbda0cd9d4c39ac
**UID**: TEST-MCP-CORE-001-001
**Case name**: stdio and Streamable HTTP enforce external Assistant admission with a configured provider
**Exact-run reference**: NOT_RUN

Verify the configured external Assistant admission boundary and that MCP dispatch does not call the configured model provider. This is an REQ-MCP-002 scenario, not the MCP SDK protocol conformance CLI run required by MCPV-002.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-002
- **Type**: File
  **Path**: tests/integration/mcp-acceptance.test.mjs
  **Lines**: 888, 966

## TEST-MCPV-004-001

**Type**: TEST
**MID**: 9d036a15f7de684bfe7ee1f6093eb235
**UID**: TEST-MCPV-004-001
**Case name**: native Knowledge MCP tools preserve PostgreSQL scope, proposal, replay, review and receipt over both transports
**Exact-run reference**: NOT_RUN

Exercise selected-project scope, proposal-only MCP writes, replay handling, author review, receipt, and both stdio and Streamable HTTP transports against PostgreSQL. It is a candidate for MCPV-004 and MCPV-005; each protocol authorization dimension remains separately unverified until its specific case evidence exists.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: tests/integration/mcp-acceptance.test.mjs
  **Lines**: 438, 779

## TEST-MCPV-006-001

**Type**: TEST
**MID**: 4a482103850c55bc7b177207fc5182d8
**UID**: TEST-MCPV-006-001
**Case name**: MCP cancellation stops real NLP worker jobs through stdio and Streamable HTTP
**Exact-run reference**: NOT_RUN

Exercise cancellation of real NLP jobs over both transports. HTTP shutdown and drain are exercised by the same test through `verifyHttpDrain`; protocol header limits and cross-request isolation still need separate evidence.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: tests/integration/mcp-acceptance.test.mjs
  **Lines**: 859, 886

## TEST-MCPV-004-002

**Type**: TEST
**MID**: 9a4e2608082648f649f3e4d15808ce37
**UID**: TEST-MCPV-004-002
**Case name**: admits registered MCP OAuth clients by exact operation scope without owner rights
**Exact-run reference**: NOT_RUN

Exercise signed MCP bearer admission for exact client, scope, assigned-project, owner-rights, and effect boundaries. This server fixture uses manually constructed tokens; it does not establish OAuth PKCE issuance or external client interop.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: packages/api/src/server.test.ts
  **Lines**: 2109, 2456

## TEST-MCPV-001-002

**Type**: TEST
**MID**: e8177bf3a4aebd82fd6d5542fc959d82
**UID**: TEST-MCPV-001-002
**Case name**: MCP tools/list publishes the compatible tool names and object input schemas
**Exact-run reference**: NOT_RUN

Check the SDK tools/list catalog against the 53 public tool names and ensure every advertised input schema is an object with valid required fields and expected defaults. This is catalog coverage, not a protocol conformance result.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: modules/mcp/src/tool-catalog.test.ts
  **Lines**: 96, 120

## TEST-MCPV-006-002

**Type**: TEST
**MID**: 648436169a722ca028a296e5a785b465
**UID**: TEST-MCPV-006-002
**Case name**: aborting the host Web Request closes the modern SDK exchange
**Exact-run reference**: NOT_RUN

Check that aborting the host Web Request cancels the SDK exchange, propagates the abort signal, closes the exchange with 499, and releases the pending action. It complements the real worker cancellation and shutdown drain integration case.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: modules/mcp/src/http.test.ts
  **Lines**: 953, 1009

## TEST-MCPV-007-001

**Type**: TEST
**MID**: bc85b804bdf4f21c36706b3fd4b4b81f
**UID**: TEST-MCPV-007-001
**Case name**: MCP HTTP serves modern per-request envelopes through the official v2 client
**Exact-run reference**: NOT_RUN

Exercise the official v2 client against the modern pinned protocol version and confirm per-request Streamable HTTP tool listing.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: modules/mcp/src/http.test.ts
  **Lines**: 227, 240

## TEST-MCPV-007-002

**Type**: TEST
**MID**: 184f741818cfa72a7be4d7de0603bf08
**UID**: TEST-MCPV-007-002
**Case name**: MCP HTTP accepts the temporary stateless 2025 fallback
**Exact-run reference**: NOT_RUN

Exercise the temporary legacy stateless JSON-RPC tools/list fallback while that compatibility window remains open.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: modules/mcp/src/http.test.ts
  **Lines**: 242, 249

## TEST-MCPV-007-003

**Type**: TEST
**MID**: 1169579fc2155d97d587f1edeb82d3ee
**UID**: TEST-MCPV-007-003
**Case name**: strict MCP HTTP rejects legacy traffic and delegates invalid methods
**Exact-run reference**: NOT_RUN

Check strict mode rejects legacy stateless traffic and delegates unsupported GET/DELETE methods with 405.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: modules/mcp/src/http.test.ts
  **Lines**: 251, 259

## TEST-MCPV-007-004

**Type**: TEST
**MID**: 01551c49fc512cac6bef9515c2d86fef
**UID**: TEST-MCPV-007-004
**Case name**: 2025 protocol compatibility ends at the six-month cutoff
**Exact-run reference**: NOT_RUN

Check the compatibility predicate immediately before, at, and after the six-month protocol cutoff.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: modules/mcp/src/protocol-version.test.ts
  **Lines**: 5, 9

## TEST-MCPV-006-003

**Type**: TEST
**MID**: 7e194994663116ff2e6509e25a9b37b4
**UID**: TEST-MCPV-006-003
**Case name**: modern Mcp-Method and Mcp-Name mismatches are rejected before tool dispatch
**Exact-run reference**: NOT_RUN

Check mismatched modern MCP method/name headers are rejected before any tool dispatch.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: modules/mcp/src/http.test.ts
  **Lines**: 261, 309

## TEST-MCPV-006-004

**Type**: TEST
**MID**: cb127df399b9b085e9ffc9c5f05af3dd
**UID**: TEST-MCPV-006-004
**Case name**: oversized MCP request body is refused before creating the SDK action context
**Exact-run reference**: NOT_RUN

Check an oversized request body receives 413 before the SDK action context is accessed.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: modules/mcp/src/http.test.ts
  **Lines**: 311, 330

## TEST-MCPV-006-005

**Type**: TEST
**MID**: 79d00c3ff35b508520399c674c4976ab
**UID**: TEST-MCPV-006-005
**Case name**: does not activate the MCP module for a request cancelled during admission
**Exact-run reference**: NOT_RUN

Close an MCP connection during OAuth admission and confirm that only the connected control request reaches module activation.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: packages/api/src/server.test.ts
  **Lines**: 5031, 5078

## TEST-MCPV-004-003

**Type**: TEST
**MID**: 290cc979d9a509fd13d2b4d6ce86b894
**UID**: TEST-MCPV-004-003
**Case name**: Better Auth PKCE MCP client lists and invokes tools through central OAuth admission
**Exact-run reference**: NOT_RUN

Exercise Better Auth public-client registration, authorization code with PKCE, registered resource, refresh, token revocation, project scope, and 2026 HTTP tool calls through the existing Fastify boundary and PostgreSQL.

**Relations**:

- **Type**: Parent
  **ID**: REQ-MCP-001
- **Type**: File
  **Path**: packages/api/test/better-auth.integration.test.ts
  **Lines**: 54, 644

## TEST-CORE-001-001

**Type**: TEST
**MID**: 185414049c5eb1d2e04f77a167bb140c
**UID**: TEST-CORE-001-001
**Case name**: Core-only workspace keeps authoring available without search or terminology panels
**Exact-run reference**: NOT_RUN

Checks the core-only author workspace without the optional search and terminology panels.

**Relations**:

- **Type**: Parent
  **ID**: REQ-CORE-001
- **Type**: File
  **Path**: tests/e2e/modular-workspace.acceptance.spec.ts
  **Lines**: 854, 854

## TEST-CORE-002-001

**Type**: TEST
**MID**: 0f608e16790fef30a5afe8e68441c1cf
**UID**: TEST-CORE-002-001
**Case name**: desktop native author review keeps approval separate from apply and preserves the manuscript
**Exact-run reference**: NOT_RUN

Checks that Desktop approval and application stay separate for a native proposal.

**Relations**:

- **Type**: Parent
  **ID**: REQ-CORE-002
- **Type**: File
  **Path**: tests/e2e/native-review.acceptance.spec.ts
  **Lines**: 97, 97

## TEST-CORE-003-001

**Type**: TEST
**MID**: 015192e462e2cbc0c84cdd9c822aa529
**UID**: TEST-CORE-003-001
**Case name**: serves only the selected editor document revision from the current or pinned snapshot
**Exact-run reference**: NOT_RUN

Checks the selected document and revision on current and pinned snapshots.

**Relations**:

- **Type**: Parent
  **ID**: REQ-CORE-003
- **Type**: File
  **Path**: packages/api/src/server.test.ts
  **Lines**: 3105, 3105

## TEST-DATA-001-001

**Type**: TEST
**MID**: 485a1595569c9f6e4a98dbc89167fd58
**UID**: TEST-DATA-001-001
**Case name**: Git store selector cannot bypass PostgreSQL-only authoring
**Exact-run reference**: NOT_RUN

Checks that the retired Git selector cannot change the manuscript authority.

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-001
- **Type**: File
  **Path**: tests/e2e/persistence-database.acceptance.spec.ts
  **Lines**: 1646, 1646

## TEST-DATA-002-001

**Type**: TEST
**MID**: a89e6eb9e61f92d81a1c5fbb62ea4d41
**UID**: TEST-DATA-002-001
**Case name**: migrations are repeatable and document revisions stay immutable
**Exact-run reference**: NOT_RUN

Checks update rejection for an existing PostgreSQL document revision. Delete rejection still requires a matching case.

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-002
- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.test.ts
  **Lines**: 182, 182

## TEST-DATA-002-002

**Type**: TEST
**MID**: 86d4bd4e81bcd5668ee52a26857715d5
**UID**: TEST-DATA-002-002
**Case name**: UTF-16 edits, idempotency, revision restoration and stale-head conflicts
**Exact-run reference**: NOT_RUN

Checks revision creation, exact retry, restore and stale-head conflict in PostgreSQL.

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-002
- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.test.ts
  **Lines**: 509, 509

## TEST-DATA-003-001

**Type**: TEST
**MID**: e50ce01b5b362ae6d85710d64c90c4d1
**UID**: TEST-DATA-003-001
**Case name**: database foreign keys prevent Knowledge relations from crossing projects
**Exact-run reference**: NOT_RUN

Checks the PostgreSQL project boundary for Knowledge relations.

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-003
- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.test.ts
  **Lines**: 473, 473

## TEST-DATA-004-001

**Type**: TEST
**MID**: 48f3286bb2251c83e9d8cda25588c56b
**UID**: TEST-DATA-004-001
**Case name**: read-only schema verification rejects missing, altered and newer migration ledgers
**Exact-run reference**: NOT_RUN

Checks rejection of missing, changed and unknown applied migrations.

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-004
- **Type**: File
  **Path**: packages/persistence-postgres/src/postgres-store.test.ts
  **Lines**: 148, 148

## TEST-AUTH-001-001

**Type**: TEST
**MID**: f1568451c92530e0fd44403408b56497
**UID**: TEST-AUTH-001-001
**Case name**: authorizes standalone owner writes only with a verified API-audience OAuth access token
**Exact-run reference**: NOT_RUN

Checks the API entry point rejects writes without a verified owner token for its audience.

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-001
- **Type**: File
  **Path**: packages/api/src/server.test.ts
  **Lines**: 1950, 1950

## TEST-AUTH-002-001

**Type**: TEST
**MID**: 4ca46d58f11ffa03396df371ecd52a05
**UID**: TEST-AUTH-002-001
**Case name**: runs admission before payload validation and rejects unregistered methods and origins
**Exact-run reference**: NOT_RUN

Checks admission ordering and refusal of unregistered methods and origins.

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-002
- **Type**: File
  **Path**: packages/api/src/server.test.ts
  **Lines**: 891, 891

## TEST-AUTH-003-001

**Type**: TEST
**MID**: f8859594d441465515ed94af70b93c74
**UID**: TEST-AUTH-003-001
**Case name**: MCP project assignments are required, exact, and reject malformed or duplicate mappings
**Exact-run reference**: NOT_RUN

Checks exact MCP project assignment and rejection of malformed configuration.

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-003
- **Type**: File
  **Path**: packages/api/src/oauth-mcp.test.ts
  **Lines**: 81, 81

## TEST-AUTH-003-002

**Type**: TEST
**MID**: a208fcd03e8a4f2427dc2c62e2da8f6a
**UID**: TEST-AUTH-003-002
**Case name**: admits registered MCP OAuth clients by exact operation scope without owner rights
**Exact-run reference**: NOT_RUN

Checks admitted MCP scope and denies owner operations through Fastify.

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-003
- **Type**: File
  **Path**: packages/api/src/server.test.ts
  **Lines**: 2177, 2177

## TEST-AUTH-004-001

**Type**: TEST
**MID**: 87c4eb8d847862e609ba67aa845da0ce
**UID**: TEST-AUTH-004-001
**Case name**: same-origin setup-only Fastify commits one verified owner and closes setup before OAuth activation
**Exact-run reference**: NOT_RUN

Checks verified owner enrollment and closure of the isolated setup endpoint.

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-004
- **Type**: File
  **Path**: packages/api/test/passkey-bootstrap.acceptance.test.ts
  **Lines**: 921, 921

## TEST-AUTH-005-001

**Type**: TEST
**MID**: 5e061d5d151d5d83d821f24f76deac62
**UID**: TEST-AUTH-005-001
**Case name**: passkey management requires the fresh owner and rejects deletion of their last passkey
**Exact-run reference**: NOT_RUN

Checks fresh-owner authorization and preservation of the final passkey.

**Relations**:

- **Type**: Parent
  **ID**: REQ-AUTH-005
- **Type**: File
  **Path**: packages/api/src/owner-security.test.ts
  **Lines**: 108, 108

## TEST-API-001-001

**Type**: TEST
**MID**: 445b67648bfb9ff548d962c23e7d3a2e
**UID**: TEST-API-001-001
**Case name**: Knowledge browse returns a filter-bound page cursor and rejects stale project snapshots
**Exact-run reference**: NOT_RUN

Checks one HTTP operation's cursor contract and rejection of stale snapshots.

**Relations**:

- **Type**: Parent
  **ID**: REQ-API-001
- **Type**: File
  **Path**: packages/api/src/persistence-routes.test.ts
  **Lines**: 56, 56

## TEST-API-002-001

**Type**: TEST
**MID**: 0a2034eae039ef847c3980b32816f7f6
**UID**: TEST-API-002-001
**Case name**: a committed save with a lost response is reconciled after reload with the same operation identity
**Exact-run reference**: NOT_RUN

Checks recovery after a lost response to a committed save with the original operation identity.

**Relations**:

- **Type**: Parent
  **ID**: REQ-API-002
- **Type**: File
  **Path**: tests/e2e/core.acceptance.spec.ts
  **Lines**: 325, 325

## TEST-UI-001-001

**Type**: TEST
**MID**: 1d581794ed7e9c7e03333bec48c25c24
**UID**: TEST-UI-001-001
**Case name**: the launcher opens Desktop for new and legacy choices and rejects retired Mobile routes
**Exact-run reference**: NOT_RUN

Checks the Desktop launcher and retired Mobile routes. The scenario covers the Web branch.

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-001
- **Type**: File
  **Path**: tests/e2e/ui-v1.acceptance.spec.ts
  **Lines**: 238, 238

## TEST-UI-002-001

**Type**: TEST
**MID**: e64f90cfa8b1f2db8d6556c95d239d10
**UID**: TEST-UI-002-001
**Case name**: a lost save response survives newer input, reloads, and rebases the newer draft after acknowledgement
**Exact-run reference**: NOT_RUN

Checks preservation and reconciliation of the newer draft after an uncertain save.

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-002
- **Type**: File
  **Path**: tests/e2e/core.acceptance.spec.ts
  **Lines**: 398, 398

## TEST-UI-003-001

**Type**: TEST
**MID**: 83cb8a7fd19a88e76412f8a9eeb9ac61
**UID**: TEST-UI-003-001
**Case name**: desktop tab guard denial retains selection and a delayed transition cannot focus an obsolete tab
**Exact-run reference**: NOT_RUN

Checks a guarded Desktop tab transition and rejects obsolete focus.

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-003
- **Type**: File
  **Path**: tests/e2e/modular-workspace.acceptance.spec.ts
  **Lines**: 108, 108

## TEST-UI-004-001

**Type**: TEST
**MID**: 5355b19a94521a4d5cc5d0cf3aa64557
**UID**: TEST-UI-004-001
**Case name**: legacy draft composition cannot write old scene text into a newly selected scene
**Exact-run reference**: NOT_RUN

Checks composition during scene navigation preserves the correct document boundary.

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-004
- **Type**: File
  **Path**: tests/e2e/ui-v1.acceptance.spec.ts
  **Lines**: 229, 229

## TEST-UI-005-001

**Type**: TEST
**MID**: 4d4f7499e20ad11e32e329fe726434b6
**UID**: TEST-UI-005-001
**Case name**: desktop stack tabs use roving focus and keep the rendered panel association valid
**Exact-run reference**: NOT_RUN

Checks keyboard focus order and panel associations for the Desktop tab stack.

**Relations**:

- **Type**: Parent
  **ID**: REQ-UI-005
- **Type**: File
  **Path**: tests/e2e/modular-workspace.acceptance.spec.ts
  **Lines**: 70, 70

## TEST-EXT-001-001

**Type**: TEST
**MID**: fbb0da7847cde11b3166cfbba9899e28
**UID**: TEST-EXT-001-001
**Case name**: public OAuth edge probe checks protocol metadata, MCP challenge, API denial and retained UI Access
**Exact-run reference**: NOT_RUN

Checks the probe's expected routing and denial observations with fixtures. Live Edge verification requires its own execution.

**Relations**:

- **Type**: Parent
  **ID**: REQ-EXT-001
- **Type**: File
  **Path**: scripts/verification/infrastructure/public-oauth-edge.test.mjs
  **Lines**: 67, 67

## TEST-EXT-002-001

**Type**: TEST
**MID**: a267862223d54a509a5b93726ebb3505
**UID**: TEST-EXT-002-001
**Case name**: public metadata publishes only the standalone MCP scope ceiling
**Exact-run reference**: NOT_RUN

Checks the externally published MCP scope ceiling in OAuth metadata.

**Relations**:

- **Type**: Parent
  **ID**: REQ-EXT-002
- **Type**: File
  **Path**: packages/contracts/src/oauth-metadata.test.ts
  **Lines**: 20, 20

## TEST-OPS-001-001

**Type**: TEST
**MID**: 71abc3d8ea0b266e760e25a8b5f0666e
**UID**: TEST-OPS-001-001
**Case name**: R5 separates enrollment start from preparation, and rejects existing owner reissuance
**Exact-run reference**: NOT_RUN

Checks separation of the bootstrap admission states and refusal to reissue an existing owner grant.

**Relations**:

- **Type**: Parent
  **ID**: REQ-OPS-001
- **Type**: File
  **Path**: scripts/deployment/bootstrap/admission.test.mjs
  **Lines**: 67, 67

## TEST-OPS-002-001

**Type**: TEST
**MID**: 81d87f39e0e51220bdedf453db454bec
**UID**: TEST-OPS-002-001
**Case name**: rejects unsuccessful, foreign, non-main, stale, or wrong-workflow Verify evidence
**Exact-run reference**: NOT_RUN

Checks source certification rejection in the update handoff with fixtures.

**Relations**:

- **Type**: Parent
  **ID**: REQ-OPS-002
- **Type**: File
  **Path**: scripts/deployment/admission/certificate.test.mjs
  **Lines**: 30, 30

## TEST-OPS-003-001

**Type**: TEST
**MID**: 39af32e2e1ba0c9596ca11da0ccb83a7
**UID**: TEST-OPS-003-001
**Case name**: restore drill verifies fingerprints before success evidence or candidate-ledger proof
**Exact-run reference**: NOT_RUN

Checks restore proof and candidate-ledger verification with fixtures. Live S3 transfer and independent restore execution still require evidence.

**Relations**:

- **Type**: Parent
  **ID**: REQ-OPS-003
- **Type**: File
  **Path**: scripts/deployment/recovery/backup.test.mjs
  **Lines**: 434, 434

## TEST-QUAL-001-001

**Type**: TEST
**MID**: 95e1f928a883a2ff425e74ce6cb7034e
**UID**: TEST-QUAL-001-001
**Case name**: disposable app lifecycle is not admitted by isolated workspace tests
**Exact-run reference**: NOT_RUN

Checks that workspace tests cannot substitute for the isolated lifecycle proof.

**Relations**:

- **Type**: Parent
  **ID**: REQ-QUAL-001
- **Type**: File
  **Path**: scripts/ci/impact/plan.test.mjs
  **Lines**: 121, 121

## TEST-QUAL-002-001

**Type**: TEST
**MID**: caaf25963c3500c09149e168699bf6d0
**UID**: TEST-QUAL-002-001
**Case name**: missing, stale, failed, skipped and duplicate evidence cannot certify selected work
**Exact-run reference**: NOT_RUN

Checks rejection of insufficient selected-task evidence.

**Relations**:

- **Type**: Parent
  **ID**: REQ-QUAL-002
- **Type**: File
  **Path**: scripts/ci/evidence/validation.test.mjs
  **Lines**: 42, 42

## TEST-TRC-04-003

**Type**: TEST
**MID**: 77afb3792554e354b69dc58fdb3008a5
**UID**: TEST-TRC-04-003
**Case name**: fault injection rejects stale route, tool, and database classifications removed from source inventory
**Exact-run reference**: NOT_RUN

Checks rejection when documented route, tool and database identities are no longer discovered.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-05-004

**Type**: TEST
**MID**: 2e92518dec80e9ba9e72d53b18016a52
**UID**: TEST-TRC-05-004
**Case name**: rejects foreign artifacts, stale source, skipped certification, mismatched attempts and skipped required cases
**Exact-run reference**: NOT_RUN

Checks artifact provenance, producer attempts and refusal to promote a skipped case.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/ci/evidence/trace-receipt.test.mjs

## TEST-TRC-06-001

**Type**: TEST
**MID**: c777c4e74536f31f6b3d79106743d409
**UID**: TEST-TRC-06-001
**Case name**: passing observed UI case cannot promote an explicitly unimplemented requirement
**Exact-run reference**: NOT_RUN

Checks that an observed passing case cannot promote an unimplemented UI obligation.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/obligation-trace.test.mjs

## TEST-TRC-06-002

**Type**: TEST
**MID**: 6961c6ddf4daccf12a2e8963c1e83c0a
**UID**: TEST-TRC-06-002
**Case name**: missing S3 receipt remains a blocked trace limitation and G5 remains NOT_RUN
**Exact-run reference**: NOT_RUN

Checks that the trace retains a missing S3 receipt as a limitation.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/strictdoc/verify.test.mjs

## TEST-TRC-07-002

**Type**: TEST
**MID**: 3694489c139146c11b7ff49148e69fc9
**UID**: TEST-TRC-07-002
**Case name**: live Pages proof checks public response revision, route and snapshot bytes
**Exact-run reference**: NOT_RUN

Checks public route identity and exact-source output bytes with controlled responses.

**Relations**:

- **Type**: Parent
  **ID**: REQ-TRACE-001
- **Type**: File
  **Path**: scripts/verification/artifacts/pages-live-ux.test.mjs

## REQ-DATA-005

**MID**: ad3b54d5fb2fa830c9b9d69a177a3d92
**UID**: REQ-DATA-005
**Decision status**: ACCEPTED
**Conformance status**: UNMAPPED
**Applicability**: FUTURE_TARGET
**Design owner**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: JobHistoryStore; RecentActivityStore; PostgreSQL persistence and approved migrations; Quadlet volume lifecycle (target, 未実装)
**Verification identifiers**: NOT_ASSIGNED (future acceptance scenarios in owning design)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／将来目標・未実装。既存sourceは移行候補であり適合証拠ではない。

復旧に必要な確定済みサーバーアプリケーション状態を単一PostgreSQLクラスタに集約し、DB外のアプリケーション領域は再生成可能なデータまたは一時領域に限定する。

**Relations**:

- **Type**: File
  **Path**: docs/architecture/DATA-MODEL.md

## OBL-REQ-DATA-005-O01

**Type**: OBLIGATION
**MID**: c3c4e72ae44536489c0d5bdb6a09634f
**UID**: OBL-REQ-DATA-005-O01
**Design reference**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: packages/persistence-postgres/; packages/api/src/backup-console-store.ts (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

全runtime profileの永続状態を棚卸しし、作品、認証、ユーザー状態、運用記録を単一クラスタに保存する。スキーマ・role・owner/project境界を維持する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-005

## OBL-REQ-DATA-005-O02

**Type**: OBLIGATION
**MID**: 510d6a0da145483ee20d5ba748b4072c
**UID**: OBL-REQ-DATA-005-O02
**Design reference**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: packages/api/src/job-history-store.ts: JobHistoryStore (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

ジョブ、結果、通知、既読と状態遷移を原子的に確定し、既存の状態・保持・中断契約を維持する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-005

## OBL-REQ-DATA-005-O03

**Type**: OBLIGATION
**MID**: bd6d8ac8e1cf067b17dd1daeb2b3d29a
**UID**: OBL-REQ-DATA-005-O03
**Design reference**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: packages/api/src/recent-activity-store.ts: RecentActivityStore (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

Recent Activityのcursorとwriter/page順序を同一DBトランザクションで更新し、競合と遅延応答で新しい状態を失わない。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-005

## OBL-REQ-DATA-005-O04

**Type**: OBLIGATION
**MID**: 3610bface7e2a1e65b22bdbe02506477
**UID**: OBL-REQ-DATA-005-O04
**Design reference**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: packages/api/src/maintain-job-history.ts; deploy/quadlet/codexia-api.container (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

旧historyの検証付き移行を冪等に行い、DB障害時の代替ファイル書込みを禁止する。受入後に旧ストア・volume・互換分岐を廃止する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-005

## OBL-REQ-DATA-005-O05

**Type**: OBLIGATION
**MID**: 52bf39baaa7f67f9de79d9378e0d6565
**UID**: OBL-REQ-DATA-005-O05
**Design reference**: [Data model](../architecture/DATA-MODEL.md)
**Implementation identifiers**: deploy/backup/backup.sh; deploy/ansible/restore-drill.yml (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

独立保全されたDB、再配備した構成/秘密情報、空の派生cacheだけで新規VMの確定済み状態を復旧できることを実証する。現行バックアップの廃止には別途承認を要する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-005

## REQ-DATA-006

**MID**: d9983b4b35d1e4e841037b838c59c303
**UID**: REQ-DATA-006
**Decision status**: ACCEPTED
**Conformance status**: UNMAPPED
**Applicability**: FUTURE_TARGET
**Design owner**: [Portable works](../authoring-portable.md)
**Implementation identifiers**: packages/api/src/work-archive.ts: exportWorkArchive; PersistenceReader; existing project export entry (target, 未実装)
**Verification identifiers**: NOT_ASSIGNED (future acceptance scenarios in owning design)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: ACCEPTED／将来目標・未実装。既存sourceは移行候補であり適合証拠ではない。

作者がCodexiaなしで作品の確定済み本文・構成・知識・根拠・保持された過去Revisionを利用できる、公開仕様のZIP/UTF-8 Markdown/JSONによる離脱用エクスポートを提供する。

**Relations**:

- **Type**: File
  **Path**: docs/authoring-portable.md

## OBL-REQ-DATA-006-O01

**Type**: OBLIGATION
**MID**: f856ef5614d12e7c2de882e9e0667d07
**UID**: OBL-REQ-DATA-006-O01
**Design reference**: [Portable works](../authoring-portable.md)
**Implementation identifiers**: packages/api/src/work-archive.ts (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

作品をZIPで取得し、一般的な展開ツールとエディタでMarkdownを利用できる。公開version付きmanifest、JSON Schema、説明書、パス・順序・ID・hashを同梱する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-006

## OBL-REQ-DATA-006-O02

**Type**: OBLIGATION
**MID**: 48001e1bbab80bd75f8bdc781b211fb2
**UID**: OBL-REQ-DATA-006-O02
**Design reference**: [Portable works](../authoring-portable.md)
**Implementation identifiers**: packages/persistence-contracts/src/index.ts: PersistenceReader; packages/persistence-postgres/src/postgres-store.ts (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

保持された過去Revisionと回復可能な論理削除文書を区別し、全本文の文字・改行・階層・順序と参照を保存する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-006

## OBL-REQ-DATA-006-O03

**Type**: OBLIGATION
**MID**: cb217de1704bb6bfbc287a509ef2ee3c
**UID**: OBL-REQ-DATA-006-O03
**Design reference**: [Portable works](../authoring-portable.md)
**Implementation identifiers**: packages/api/src/work-archive.ts: exportWorkArchive (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

Knowledge、Evidence、Assertion、未解決参照、許可された作者所有module recordsを構造化出力し、参照の真正な対応を保持する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-006

## OBL-REQ-DATA-006-O04

**Type**: OBLIGATION
**MID**: be77b9ff6017d4687d70ed902ce5ade2
**UID**: OBL-REQ-DATA-006-O04
**Design reference**: [Portable works](../authoring-portable.md)
**Implementation identifiers**: packages/api/src/persistence-routes.ts; packages/api/src/work-archive.ts (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

作者認可と作品境界を強制し、非認可principal、秘密情報、内部authority、運用状態、未確定draftを排除する。安全な除外記録を返す。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-006

## OBL-REQ-DATA-006-O05

**Type**: OBLIGATION
**MID**: 24fc9e798a49c823411b221652b104af
**UID**: OBL-REQ-DATA-006-O05
**Design reference**: [Portable works](../authoring-portable.md)
**Implementation identifiers**: packages/api/src/work-archive.ts; packages/persistence-postgres/src/postgres-store.ts (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

単一snapshotから大容量作品と全ページを欠落なく生成し、リソース上限、異常、キャンセルを完了と誤表示しない。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-006

## OBL-REQ-DATA-006-O06

**Type**: OBLIGATION
**MID**: db33b8c0c008bb5ea1092fcb44e9dd9b
**UID**: OBL-REQ-DATA-006-O06
**Design reference**: [Portable works](../authoring-portable.md)
**Implementation identifiers**: packages/api/src/work-archive.ts; packages/http-contract/src/routes-persistence.tsp (target candidate)
**Test IDs**: NOT_ASSIGNED (implementation and test mapping pending)
**Exact-run reference**: NOT_RUN
**Comment**: Future target; no implementation or exact-source evidence claimed.

既存のJSON交換・import、認可と正本を維持し、保守されたZIPライブラリと既存永続化読み取り経路を利用する。

**Relations**:

- **Type**: Parent
  **ID**: REQ-DATA-006
