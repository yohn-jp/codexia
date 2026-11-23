# TypeSpec / Fastify / Orval HTTP契約移行設計

**種別: 採用済み設計。Fastifyは継続採用、Schema-firstへの改修は未実装。** HTTPワイヤ契約は [API contract](API-CONTRACT.md)、principal・method・resource・effect認可は [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md)、OAuthは [API AuthN/AuthZ](API-AUTHN-AUTHZ.md) が所有する。[Toolchain](SPECIFICATION-TOOLCHAIN.md) に基づき、**TypeSpec → OpenAPI 3.1 → Fastify JSON Schema/Ajvと生成クライアント**へ一方向に接続する。Honoへのランタイム移行は採用しない。

観測ベースライン: main@e02933aead466b14cbcd336905b9c2a2a2b39f06。現在の `packages/api/src/server.ts` はFastifyを使用する一方、Node `IncomingMessage/ServerResponse`、共通catch-allと手動method/path分岐、CSP nonce、CORS、body parsing、SSE、Abort、shutdownを持つ。`packages/api/src/persistence-routes.ts` は手動検証とdispatchを持つ。**現在のFastify利用と目標Schema-first Fastifyの達成を混同しない。**

## 二択の結論

| 対象 | 採用 | 不採用と理由 |
| --- | --- | --- |
| HTTP runtime | **Fastify v5系（導入時に最新安定を確認）** | Hono: Web標準とOrval Hono server generatorは利点だが、VM上のNode専用APIではFastifyのAjv validation、response serializer、encapsulated plugins、onClose等の既存機能を置き換える利益が限定的。全面移行は不要 |
| Wire契約 | **TypeSpec + OpenAPI 3.1** | OpenAPI YAMLの独立手書き: DTO/operationを重複管理する |
| HTTP検証 | **Fastify JSON Schema/Ajv + response serializer** | ZodをHTTP wireの第二の手書き正本にする方式: schemaの二重定義が発生する |
| 生成client | **Orval（fetch client等）** | Hey API: 既存選定を維持。ただしOrvalのHono server generatorは使用しない |
| 業務/MCP schema | **Zod v4** | TypeBoxを別のHTTP schema正本として導入する方式: 生成されたJSON Schemaと二重化する |

**公式参照:** [Fastify validation/serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[Fastify plugins/encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/)、[Fastify lifecycle](https://fastify.dev/docs/latest/Reference/Lifecycle/)、[TypeSpec OpenAPI emitter](https://typespec.io/docs/emitters/openapi3/reference/emitter/)、[Orval output configuration](https://orval.dev/docs/reference/configuration/output/)。

## 正本と生成物の境界

```text
採用済み要求 / API-CONTRACT / ROUTE-AUTHORIZATION-CONTRACT
                         |
                  TypeSpec wire contract
                         |
              OpenAPI 3.1（生成・lint）
                  /              \
         JSON Schema          Orval typed client
            |                        |
     Fastify explicit routes     Web / iOS
     Ajv input validation
     response serialization
            |
     central admission + existing Core/DB
```

- TypeSpecが所有: method/path、operationId、request/response DTO、status/error、headers、content type、OAuth security schemeの**ワイヤ表現**。
- TypeSpecの出力をFastifyのroute `schema` に適合させるための**一方向の変換**を導入する。OpenAPI 3.1 SchemaとFastify/Ajvが受け付けるJSON Schema方言の差（nullable、oneOf/anyOf、discriminator、additionalProperties、formats、coercion、default、response status別schema）を明示して検査する。**OpenAPIのcomponentsをFastifyへそのまま渡せるとは仮定しない。**
- `@codexia/contracts` はCoreの業務契約、TypeSpecはHTTP wire契約。重なるDTOは生成またはadapterで接続し、同じwire DTOを二つの独立編集可能な正本にしない。
- Orvalはクライアント生成専用。生成clientのrequest headers、OAuth token、Idempotency-Key、abort/retry、error handlingは既存のWeb/iOS受入で検証する。
- Fastifyが所有: request lifecycle、content parser、Ajv validation、response serializer、route registration、error handling、streaming/abort、graceful shutdown。schema validationが成功しても認可成功とはみなさない。
- 既存Core/DBが所有: project/object/revision/effect、author-only approve/apply、idempotency、transaction、receipt。これをHTTP schema/validatorへ移管しない。

## 明示的ルーティングと権限

| 入口 | Fastifyでの扱い | 権限 |
| --- | --- | --- |
| `/api/health`、`/health/*` | 公開するmethod/pathを明示登録 | 最小healthのみ |
| `/api/*` の作品・job・persistence | method/pathごとのschema付きroute | OWNER-API、必要なMCP effectを区別。persistenceはOWNER-API専用 |
| `/api/auth/*` | Better Auth公式Web Request handlerをFastify adapterから呼ぶ。auth固有のbody/cookie/streamingを壊さない | OWNER-SESSION、OAuthの登録client、PKCE/CSRF |
| `/mcp` とmodule MCP HTTP | MCP SDK v2公式Web handlerをFastify adapterで呼ぶ | MCP-CLIENTのresource/audience、scope、project、effectを毎request確認 |
| `/api/public/projects/*` | share reader専用route | share capability以外のprivate情報を返さない |
| module HTTP contribution | manifestから明示method/pathを登録するhost-owned adapter | module access/effectとcentral admission。未知routeはfail closed |
| 将来のsetup API | [初期導入設計](../deployment/INITIAL-DEPLOYMENT-FLOW.md) に従い別routeで登録 | SETUP限定。現時点では未実装 |

**中央認可の順序:** path/methodの正規化 → Origin/Host/CORS/CSRF → credential検証とprincipal分類 → project assignment → object/revision/effect → transaction precondition。Plugin encapsulationでルートのscopeを隔離するが、Fastifyのpluginに登録しただけで権限が保証されたとみなさない。親hookと子pluginの順序、onRequest/preValidation/preHandler、raw response経路を**全routeで検証**する。

現行のcatch-allを**明示的route定義へ置換**し、同一path/methodに旧・新dispatcherを恒久併存させない。未知method/pathは適切な404/405で拒否する。旧手動body validatorはwire型検証の重複を解消するが、意味的preconditionやresource authorizationは削除しない。

## 特殊な境界とセキュリティ

1. **Raw responseとSSE:** Fastify `reply.raw` / `reply.hijack` 等の処理では標準serializer/hooksを迂回し得る。SSE、Better Auth、MCP adapter、module streamingに対して、CSP/CORS/Origin、status/header、close/abort、buffer/backpressure、5秒drainの**独立した受入テスト**を要求する。
2. **MCP RPC:** 単一JSON-RPC URLの外側でmethod/pathだけを検証してもtool/effectの権限は保証されない。SDK schemaとresource server認証、toolごとのscope/project/object/versionとサイズ/実行時間を検証し、MCPによるauthor-only approve/applyを禁止する。
3. **Host/Origin:** 公式MCP handler任せにせず、Fastify outer ingressでDNS rebinding対策、trusted proxy/Host/Originの整合、URL encodingを検査する。
4. **Schema serializer:** Fastifyのresponse schemaが未定義のrouteやraw応答で、出力が暗黙に検証されると主張しない。意図した2xx/4xx/5xx statusごとにresponse schemaまたは明示的な検証根拠を持つ。
5. **認可の失敗:** 401/403/404/405/409/413/415/503の適用条件、機械可読code、存在漏えい禁止、method偽装、preflightとContent-Typeの違いをテストする。

## 導入と受入

- **A: インベントリ** — Fastify catch-all、persistence dispatch、Better Auth、MCP、module contributions、share reader、health、SSEの全method/pathとschema/認可を列挙。
- **B: 契約生成** — TypeSpec→OpenAPI 3.1→Redocly/oasdiff、OpenAPI→Fastify schema/route定義とOrval clientを生成・照合。変換後のSchemaで正常/異常/境界を試し、変換で情報を失ったらfail。
- **C: 明示ルート** — Fastify上でrouteを段階移管し、中央admission、Ajv、response serializer、エラーとstreamingを検証。業務handlerをgenerator-owned directoryへ置かない。
- **D: 特殊経路** — Better Auth、MCP SDK v2、module HTTP、SSE、public reader、graceful shutdownを検証。旧catch-all/二重validator/不要compatibilityを除去。
- **E: 実動作認定** — 実DB/API/MCP/Chromium/WebKit/OCIの既存受入を維持し、contract testとexact-source CI証拠を結合する。

**Fastify vs Honoの実装ベンチマークは選定条件としない。** Fastifyを維持した状態での性能回帰（p50/p95/p99、RSS、SSE、起動・drain）は別途確認する。仕様からの生成、認可、stream、response serializer、DB semanticsが成立しない場合は未完了と判定する。

依存は導入PRで最新安定版とpeer compatibilityを確認し、TypeSpec compiler/emitter、OpenAPI変換器、Orval、Fastify、Ajvのversionをlockfileと変更理由に記録する。**本PRでは依存・ルート・実行テストは変更しない。**
