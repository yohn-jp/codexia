# PostgreSQL物理契約を検証するためのツール・CI設計

**種別: 採用済み・物理契約検証を実装済み。** データの意味・正本・整合性は [Data model](DATA-MODEL.md)、SQLオブジェクト別の契約は [DB detail](DATABASE-DETAIL-CONTRACT.md)、schemaを更新してよい条件は [Update flow](../deployment/UPDATE-FLOW.md) / [Backup](../deployment/BACKUP.md) / [CI/CD](../verification/CI-CD.md) が所有する。SQL-first + pgTAP + `pg_catalog` + tblsを**仕様と実DBを照合する方式**として採用する。PostgreSQL正本がGit/ORMへ移るわけではない。

実装は `packages/persistence-postgres/tests/db-contract/` と `scripts/postgres-contract/` に置く。各実行は検証対象文書、API auth schema、migration、lockfile、runner、期待catalogのexact-source identityを記録し、migration fingerprintと実DB catalogを照合する。

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
- PostgreSQL/pgTAPバイナリとimage digestのpin、schemaとtest sourceのexact-source証明、run/job/attempt/artifact digestを受入の一部にする。DBV-007は使い捨てLinux runnerのローカルrootless Podmanを直接利用し、別のDocker内Podmanイメージ・特権コンテナ・イメージtar転送は要求しない。実際のPodman versionとrootless/local状態を証跡に残し、認定は既存runner identityとsource-bound入力を照合する。source DBは既存Dockerで生成し、復元先はPodmanの別コンテナ・volume・network noneを使う。PostgreSQLの固定digestと実イメージIDを照合し、他の資源に触れず、正規drillの正常/改変拒否・復元データ照合と資源cleanupを維持する。
- schema変更PRには必ず**新旧DDL差分、破壊的変更、データ移行とバックアップ計画、関連API/MCP/UI contract、テスト、restore結果**を含める。
- 新規版のPostgreSQLまたはpgTAPを採用する場合は、既定migration fingerprintを無言で置換しない。role/trigger/SQLの動作を再確認する。

## 完了基準と未検証

物理schemaの**全**table/column/index/PK/FK/CHECK/trigger/function/roleを正本へ結び付け、独立した実DBのtest evidenceを記録する。#655 は PostgreSQL 17 の使い捨てDBで既存migrationとBetter Auth schemaを適用し、92 pgTAP assertions、全物理catalog fixture、drift拒否、read-only tbls生成、および暗号化backupの隔離復元を実装する。tbls生成物は検証taskのreport directoryに保存し、migrationやrepositoryへ書き戻さない。

既存API/maintenanceテストもDBVの証拠として維持する。これらはpgTAPの代替ではなく、transaction、再送、メンテナンス承認、OCI起動時の挙動をそれぞれの責務で検証する。

| DBV | 物理契約の証拠 | 既存 transaction / deploy 証拠 |
| --- | --- | --- |
| DBV-001 | `tests/db-contract/application-contract.sql` のrevision UPDATE/DELETE拒否 | `src/postgres-store.test.ts`: `migrations are repeatable and document revisions stay immutable`、`UTF-16 edits, idempotency, revision restoration and stale-head conflicts` |
| DBV-004 | `tests/db-contract/application-contract.sql` の重複receipt key拒否 | `src/postgres-store.test.ts`: `concurrent exact retries replay one document creation and one edit`、`transaction failures roll back document, revision and idempotency rows` |
| DBV-005 | `tests/db-contract/run.mjs` のcatalog・ledger・auth-schema drift拒否 | `src/postgres-store.test.ts`: `fresh schema initialization is transactional, repeatable and rejects untracked or partial schemas`、`read-only schema verification rejects missing, altered and newer migration ledgers`、`src/schema-maintenance.test.ts`: certified prefix・retry・rollback。API auth driftは `packages/api/src/better-auth.persistence.test.ts` の `Better Auth PostgreSQL restart preserves JWKS signing key, session and refresh continuity` テスト内で未適用schema、型・column・index・constraint driftを検知する各 `verifyAuthSchema` assertionで検証する |
| DBV-007 | `tests/db-contract/run.mjs` はsynthetic owner・project・original manuscript/revisionを使い捨てsource DBへ作成し、暗号化age v2 artifactを作る。復元はcanonical `deploy/backup/backup.sh drill` を通し、別のnetwork-none PostgreSQLへ復元してledger、auth fingerprint、ownerと原稿/Revision identityを照合する。fixture構築は合成データの準備であり、drillの代替ではない。production backupやcredentialは使わない。 |
| DBV-008 | pgTAP/pg_catalog taskとは分け、既存の明示maintenance contractを参照 | `scripts/deployment/admission/contract.test.mjs`: `first activation verifies the initialized database after backup under both explicit approvals` はbackup後のone-shot verificationとrecurring startup migrationの不在を確認。`src/schema-maintenance.test.ts`: `certified additive migration applies only a forward prefix and retries the target` はcertified forward prefixとtransactional rollbackを確認する |

CIの実結果とsource/run identityはPR #688の `db-contract` task reportに結び付ける。ここに列挙した既存テストが全API routeのDB影響を網羅する意味ではなく、その横断的traceabilityは別途管理する。
