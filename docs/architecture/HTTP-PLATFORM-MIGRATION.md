# TypeSpec / Fastify / Orval HTTP契約移行設計

**種別: 採用済み設計。** HTTPワイヤ契約は [API contract](API-CONTRACT.md)、principal・method・resource・effect認可は [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md)、OAuthは [API AuthN/AuthZ](API-AUTHN-AUTHZ.md) が所有する。[Toolchain](SPECIFICATION-TOOLCHAIN.md) に基づき、**TypeSpec → OpenAPI 3.1 → Fastify JSON Schema/Ajvと生成クライアント**へ一方向に接続する。Honoへのランタイム移行は採用しない。

TypeSpecからの生成、スキーマ変換と検査は `packages/http-contract` が所有する。
本番 API と setup 専用 API は TypeSpec から生成した Fastify スキーマを使用する。
`packages/http-contract/scripts/generate-fastify.mjs` は OpenAPI から `packages/api/src/generated/http-contract.json` を生成する。
`check-generated` は OpenAPI と Fastify 用スキーマの両方の再生成差分を検査する。
各 route は operation ID で処理へ接続し、CORS preflight は登録済みの API/MCP パスと method に限定する。

## 二択の結論

| 対象 | 採用 | 不採用と理由 |
| --- | --- | --- |
| HTTP runtime | **Fastify v5系（導入時に最新安定を確認）** | Hono: Web標準とOrval Hono server generatorは利点だが、VM上のNode専用APIではFastifyのAjv validation、response serializer、encapsulated plugins、onClose等の既存機能を置き換える利益が限定的。全面移行は不要 |
| Wire契約 | **TypeSpec + OpenAPI 3.1.0** | OpenAPI YAMLの独立手書き: DTO/operationを重複管理する |
| HTTP検証 | **Fastify JSON Schema/Ajv + response serializer** | ZodをHTTP wireの第二の手書き正本にする方式: schemaの二重定義が発生する |
| 生成client | **Web TypeScript: Orval / iOS SwiftUI: 同一OpenAPIからSwift生成client** | OrvalをSwift generatorとみなさず、iOS wire DTOの第二手書き正本を作らない。詳細は[iOS Native設計](IOS-SWIFTUI-ARCHITECTURE.md) |
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
         JSON Schema          Generated clients
            |                        |
     Fastify explicit routes     Web TS / iOS Swift
     Ajv input validation
     response serialization
            |
     central admission + existing Core/DB
```

- TypeSpecが所有: method/path、operationId、request/response DTO、status/error、headers、content type、OAuth security schemeの**ワイヤ表現**。
- `packages/http-contract/src/fastify-schema.mjs` は、OpenAPI 3.1のJSON SchemaをFastify v5のDraft-07ルートスキーマへ変換する。
  コンポーネント参照をFastifyに登録できるIDに変換し、合成を伴わない閉じたobjectの制約を引き継ぐ。
  nullable、`oneOf`、`additionalProperties`、format、入力のcoercionとdefault、status別の応答を検査する。
  意味を保持できない制約は変換エラーにする。
- `@codexia/contracts` はCoreの業務契約、TypeSpecはHTTP wire契約。重なるDTOは生成またはadapterで接続し、同じwire DTOを二つの独立編集可能な正本にしない。
- Desktop WebのOrvalとiOSのSwift OpenAPI Generatorは、同じ生成OpenAPIを入力とする。
  Desktop Webが使用するCodexia所有の操作は、Orvalが生成するfetch関数を通す。
  [Desktop生成設定](../../app/orval.config.mjs) は利用対象を選び、再生成時にoperation ID、method、pathと成果物を照合する。
  未実装の目標操作は生成対象外とする。Swiftは全operation IDを比較する。
  承認済みの公開スキーマと実応答の差が記録されている操作では、TypeSpecの `x-codexia-desktop-response-schema` がDesktop Webで検証する実応答のスキーマを参照する。
  oasdiffは公開OpenAPIのスキーマを引き続き比較する。
  現行Swift生成のnullable正規化は同じ3.1方言内で型とnullの和を表し、扱えない形では失敗する。
  iOSでのOAuth、headers、Idempotency-Key、abort/retry、status別応答、streamingの受入は [iOS SwiftUI正本](IOS-SWIFTUI-ARCHITECTURE.md) に従う。
- Desktop Webのfetch境界で、OWNER-APIのbearer、Consoleの同一origin cookie、初期セットアップの資格情報ポリシーを適用する。
  JSON成功応答は生成Zod schemaで検証し、追加フィールドを保持する。Job EventStreamは生成関数から未消費のレスポンスを受け取り、既存のストリーム処理へ渡す。
  呼び出し側が中断と再送を制御する。保存の再送では最初と同じ冪等性キーを使用する。
  OAuth同意の照会と確定は、署名済み `oauth_query` を引き継ぐBetter AuthのOAuth Providerクライアントを使用する。
- Fastifyが所有: request lifecycle、content parser、Ajv validation、response serializer、route registration、error handling、streaming/abort、graceful shutdown。schema validationが成功しても認可成功とはみなさない。
- 既存Core/DBが所有: project/object/revision/effect、author-only approve/apply、idempotency、transaction、receipt。これをHTTP schema/validatorへ移管しない。

## 明示的ルーティングと権限

| 入口 | Fastifyでの扱い | 権限 |
| --- | --- | --- |
| `/api/health`、`/health/*` | 公開するmethod/pathを明示登録 | 最小healthのみ |
| `/api/*` の作品・job・persistence | method/pathごとのschema付きroute | OWNER-API、必要なMCP effectを区別。persistenceはOWNER-API専用 |
| `/api/auth/*` | Better Auth公式Web Request handlerをFastify adapterから呼ぶ。auth固有のbody/cookie/streamingを壊さない | OWNER-SESSION、OAuthの登録client、PKCE/CSRF |
| `/mcp` とmodule MCP HTTP | 既存の SDK v1 Web adapter を明示ルートへ接続する。SDK v2 は [MCP 移行設計](MCP-V2-MIGRATION.md) に従って切り替える | MCP-CLIENTのresource/audience、scope、project、effectを毎request確認 |
| `/api/public/projects/*` | share reader専用route | share capability以外のprivate情報を返さない |
| module HTTP contribution | manifestから明示method/pathを登録するhost-owned adapter | module access/effectとcentral admission。未知routeはfail closed |
| setup API | [初期導入設計](../deployment/INITIAL-DEPLOYMENT-FLOW.md) に従うsetup専用Fastifyのroute | SETUPに限定した操作と公開可否応答を区別する。稼働環境での登録受入は別途確認する |

**中央認可の順序:** path/methodの正規化 → Origin/Host/CORS/CSRF → credential検証とprincipal分類 → project assignment → object/revision/effect → transaction precondition。Plugin encapsulationでルートのscopeを隔離するが、Fastifyのpluginに登録しただけで権限が保証されたとみなさない。親hookと子pluginの順序、onRequest/preValidation/preHandler、raw response経路を**全routeで検証**する。

現行のcatch-allを**明示的route定義へ置換**し、同一path/methodに旧・新dispatcherを恒久併存させない。未知method/pathは適切な404/405で拒否する。旧手動body validatorはwire型検証の重複を解消するが、意味的preconditionやresource authorizationは削除しない。

## 特殊な境界とセキュリティ

1. **Raw responseとSSE:** Fastify `reply.raw` / `reply.hijack` 等の処理では標準serializer/hooksを迂回し得る。SSE、Better Auth、MCP adapter、module streamingに対して、CSP/CORS/Origin、status/header、close/abort、buffer/backpressure、5秒drainの**独立した受入テスト**を要求する。
2. **MCP RPC:** 単一JSON-RPC URLの外側でmethod/pathだけを検証してもtool/effectの権限は保証されない。SDK schemaとresource server認証、toolごとのscope/project/object/versionとサイズ/実行時間を検証し、MCPによるauthor-only approve/applyを禁止する。
3. **Host/Origin:** 公式MCP handler任せにせず、Fastify outer ingressでDNS rebinding対策、trusted proxy/Host/Originの整合、URL encodingを検査する。
4. **Schema serializer:** Fastifyのresponse schemaが未定義のrouteやraw応答で、出力が暗黙に検証されると主張しない。意図した2xx/4xx/5xx statusごとにresponse schemaまたは明示的な検証根拠を持つ。
5. **認可の失敗:** 401/403/404/405/409/413/415/503の適用条件、機械可読code、存在漏えい禁止、method偽装、preflightとContent-Typeの違いをテストする。

## 実装で維持する応答境界

Better Auth の公式ルートと OAuth/OIDC discovery はプロトコル実装が返す status、header、cookie、body stream を引き継ぐ。
MCP とモジュールの応答は runtime のアクセス制御を通過した Web Response を転送する。
公開 reader の 404 は OpenAPI の `x-codexia-runtime-response-deviation` に記載された既存の応答を維持する。
SSE は Fastify の入場処理後に raw stream を開始し、切断とサーバー終了でクローズする。

ジョブ一覧、モジュール一覧、contribution 一覧、履歴、OAuth 同意一覧は既存の top-level array を返す。
現行 API epoch の OpenAPI baseline に記録されたオブジェクトとの応答差分が解消されるまで、これらの 200 応答は Fastify の通常の JSON 出力を使用する。
バージョン確認の 2 経路も通常の JSON 出力を使用し、OCI が検査する数値の `contractVersion` を維持する。
setup 専用 readiness の応答差分も TypeSpec に記録する。
静的 Web ファイルの配信は Fastify の未一致ハンドラーで GET/HEAD に限定する。

## 導入と受入

- **A: インベントリ** — Fastify catch-all、persistence dispatch、Better Auth、MCP、module contributions、share reader、health、SSEの全method/pathとschema/認可を列挙。
- **B: 契約生成** — TypeSpec→OpenAPI 3.1→Redocly/oasdiff、OpenAPI→Fastify schema/route定義とOrval Web clientを生成・照合。iOS Swift生成の受入は[iOS SwiftUI正本](IOS-SWIFTUI-ARCHITECTURE.md)に分離する。変換後のSchemaで正常/異常/境界を試し、変換で情報を失ったらfail。
- **C: 明示ルート** — Fastify上でrouteを段階移管し、中央admission、Ajv、response serializer、エラーとstreamingを検証。業務handlerをgenerator-owned directoryへ置かない。
- **D: 特殊経路** — Better Auth、MCP SDK v2、module HTTP、SSE、public reader、graceful shutdownを検証。旧catch-all/二重validator/不要compatibilityを除去。
- **E: 実動作認定** — 実DB/API/MCP/正式対応Chromium/OCIの受入を維持し、旧Mobile・公開面のWebKit例外は [E2E execution](../verification/E2E-EXECUTION.md) に従い、contract testとexact-source CI証拠を結合する。

**Fastify vs Honoの実装ベンチマークは選定条件としない。** Fastifyを維持した状態での性能回帰（p50/p95/p99、RSS、SSE、起動・drain）は別途確認する。仕様からの生成、認可、stream、response serializer、DB semanticsが成立しない場合は未完了と判定する。

バージョン選定の根拠は [仕様ツールチェーン](SPECIFICATION-TOOLCHAIN.md) が所有する。
TypeSpec、Redocly、Orval、Fastifyと間接依存のAjvは `pnpm-lock.yaml` で固定する。
Swiftは `ios/CodexiaTransport/Package.resolved` を使用し、oasdiffは取得する公式バイナリのバージョンとSHA-256を検査する。
