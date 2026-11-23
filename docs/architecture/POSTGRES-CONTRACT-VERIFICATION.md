# PostgreSQL物理契約を検証するためのツール・CI設計

**種別: 採用済み目標・実装未変更。** データの意味・正本・整合性は [Data model](DATA-MODEL.md)、SQLオブジェクト別の契約は [DB detail](DATABASE-DETAIL-CONTRACT.md)、schemaを更新してよい条件は [Update flow](../deployment/UPDATE-FLOW.md) / [Backup](../deployment/BACKUP.md) / [CI/CD](../verification/CI-CD.md) が所有する。SQL-first + pgTAP + `pg_catalog` + tblsを**仕様と実DBを照合する方式**として採用する。PostgreSQL正本がGit/ORMへ移るわけではない。

観測ソース: main@e02933aead466b14cbcd336905b9c2a2a2b39f06、packages/persistence-postgres/migrations/0001-initial.sql、0002-orphaned-evidence-ranges.sql、0003-project-workspace.sql、src/migrate.ts、src/migration-set.ts、packages/api/src/auth-schema.ts、migrate-auth.ts。

## 二択の理由

- **採用:** 原生のSQL migrationとpgTAP / pg_catalog検査。現行のrevision不変trigger、複合FK、CHECK、index、migration ledger/fingerprint、認証の別schemaを最も忠実に表現できる。
- **不採用:** Drizzle Schema/Drizzle Kitを物理schemaの正本にする方式。TypeScriptで型安全な構築は有用だが、PostgreSQL固有DDLとBetter Auth schemaの完全再現で別の手書きSQLが残るなら正本が二重化する。
- **クエリ層:** 現行 `pg` を採用、Kyselyは現段階では不採用。Query Builderは運用上のSQL契約とmigration identityを直接検証しない。
- **可視化:** tblsで隔離した実DBからデータ辞書/ERDを生成。手書きDBMLは導入しない。
- **Atlas:** 外部の比較検証器として将来評価の余地はあるが、無償版だけでfunction/triggerまで完全に検証できるとは仮定しない。現行fingerprintと承認済みmigrationをAtlasの自動変更へ置換しない。

公式: [pgTAP](https://pgtap.org/)、[tbls](https://github.com/k1LoW/tbls)、[Atlas features](https://atlasgo.io/features)、[PostgreSQL catalog](https://www.postgresql.org/docs/current/catalogs.html)。

## ownership

| 対象 | 正本/変更責務 | 照合方式 |
| --- | --- | --- |
| データ不変条件と採否 | DATA-MODEL.md、CORE.md、DATABASE-DETAIL-CONTRACT.md | 要求/受入シナリオを明文化 |
| 正式なアプリDDL | packages/persistence-postgres/migrations/*.sql | 隔離DBに既定順序で適用しschema catalogを取得 |
| ledger identity | migration-set.ts、migrate.ts、codexia_schema_migrations | ファイルSHA-256、filename集合・fingerprintの完全一致 |
| 認証DDL | Better Auth公式migration + Codexiaのrevocation追加、独立したcodexia_auth schema | 専用role/schema、catalog fingerprint、公式バージョン間の変更の明示承認 |
| 作成済みDBの観測 | PostgreSQL pg_catalog | table/column/PK/FK/CHECK/index/trigger/function/grantsを実DBから読取 |
| DB受入テスト | pgTAP + SQL/Nodeの統合テスト | スキーマ構造、拒否、実transaction、異常系、復旧 |
| ERD/辞書 | tblsで生成 | migrationを適用した**使い捨てDB**の観測の派生物。手編集しない |

SQL migrationを「設計書より上位」にしない。SQLは**承認済み物理詳細を実行可能な形にする契約**であり、論理データ設計と矛盾したら `DEVIATION` とする。コードを逆に追認して設計を改変しない。

## 現行の物理不変条件

1. `project` は作品の境界。document/revision/knowledge/evidence/assertion/change_setはほぼすべて `project_id` を複合キー/FK/lookupに含み、他作品への関連付けを拒否する。
2. `document_revision` に `document_revision_immutable` trigger（function `reject_document_revision_mutation()`）があり、UPDATE/DELETEを拒否。本文保存や復元は新revisionとreceiptを作る。
3. `edit_operation` は (project_id,idempotency_key) を主キーとして操作の再送を追跡。response_documentとrequest hashを維持する。
4. `text_anchor`、`anchor_history` のrangeは0002適用後 `to_utf16 >= from_utf16`。0001の古い `>` を現在の最終schemaとして扱わない。
5. `change_set` はproposed/approved/applied/rejectedのstatusと、approved_by、applied_at、application_result等の整合をCHECKで保証。
6. `module_record` は0003追加。module IDとkeyをproject単位で管理。認証表と混在させない。
7. `codexia_schema_migrations` はversion/checksum/applied_at。更新済みSQLの改変や余分/不足したmigrationをrejectする。
8. Better Auth用 `codexia_auth` は `CODEXIA_AUTH_RUNTIME_ROLE` の管理下にあり、owner credentialと原稿tableのrole/scopeを分ける。

これらは**構造契約**であり、APIにおけるowner権限、snapshotの固定、保存のTOCTOU防止は実DB/サービス統合テストで別途証明する。

## 推奨検証層

### V-DB-01 — 純粋schema検証

毎回新規の合成PostgreSQL 17 DBを作成し、承認済みmigrationを1→2→3の順に適用する。

- `pg_catalog` からrelation/column type/default/nullability、PK/UK/FK/CHECK、index definition、trigger/function、schema/role/grantを抽出して、設計上の期待値と照合する。
- **pgTAP** は実際に適用したDBのオブジェクト構造を試験する。pgTAP extensionを**使い捨て検証DBにだけ**導入可能な環境で起動し、本番migrationへ `CREATE EXTENSION pgtap` を混入させない。
- pgTAPで直接表現できないtransaction/permission/recoveryは既存NodeテストやSQLのnegativeケースを維持する。「pgTAPが成功したから全APIに異常がない」としない。
- アプリだけでなくauth schemaも、Better Authの承認済みバージョンと対応する公式migrationで再現して照合する。
- ledgerのfingerprintをpackaged migrationと同じ方法で計算し、適用したSQL・チェックサム・実schemaを結合して認定する。

### V-DB-02 — 物理異常系

| ID | 検証対象 | 必須の反例・観測 |
| --- | --- | --- |
| DBV-001 | document_revision | SQL UPDATE/DELETEが拒否され、通常のsave/restoreは新revision |
| DBV-002 | FK/project boundary | 他projectのparent、revision、node、assertion/evidence、ChangeSetを渡すと拒否 |
| DBV-003 | nullable/default/check | 無効なtype/status/length/confidence/rangeに対するDB制約違反 |
| DBV-004 | edit_operation | idempotency_key再使用と異なるpayload、同じ保存のreplay、競合、receiptが正しい |
| DBV-005 | schema migration | 欠落/改変/新しいschema、余分なledger entry、部分適用、認証schema mismatchで停止 |
| DBV-006 | roles/grants | 認証ロールとアプリロールが異なり、権限昇格・意図しないschema accessが拒否 |
| DBV-007 | backup/restore | encrypted backupをisolated targetへ復元し、schema fingerprint、原稿/Revision/ownerの同一性と可用性を確認 |
| DBV-008 | migration update | 正規の明示メンテナンスだけが差分DDLを許す。OCI起動や互換イメージ更新が暗黙migrationしない |

各TEST-IDを [Traceability](../verification/TRACEABILITY-REGISTER.md) に関連付け、アプリ単体/実DB/デプロイのどの層が証明するかを明確にする。

### V-DB-03 — 実DBからのデータ辞書

- tblsは合成データで隔離再構築したPostgreSQLへ**read-only**で接続し、Markdownのtable/column/PK/FK/constraintとERD、元DDLの同一性に必要なmetadataを生成する。
- 生成物にsource SHA、migration fingerprint、auth schema version、generator version、DB versionを付与する。生成された辞書を手編集しない。
- tblsがtrigger/function、複合CHECK等を完全に可視化しない場合は、pg_catalog/pgTAPのcoverageを保つ。ERDの見た目だけでschema coverageとしない。
- 実DB接続情報・実原稿・credentialを公開Pagesへ含めない。

## 更新とCI統合

- CIへの新しい検証は [CI/CD](../verification/CI-CD.md) の既存verification task inventory/impact selectionを通して追加する。新しい独立したfull-workflowを乱立させない。
- schema単独の軽い構造検証、実DB操作の中間層、隔離復元の高コストな受入を分ける。未実行の層をgreenと報告しない。
- PostgreSQL/pgTAPバイナリとimage digestのpin、schemaとtest sourceのexact-source証明、run/job/attempt/artifact digestを受入の一部にする。
- schema変更PRには必ず**新旧DDL差分、破壊的変更、データ移行とバックアップ計画、関連API/MCP/UI contract、テスト、restore結果**を含める。
- 新規版のPostgreSQLまたはpgTAPを採用する場合は、既定migration fingerprintを無言で置換しない。role/trigger/SQLの動作を再確認する。

## 完了基準と未検証

物理schemaの**全**table/column/index/PK/FK/CHECK/trigger/function/roleと、各API操作のDB影響を正本へ結び付け、独立した実DBのtest evidenceを記録した時に限り完了とする。

本書は選定を決めたが、pgTAPのインストール、tbls生成結果、実pg_catalog差分、現行CIへの所要時間、復元test、PostgreSQL 17での実挙動は**このPRでは未実行**。
