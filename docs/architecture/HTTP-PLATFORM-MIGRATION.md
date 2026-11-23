# TypeSpec / Hono / Orval HTTP基盤移行設計

**種別: 採用済み目標・実装未変更。** HTTPワイヤ契約の正本と完全性は [API contract](API-CONTRACT.md)、principal/HTTP methodとBOLAの意味的認可は [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md)、本人認証とOAuthは [API AuthN/AuthZ](API-AUTHN-AUTHZ.md) が引き続き所有する。[Toolchain](SPECIFICATION-TOOLCHAIN.md) に基づき、**TypeSpec → OpenAPI 3.1.0 → Orval → Hono/Zod/型付きclient** の経路を採用する。ツールchainが生成できることと、Coreの機能を維持できることは別の受入条件。

**実装観測:** main@e02933aead466b14cbcd336905b9c2a2a2b39f06。packages/api/src/server.tsはFastify instance上でcatch-all route `/` と `/*` に手書きdispatcherを登録。IncomingMessage/ServerResponse、onRequest/onClose、CSP nonce、Origin/CORS、JSON parser、SSE、Abort、module Response変換を保持。packages/api/src/persistence-routes.tsは独自method/path分岐、headers/body checks、error shapeを保持。既存Core/DB/Better Authと全moduleのActionは維持する。

## 二択、採用/不採用理由

| 仕様対象 | 採用 | 対抗候補・不採用理由 |
| --- | --- | --- |
| HTTP契約 | TypeSpec（emitterでOpenAPI 3.1.0を明示） | OpenAPI 3.1 YAML直接編集: 共通modelの再利用/変更追随を冗長にする。最終ワイヤ成果物は同じOpenAPI |
| HTTP実行 | Hono（Nodeランタイム） | Fastify: 既存機能と性能面の利点はあるが、Orval標準Hono generatorとBetter Auth/MCP SDK v2のWeb標準Request境界を優先。移行時の性能/安全性が劣れば同意済み設計を再評価 |
| コード生成 | Orval | Hey API: クライアント生成だけでなくHonoサーバールートとvalidator生成を同じOpenAPIから扱う |
| Schema runtime | Zod v4 | TypeBox: Hono + Orval + MCP v2ではZodが共通依存となる。JSON Schemaからの一方向変換とする |

公式参照: [TypeSpec OpenAPI emitter](https://typespec.io/docs/emitters/openapi3/reference/emitter/)、[TypeSpec @operationId](https://github.com/microsoft/typespec/blob/main/packages/openapi/README.md)、[Orval hono generator/smart](https://orval.dev/docs/reference/configuration/output/)、[Better Auth Hono integration](https://www.better-auth.com/docs/integrations/hono)、[Hono releases/security](https://github.com/honojs/hono/releases)。

## 正本・生成物の所有先

```text
Requirements / API-CONTRACT / ROUTE-AUTHORIZATION-CONTRACT
                  |
      TypeSpec (HTTP wire contract)
                  |
   @typespec/openapi3 (3.1.0 explicit)
                  |
      OpenAPI artifact (generated)
           |                 |
     Orval Hono          Orval fetch/Zod
     route+validator     typed client
           |                 |
    Hono middleware       Desktop/Mobile/iOS
    → existing Core
    → existing PostgreSQL
```

- TypeSpecが所有: method/path、operationId、request/response HTTP status、content-type、path/query/headers、schemaの型と境界、OAuth security scheme、明示されたエラーのwire表現。
- API-CONTRACTが所有: 設計上の意味、compatibility policy、冪等性/状態の期待値、検証義務。TypeSpecと独立した第二のDTOを手書き維持しない。
- ROUTE-AUTHORIZATION-CONTRACTが所有: ANON、OWNER-SESSION、OWNER-API、MCP-CLIENT、SHARE-READER、SETUP等の最終的な**server-side**資源認可。OpenAPI `security` はtokenの必要条件でありobject level permissionの保証ではない。
- Orval生成物が所有: validator、ルート署名、wire DTO、client function等。generator出力を保護された手書きCodeに上書きしてはいけない。
- Handwritten Core/action handlerが所有: 実際のDB transaction、project/revision/owner、idempotency、author approval、rate/size/resource budget、receipt。仕様の型だけでは実現しない。

型生成の**自動的双方向一致は仮定しない**。TypeSpec source、生成OpenAPI、server/validator/client、実際のHTTPリクエスト/レスポンスを比較し、生成の固定性をテストする。

## ルート区分と単一admission

| 入口 | 移行後のルーティング | 身元/認可 |
| --- | --- | --- |
| GET /api/health、/ready、/version等 | TypeSpecで定義した一般Hono route | ANONの最小status。機密属性は返さない |
| /api/projects/*、/api/jobs*、/api/inbox* | TypeSpec/Orval route +既存Core action/service handler | owner vs assigned MCP、effect、project/object/revisionを中央で判定 |
| /api/v1/persistence/* | method/path別の明示operationへ展開 | **OWNER-APIのみ**。MCPから直接アクセスしない |
| /api/auth/*、OAuth/.well-known | Better Auth公式handler・必要な既存カスタム処理を**別のmount**に登録 | session/CSRF、PKCE、OAuth issuer/audience、owner verification、metadata最小公開 |
| /mcp、project下のMCP contribution | SDK v2公式HTTP server/adapterを明示的mount | MCP client assignment、scope、effect、project、毎request |
| /api/public/projects/* | share capability専用の明示route | private APIへ昇格しない |
| optional module HTTP contributions | 選択されたmodule manifestのmethod/path/permissionを登録するhost-owned adapter | moduleごとのaccess/effect/owner、unknown pathはfail closed |
| /console/setup等 | 将来の**未実装**管理UI/API設計に従う | 通常owner APIとsetup-onlyを混同しない |

**認可の順序:** 外部path正規化 → method/URLに対する公開例外の判定 → Origin/CORS/CSRF → credential検証とprincipal分類 → project assignment → object/version/effect → transaction前条件。これを各生成handlerにコピーせず**中央admission middleware + transaction boundary**に実装する。ただし、一般Hono middlewareや自動validatorの成功を、認可済みの根拠として扱わない。

**重要:** 現行server.tsの手動分岐をOrvalの生成結果と並列で恒久維持しない。移行中も同一URLに対する二重handlerによって認可差が生じないrouting/dispatchを採用する。移管済みrouteだけが新経路を通り、残りは一意の旧handlerに委譲する期間を明示し、最終的に旧catch-allを削除する。

## 生成器の保護境界

Orvalの公式Hono generatorは `handlerGenerationStrategy: smart|skip|full` を持つ。**採用:** 生成用のroute/validator/clientを手書きコードから分離し、Orval `smart` は試験的なhandler移行のみに使用。プロダクションの業務handlerをgenerator-owned directoryに同居させない。

- `output.clean` は `target` と `schemas` 内の非生成ファイルも削除する。手書きhandlerをこのディレクトリに置かない。
- `smart` は公式に部分的なimport/validator同期と新operation追加を行うが、任意の手書きコードを証明する機能ではない。毎回の生成差分と意味的な受入を確認する。
- `full` はimport/middleware/helpersの削除が起こるため、既存業務handlerで採用しない。`skip` はvalidator更新が取り残され得るため、同期証明なしのまま利用しない。
- commit可能な生成物を選ぶ場合はソース+generator version+lockfileで同じbitを再生成して差分ゼロ。生成物をコミットしない場合もCIで同じ生成検証を実行する。
- `@operationId` は既存のAPI operation IDと互換になる安定値を設計に記録。型とルート名が変わっても断りなく再採番しない。 `x-requirement-ids` 等のextension使用はTypeSpec emitterとOrvalが保持/無視を正しく扱うことを確認してから決める。

## 既存コードからの移行に必要な受入条件

1. **HTTP入力:** JSON body上限12MiB（server.tsの現行 `MAX_JSON_BYTES`）、415 media type、400 malformed JSON、request header、method、query、同名query、URL encoding、pagination、body無し、HEAD/OPTIONS/CORSが意図どおり。
2. **HTTP出力:** 401/403/404/405/409/413/415/503、既存のmachine code、safe error body、Allow/header、`application/json`とSSEの正しいcontent-type、Streaming Responseの途中エラーが保護される。
3. **Web security:** CSP nonce/headersとVary、Origin、CSRF、JWT verification、owner session separation、Cloudflare AccessをAPI承認と取り違えない、encoded pathのmiddleware bypassなし。
4. **Stream/lifecycle:** SSEの実応答、abort/close/timeout、late write防止、owner notificationとjob stream、module HTTP streaming、MCP GET/POST、5秒のAPI drain/既存shutdown動作を再現する。HonoのWeb標準 Response→Node adapterへの変換でbody全量bufferを強制しない。
5. **DB semantics:** editor保存のIdempotency-Key、X-Client-Id、baseRevisionId、sha256、409 conflict response、PostgreSQL receipt、同じoperationの再送、別projectや別ownerの拒否。
6. **Auth:** Better AuthのOpenAPI 3.1.1はライブラリ管理のschemaとして別生成。TypeSpec OpenAPI 3.1.0とは**プロトコル上別versionの2ソース**として扱い、互換性テスト無しのblind mergeは禁止。公式openAPI pluginはearly stageであり、本番に `/api/auth/reference` を公開しない。
7. **Client:** Desktop/Mobile/iOSの相対URL、OAuth refresh/callback、credentials、payload、error/retry/abortを既存testと照合する。生成clientが必要なHTTP headersを消さない。
8. **Performance:** Fastify現行とHono候補を同じNode/Podman/PostgreSQL環境・同じ認可/JSON/SSE条件で測定。p50/p95/p99 latency、CPU/RSS、connected streams、throughput、起動時間を採取。単純なhello-world RPSだけで判定しない。
9. **Route completeness:** 本番APIの全path/method、Better Auth route、dynamic module HTTP contribution、public reader、MCPを逆走査。schemaに存在するがhandlerがない場合も、その逆も検出する。

上のうち一つでも重要な機能が未検証/劣化なら**Hono全面移行を完了宣言しない**。Fastifyを選び直す場合は公式supportの限界や再現可能な失敗と同等の代替試験を示して新たに設計承認する。

## 導入対象・依存とCI

- **契約:** `@typespec/compiler`, `@typespec/http`, `@typespec/rest`, `@typespec/openapi`, `@typespec/openapi3` の相互互換release集合。
- **実行:** Hono **安定4.x** とNode adapter、Zod v4（検証時点ではHono 4.13.19のリリースを確認。5 prereleaseへは根拠なく移行しない）。Hono 4.13.16〜18のセキュリティ修正内容を確認し、古い脆弱版に固定しない。
- **生成:** OrvalのHono/Zod/fetch generator。TypeSpec→OpenAPI 3.1.0を明示し、OpenAPI generatorが3.0へ暗黙fallbackすることを許さない。
- **検証:** Redocly CLI 2 lint/bundle、oasdiff breaking analysis、Schema validation、Schemathesis（使い捨てPostgreSQLのみ）、現行E2EとOAuth/MCP integration。
- **version policy:** 新規採用時点の最新安定版を調べ、変換結果とCIを検証してlockfileを確定。個別制約のためのpinには理由/見直し条件を残す。TypeSpec compiler/emitter/Orval/validatorの更新は**再生成結果とdiff**を同じPRに含める。

## 実装計画の最小分割

Phase A: 現行ルート・principal/DTO/error/special transportを漏れなく抽出、既存 [API contract](API-CONTRACT.md) をpath+method単位に展開する。

Phase B: TypeSpecでrequest/response/security/known errorsをモデリングし、OpenAPI 3.1.0→Orval生成のroundtripと合意された反例を試験する。動作中APIは変更しない。

Phase C: 最小のread-only一般routeでHono/HonoNodeへ移行し、中央admissionとerror mappingを確認。次にpersistence CRUD/競合を移管。

Phase D: Better Auth、MCP SDK v2、SSE、public reader、optional modules、graceful shutdownを境界ごとに移管。旧Fastify/catch-all、二重validation、残骸compatibilityを削除する。

Phase E: 同一条件の性能測定、全E2E・実DB・auth BOLA・CI exact-sourceの合格で旧実装の退役を確定。

**本PRは設計書のみであり、TypeSpec/Orval/Honoの導入・実行・性能検証を行っていない。**
