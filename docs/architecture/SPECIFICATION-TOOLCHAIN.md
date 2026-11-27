# 仕様駆動開発ツールチェーン採用設計

**種別: 採用済み技術方針・段階移行の規範的設計。** 要求・意味的な仕様の正本は [Documentation authority](DOCUMENTATION-AUTHORITY.md)、[Requirements](../requirements/README.md)、[System design](SYSTEM-DESIGN.md) などの領域正本が所有する。本書は**その仕様を型・コード・検証へ落とし込む方式と導入判定**を所有する。領域ごとの導入と適合は [受入契約](../verification/SPECIFICATION-TOOLING-ACCEPTANCE.md) が規定する。

## 目的と権威

最終目標は、**承認済みの全要求・正常/異常・拒否・保護・回復・性能等の独立した検証義務を、設計の所有先、HTTP/MCP/DB/UI/IaCの実装、テストシナリオ、exact-source実行証拠へ双方向追跡できること**。単なる要求リンク率、OpenAPI生成成功、CI greenだけでは達成としない。

1. **要求・意味的設計:** 承認済みMarkdown/構造化要求管理が仕様の決定を所有する。コードの既存動作を無断で正本へ昇格させない。
2. **実行可能な詳細契約:** HTTPはTypeSpec、DB物理定義は承認済みSQL migration、MCPは公式SDK tool input/output Schema、外部IaCは各管理ツールの宣言的設定。責務が異なる契約を一つの言語に強制しない。
3. **派生コード:** OpenAPI、Fastify route schema/validator、ブラウザ/iOSクライアント、ERD、文書サイトは生成物。派生生成物を手修正して正本との差を隠さない。
4. **検証:** ライブラリの型検査・lint・diff・schema検証は構文/静的整合の証拠。認可、競合、原子性、ユーザー操作、復旧などの意味的義務は実コンポーネントのテストで証明する。
5. **追跡:** 要求が持つrelation、コードファイル/範囲、検証ID、実行したCI run/artifactを標準ツールで関連付ける。独自traceability engineの新設はしない。

HTTP契約ではTypeSpec、変換スクリプト、設定、依存ロック、承認済みのルート一覧と互換性fixtureをGitで管理する。
各ビルドはこれらからOpenAPIとFastify用JSONを生成し、WebとiOSは同じOpenAPIから各クライアントを生成する。
生成したファイルはビルド作業領域と配布成果物に含め、Gitの追跡対象から外す。

## 技術選定（最終二択、なぜ他方でないか）

| 領域 | 選択する目標 | 二択の相手 | 具体的な選択理由・不採用理由 |
| --- | --- | --- | --- |
| 要求/追跡 | **StrictDoc** | Sphinx-Needs | 機能の中心が要求、source relation、trace matrix、coverage。Sphinx-NeedsはSphinx基盤とextension群を構成する必要がある。StrictDocのMarkdown機能はexperimentalである。TypeScript symbol解析とNode test ID discoveryはStrictDocの機能とみなさず、repository側のAST discoveryを独立gateで検証する |
| HTTP wire仕様 | **TypeSpec + OpenAPI 3.1.0 emitter** | OpenAPI YAML直接編集 | model/operationの一意の宣言と再利用、OpenAPI生成が可能。YAML手編集は型・共通DTO更新に重複を生みやすい |
| HTTP runtime | **Fastify（Node.js、継続採用）** | Hono | Schema/response serialization、plugin encapsulation、hook/close lifecycleとNodeのストリーム境界を維持。HonoのWeb標準APIとOrval Hono generatorは魅力だが、VM上のAPIで置換する合理性は不足。現行catch-allの廃止はFastify標準routeへ移行して実施 |
| server/client生成 | **Orval（client/Zod生成に限定）** | Hey API | TypeSpec由来OpenAPIからclient/Schema生成を行う。Orval Hono server generatorは採用しない。Fastifyのroute schemaはOpenAPI/JSON Schemaから生成・照合し、二重の手書きDTOを作らない |
| runtime Schema | **Zod v4（業務/MCP/client）＋ Fastify JSON Schema/Ajv（HTTP境界）** | TypeBoxをHTTPの別正本とする方式 | ZodとJSON Schemaは異なる責務。HTTPワイヤ契約はTypeSpec→OpenAPI/JSON Schemaに一方向生成し、Fastifyの標準validator/serializerで実行。Zodを独立編集可能なHTTP正本にしない |
| UI状態機械 | **XState v5（複雑な保存/復旧・ChangeSet・認証・backup UIに限定）** | React boolean/reducerによる独立した状態フラグの増殖 | 状態・event・guard/async actorと異常遷移を機械的に記述。単純なローカルUI stateはReactのまま。API/DB/Better Authの正本を置換しない |
| OpenAPI品質 | **Redocly CLI 2** | Spectral | lint、bundle、ルール/Markdownチェックを集約。実API適合は別ツールで証明 |
| OpenAPI互換 | **oasdiff** | OpenAPI Diff | breaking/change severity、format別出力とCIゲート。互換epochの設計判断は既存 deployment契約が所有 |
| API契約の実動作 | **Schemathesis** | Dredd | schemaに基づくpositive/negative・stateful探索。意味的なBOLA/作者承認/保存テストは別途維持 |
| PostgreSQL schema | **SQL migration + pgTAP/pg_catalog** | Drizzle Schema + Drizzle Kit | 複合FK、trigger、CHECK、厳格なfingerprintを直接管理・検証。ORM Schemaを導入するとSQL固有の正本分割になり得る |
| PostgreSQL query | **現行pgを維持** | Kysely | Query Builder追加だけでは本件の要求証明・物理schema適合の問題を解かない。型付きSQLの別要件が生じたら再評価 |
| DB可視化 | **tbls（実DB由来）** | 手書きDBML | 実DBのオブジェクトから文書/ERDを派生でき、ドキュメントと実DBの差を発見できる |
| MCP transport/sdk | **公式TypeScript SDK v2** | v1継続 | 2026-07-28 spec対応の現行安定ライン、Node/Web標準handler adapterとZod v4。v1でのsessionfulモデルとの違いを別gateにする |
| MCP protocol検証 | **公式Inspector / conformance** | 独自プロトコル検証器 | SDK公式の仕様適合と相互運用を利用。Codexia固有scope/author-onlyは統合テストで検証 |
| Auth仕様の抽出 | **Better Auth公式OpenAPI生成** | 手書きのライブラリAPI一覧 | ライブラリ管理endpointのinventory重複を避ける。公式pluginはearly stageであり、productionのreference endpointを新規公開しない |
| Architecture | **LikeC4** | Structurizr DSL | 静的出力/Node CLI/Web統合を重視。システム構成の意味はSYSTEM-DESIGNが決定し、既存Atlas/Mermaidの状態図と二重正本を作らない |
| 脅威モデリング | **Threagile** | OWASP Threat Dragon | Git管理のリスクモデル/CI用出力。ただしLikeC4との構成・通信重複を明示的に管理 |
| 性能検証 | **k6** | Artillery | thresholdで合否を定義し、CI統合可能。実運用p75や全SLOの証明とは別 |
| Docs表示 | **StrictDoc静的HTML + Scalar** | VitePress中心 | 要求・tracingを入口にする。既存GitHub Pagesの単一publisherと開発PortalのURL方針を維持し、新規公開経路を増やさない |
| CI証拠 | **既存GitHub Actionsのexact-source認証** | Allureを第二正本化 | 正しいartifact/run identityの既存ガバナンスがある。test reportの表示は派生物のみ |

**不採用:** ts-restは保守終了の公式案内があり、今回の新しい中核依存にしない。Atlas無償機能だけではtrigger/functionまで完全に検証できないためDBの正本・完全性ゲートには採用しない。Honoへの全面置換は行わない。Fastifyの現行catch-allは契約に基づく明示的なrouteへ改修し、既存のHTTP admission・権限・streamingを保持する。

## OpenAPIの採用バージョン

TypeSpec 1.18.0 で直接生成する形式を **OpenAPI 3.1.0** とする。
OpenAPIの安定版3.2.1と3.1系の3.1.2は、当該emitterの `openapi-versions` が受理する列挙値に含まれない。
3.2.0は生成でき、Redocly 2.82.0、oasdiff 1.39.0、Orval 8.49.0でCodexiaの操作を処理できる。
Swift OpenAPI Generator 1.14.4は3.2.1を拒否する。
3.2.0の予備対応では、TypeSpecがストリームに出力する `itemSchema` がSwiftのoperation応答型に反映されず、未型付けの `HTTPBody` になる。
採用中のFastify変換器も3.1.0を入力とする。

OpenAPIのpatch番号は明確化や訂正に使用され、同じminor系列の機能集合を共有する。
3.1系列の仕様本文は [OpenAPI 3.1.2](https://github.com/OAI/OpenAPI-Specification/releases/tag/3.1.2) を参照し、生成物のヘッダーにはemitterが出力した `3.1.0` を保持する。
3.2系への移行では、TypeSpecでの直接生成、Scalar、Redocly、oasdiff、Fastifyのスキーマ変換、Orval、Swiftの再生成と実行を同じ契約で検証する。
複数形式を併用する案には、変換で失われるスキーマ制約、HTTP操作、ストリーミング情報の検出と保守が必要になる。
各利用側が3.2系を受理し、既存契約と同等の検証を実行できる段階で採用形式を更新する。

比較時の正本は [OpenAPI 3.2.1](https://github.com/OAI/OpenAPI-Specification/releases/tag/3.2.1) と [TypeSpec emitter設定](https://typespec.io/docs/emitters/openapi3/reference/emitter/) を参照する。
実行ツールの固定版は [依存台帳](DEPENDENCY-INVENTORY.md) で管理する。

## 実装と移行の境界

| 現行コード/仕様の実情 | 変更後の目標 | 必須の変更と不変条件 |
| --- | --- | --- |
| TypeSpec から生成した OpenAPI と Fastify スキーマで通常 API と setup API を登録。SSE と外部プロトコルは明示的なアダプターを経由 | TypeSpec→OpenAPI→Fastifyの明示的route/JSON SchemaとOrval client | 全method/path、CSP/nonce、CORS/CSRF、body limit、HTTP 401/403/404/405/409、stream/drainを追跡して移管。動的module route等は明示的adapter |
| packages/api/src/persistence-routes.tsがbody/headersを手動検証しCore/DBへ委譲 | TypeSpec/OpenAPI由来のFastify JSON Schema/Ajvを入口に使用 | 既存のsemantic precondition、transaction/owner判定をvalidatorへ誤移管しない。Zodは業務/MCP/clientで維持 |
| `modules/mcp/src/http.ts` は Fastify の中央認可を経た Web Request を公式 SDK v2 の `createMcpHandler` へ渡す | 2026-07-28 の stateless HTTP。旧世代は [MCP 移行設計](MCP-V2-MIGRATION.md) の期限付き互換を適用 | 各リクエストの owner、project、scope の再検証と、CORS、切断、stream、retry を実証 |
| `modules/mcp/src/stdio.ts` は公式 SDK v2 の `serveStdio` と HTTP 共通のツール登録を使用 | 入出力スキーマは Zod v4 | Core の action と effect が共通であること、および標準出力の JSON-RPC、切断とプロトコル交渉を検証 |
| public schemaは3つのSQL migrationとchecksum ledger、認証schemaはBetter Auth専用 | SQLを物理詳細契約として維持しpgTAPで検証 | schema/checksum/trigger/roleと隔離restoreを維持。既存migrationを改変しない |
| 要件はMarkdown表30件と関連コードの候補パス | StrictDoc requirement relationとsource/TEST/evidence trace | 既存REQ-IDを保存し、一つの要求を二重編集可能な正本にしない |
| 既存Architecture AtlasはMermaidを抽出し単一のRepository Audit Pagesへ公開 | LikeC4の構成ビューとStrictDoc/Scalarを同一公開者に統合 | 状態遷移は元Markdownが正本。LikeC4のコンテキスト図とMermaidの状態図を別責務で維持 |

認証/principal（ANON、OWNER-SESSION、OWNER-API、MCP-CLIENT、SHARE-READER、SETUP、OPERATOR）やPostgreSQL単一正本、作者による承認、Core/Full、Tailscale管理経路、既存のexact-source CI基準は**変更しない**。

## 導入判定ステータス

- **ARCHITECTURE_SELECTED:** 上表は合意済み技術選定。各候補がCodexiaの全契約に合うことを証明した状態ではない。
- **INTEGRATION_UNVERIFIED:** 領域ごとの実装やツールが存在する場合でも、対象となる受入義務の実行証拠が揃うまでは未検証とする。
- **MIGRATION_ALLOWED:** 領域ごとの [採用ゲート](../verification/SPECIFICATION-TOOLING-ACCEPTANCE.md) を満たしたときに限り移行変更のPRを合格判定できる。
- **RETIRED:** 新旧二重ルーティングや旧MCP sessionを残すことを設計として採用しない。移行途中に必要な比較用実装は期間/削除条件を明示し、完了後に除去する。

技術選定を変更する必要が生じた場合は、主観的な好みではなく、**公式にサポートされないこと、合否が再現するテストの失敗、セキュリティ不変条件の破壊、代替に比べた説明可能なコスト**を示し、本書に代替案と決定理由を記録して改訂する。ユーザーの合意済み選択を実装担当者が独断で再選定しない。

## 詳細設計と資料

- [要求/StrictDoc移行](../requirements/STRICTDOC-TRACEABILITY.md)
- [TypeSpec/Fastify/Orval/API契約移行](HTTP-PLATFORM-MIGRATION.md)
- [DB契約検証](POSTGRES-CONTRACT-VERIFICATION.md)
- [XState v5状態機械](../design/XSTATE-STATE-MACHINE-CONTRACT.md)
- [バックアップ管理UI・S3制御境界](BACKUP-CONSOLE-CONTRACT.md)
- [全workstreamと依存・完了条件](SPECIFICATION-IMPLEMENTATION-CONTRACT.md)
- [MCP v2と認証境界](MCP-V2-MIGRATION.md)
- [CI・脅威・性能・Portalの受入](../verification/SPECIFICATION-TOOLING-ACCEPTANCE.md)

公式参照（2026-11-23照合）: [TypeSpec OpenAPI emitter](https://typespec.io/docs/emitters/openapi3/reference/emitter/)、[Orval config](https://orval.dev/docs/reference/configuration/output/)、[StrictDoc supported formats](https://strictdoc-project.github.io/formats/)、[MCP v2 SDK](https://ts.sdk.modelcontextprotocol.io/v2/)、[MCP v2 protocol era migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)、[Better Auth OpenAPI](https://better-auth.com/docs/plugins/open-api)、[Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)。最新releaseのpinは**導入時に個別検証**し、独立互換制約を説明できない古い固定を放置しない。
