# PostgreSQL 物理データ詳細契約

**種別: 規範的データ詳細設計。** 概念上の関係、author-owned data、immutable revision、プロジェクト境界は [Data model](DATA-MODEL.md) と [Core](CORE.md) が正本。本書はテーブル・列・制約・index・migration identity・権限境界を、具体的なSQLオブジェクトおよび検証項目に対応付ける。**既存migration SQLの存在が新しい設計決定になるわけではない。** 実SQLと規範設計の差異は変更要求または逸脱として扱う。

**初期照合ベースライン:** main@e02933aead466b14cbcd336905b9c2a2a2b39f06。照合したファイルは packages/persistence-postgres/migrations/0001-initial.sql、0002-orphaned-evidence-ranges.sql、0003-project-workspace.sql、src/migrate.ts、src/migration-set.ts、packages/api/src/auth-schema.ts。既存本番DBの実DDL出力とのdiffは未取得。

## スキーマの分離と所有権

| DB ID | 所属 | 所有実装 | 責務・不変条件 |
| --- | --- | --- | --- |
| DB-APP-001 | public のアプリドメイン表 | packages/persistence-postgres/migrations/*.sql、postgres-store.ts | 作者原稿・構成・Revision・Knowledge・Evidence・ChangeSet・module recordの唯一の永続正本 |
| DB-LEDGER-001 | public.codexia_schema_migrations | packages/persistence-postgres/src/migrate.ts | 適用済みmigration名、checksum、適用時刻を記録するledger。作品正本データではない |
| DB-AUTH-001 | codexia_auth | packages/api/src/auth-schema.ts、migrate-auth.ts、better-auth.ts | Better Authのuser、Passkey、session、OAuth等とrevocation。アプリpublic schemaから分離する |
| DB-CLIENT-001 | browser IndexedDB | app/src/storage/、[Interaction](../design/INTERACTION-CONTRACT.md) | 未確定のdraft/回復journal。PostgreSQLの代替正本や第二writerではない |
| DB-DERIVED-001 | module cache / index / model | [Modules](MODULES.md) | 再構築可能な派生物。原稿や作者判断を再保存しない |

認証schemaの物理DDLをpublicのアプリmigrationへ移さない。認証用role、migration role、アプリroleの分離は [Auth](API-AUTHN-AUTHZ.md)、deploy/ansible/verify-postgres-roles.sql、deploy/ansible/AUTH-RUNTIME.md と照合する。roleが一致するだけで権限全体を検証済みとはしない。

## アプリschemaの物理オブジェクト台帳

以下は**観測した最終DDLの列と主制約の要約**。全列のnullability、default、CHECK/FK、index methodまで検証可能なSQLが詳細契約の最終形であり、この表をSQLの完全な代替にはしない。

| DB ID | table・主キー | フィールド（実SQLの代表型） | 守る条件と接続先 |
| --- | --- | --- | --- |
| DB-T001 | project / id uuid | title text、settings jsonb、version integer、created_at/updated_at timestamptz | 非空title、object settings、正のversion。作者作品の基点 |
| DB-T002 | document / (project_id,id) uuid | parent_id uuid nullable、kind/title/order_key text、head_revision_id uuid nullable、version integer、created_at/updated_at timestamptz、deleted_at timestamptz nullable（0003追加） | parentが同一project、自己親不可、headは同document revision。階層・soft deletion |
| DB-T003 | document_revision / (project_id,document_id,id) uuid | parent_revision_id uuid nullable、markdown text、sha256 char(64)、author_id text、created_at timestamptz | 参照先document/revisionのscope一致、SHA形式、UPDATE/DELETE不可のimmutable trigger |
| DB-T004 | edit_operation / (project_id,idempotency_key) | operation_type text、document_id/base_revision_id/new_revision_id uuid、request_sha256 char(64)、change_desc jsonb、client_id text、response_document jsonb、created_at | 同一projectのrequest identityと保存receipt。operation_typeは document.create/document.save/document.restore |
| DB-T005 | knowledge_node / (project_id,id) | type/name text、attributes jsonb、status text、version integer、deleted_at timestamptz nullable、created_at/updated_at | status proposed/confirmed/retired、曖昧名をID同一性と混同しない |
| DB-T006 | knowledge_alias / (project_id,id) | node_id uuid、surface/normalized text、scope text nullable、status text、created_at/updated_at | nodeは同一project、status proposed/confirmed/ambiguous/retired |
| DB-T007 | knowledge_relation / (project_id,id) | source_id/target_id uuid、type text、attributes/validity jsonb、status text、version integer、created_at/updated_at | 同一projectの両端FK、status proposed/confirmed/rejected/retired |
| DB-T008 | text_anchor / (project_id,id) | document_id/current_revision_id uuid、from_utf16/to_utf16 integer、quote_sha256 char(64)、status text、version integer、created_at/updated_at | revision位置とhashの結合。最終的なrange CHECKは0002を適用した値 |
| DB-T009 | anchor_history / (project_id,evidence_id,version) | document_id/revision_id uuid、from_utf16/to_utf16 integer、status text、recorded_at timestamptz | Evidenceの位置履歴と版・project拘束、0002でrange CHECK変更 |
| DB-T010 | mention_link / (project_id,evidence_id,node_id) | status/source text、confidence double precision nullable、extractor_version text nullable、created_at/updated_at | Anchorとnodeが同一project。confidenceは0〜1、status proposed/confirmed/ambiguous/rejected |
| DB-T011 | assertion / (project_id,id) | proposition jsonb、modality/perspective text、narrative_time jsonb、confidence double precision nullable、status text、version integer、created_at/updated_at | structured proposition、status proposed/confirmed/rejected/retired |
| DB-T012 | assertion_evidence / (project_id,assertion_id,evidence_id) | evidence_role text、created_at timestamptz | assertionとanchorが同一project、role supports/contradicts/quotes/context |
| DB-T013 | change_set / (project_id,id) | author_id/status text、operations/read_set/write_set jsonb、provenance jsonb、version integer、idempotency_key text、request_sha256 char(64)、created_at/approved_at/applied_at/rejected_at、approved_by/rejected_by、application_result jsonb | status proposed/approved/applied/rejectedと承認者/時刻/適用結果の一致。project+idempotency_keyはunique |
| DB-T014 | module_record / (project_id,module_id,key) | value jsonb、version integer、created_at/updated_at | module所有のauthor-approvedなobject値。0003追加。派生cacheと混同しない |
| DB-T015 | codexia_schema_migrations / version text | checksum char(64)、applied_at timestamptz | migrate.tsが生成する適用台帳。version主キーとSHAチェック |

**列型の表記:** 複合PKの各構成要素の型は原則uuid。全列挙の物理契約は上記3 migrationとmigration engineのCREATE TABLEによる。0002より前の text_anchor / anchor_history にある to_utf16 > from_utf16 を最終仕様だと誤読しない。**0002適用後は to_utf16 >= from_utf16**。from_utf16 >= 0 は維持される。列変更の互換性/既存データへの影響は別途受入が必要。

## 主な参照整合性・index・trigger

- Document: document.parent_id は同一(project_id,id)の親を参照。document.head_revision_id は同一(project_id,document_id)のrevisionを参照する遅延可能FK。document_revisionは同一documentの親revisionを参照。
- Edit operation: documentとbase/new revisionへ複合FK。idempotency_keyはproject単位に一意。
- Knowledge: alias.node_id、relation.source_id/target_id はprojectを含めてFK。Evidenceのdocument/revision、mentionのanchor/node、assertion_evidenceの双方にも同じproject IDが含まれる。
- ChangeSet: version/status/approved_by/applied_at/rejected_by/application_resultのCHECKが採用済み状態遷移に一致しなければならない。
- Immutable revision: 0001の reject_document_revision_mutation() と document_revision_immutable trigger は UPDATE/DELETEを拒否する。

| 参照/検索の目的 | 観測したindex |
| --- | --- |
| documentの親・表示順 | document_parent_order_idx |
| revisionの履歴 | document_revision_history_idx、edit_operation_document_idx |
| Knowledge名・alias・relation | knowledge_node_name_idx、knowledge_alias_same_node_idx、knowledge_alias_lookup_idx、knowledge_relation_source_type_target_idx、knowledge_relation_target_type_source_idx |
| Evidenceのrevision/位置・参照 | text_anchor_document_revision_position_idx、mention_link_node_evidence_idx |
| ChangeSetのstatus/時刻 | change_set_project_status_created_idx |

indexの存在、定義、重複、選択度、実クエリ計画は別々に検査する。表示名や説明だけでは性能要求を満たしたことにならない。既存migrationの定義を書き換えて整合させない。

## Migration・互換性・実行条件

- Migration fileは番号prefixを持つ昇順SQL。現行セットは 0001-initial.sql、0002-orphaned-evidence-ranges.sql、0003-project-workspace.sql。
- packages/persistence-postgres/src/migration-set.ts はSQLのSHA-256を算出し、filename/checksumをソートした組のfingerprintを生成する。欠落・改変・余分な適用履歴は不一致。
- packages/persistence-postgres/src/migrate.ts は codexia_schema_migrations に version/checksum/applied_atを記録し、advisory lockを使う。fresh inspectは未追跡オブジェクトを拒否する。
- 既存本番DBに対する通常起動はmigrationを暗黙適用しない。既定の更新と、承認済みschema更新を分離する。schema変更には停止・暗号化backup・隔離restore・fingerprint認証・適用・照合・復旧計画が必要。
- Better Authのcodexia_authは公式Better Auth migrationとCodexia revocation migrationが対象。packages/api/src/auth-schema.ts はcatalog fingerprintを照合する。packages/api/src/migrate-auth.ts の適用は明示 --apply と専用role/schema identityを必要とする。
- frontend/backendのAPI epochとpersistence formatは deploy/frontend-compatibility.json、deploy/update-compatibility.json と [Update flow](../deployment/UPDATE-FLOW.md) に従う。SQLの追加だけを互換宣言にしない。

## データ型・制約の詳細化と合否

| 検証IDの候補 | 対象 | 実際に証明すべきこと |
| --- | --- | --- |
| TEST-DB-001 | 新規DB + migrations | schema、全column type/default/nullability、PK/UK/FK/CHECK/index/triggerが設計に一致 |
| TEST-DB-002 | project分離 | 他projectのdocument、revision、node、anchor、change_setのFK・読取/書込拒否 |
| TEST-DB-003 | revision不変・receipt | UPDATE/DELETE拒否、保存は新Revision、冪等replayで重複書込みなし |
| TEST-DB-004 | Evidence範囲 | UTF-16範囲の境界、0002適用後の空range、revision不一致、古いanchor |
| TEST-DB-005 | ChangeSet状態 | 不正なapproval/applicationの組合せをDBが拒否、author確認がAPI側で強制 |
| TEST-DB-006 | schema identity | 未適用/改変/新しいDB/認証schema不一致で停止、正規の明示migrationのみ許可 |
| TEST-DB-007 | backup→restore | 隔離DBで同じ正本データ・schema fingerprint・owner境界を再現 |

検証候補の所在: packages/persistence-postgres/src/postgres-store.test.ts、migration-set.test.ts、schema-maintenance.test.ts、tests/e2e/persistence-database.acceptance.spec.ts、packages/api/src/auth-schema.tsに対応するBetter Auth tests。**これらのテストが上記すべてを証明済みかは未確認。** IDとテスト名・exact-source runを後続の [Traceability](../verification/TRACEABILITY-REGISTER.md) へ対応付ける。

## 変更・逸脱の扱いとツール検討の境界

- REQ-DATA-005 の物理定義、権限境界、移行方法の候補は [サーバー永続状態の PostgreSQL 移行案](POSTGRESQL-SERVER-STATE-PROPOSAL.md) を参照。承認後に本契約へ反映する。
- 新テーブル/列の採否は論理設計、物理定義、migration計画、既存データ互換、rollback/restore、必要なAPI・MCP・UI・テストを一体でレビューする。
- **採用済みの検証経路:** [PostgreSQL contract verification](POSTGRES-CONTRACT-VERIFICATION.md) に従い、使い捨て DB に正規 SQL を適用する。pgTAP と pg_catalog で物理 schema を照合し、tbls で可視化を生成する。対象コミットの検証結果は対応する CI 証拠で確認する。
- ERDとデータ辞書はこの規範契約とSQLを適用した実DBから生成・照合する派生物であり、新しい独立DB正本としない。
- Atlas等の差分/宣言型schemaツールは、既存のmigration ledger・fingerprint・停止時適用と矛盾しない方式が確定するまで導入しない。
- 実DBのpg_catalogとmigration後のDDLの全フィールド突合、認証schemaの全文物理項目の一覧・権限の実検証、CRUD→実DB traceの完全網羅は**未実施**。初期索引の整備だけで完了としない。
