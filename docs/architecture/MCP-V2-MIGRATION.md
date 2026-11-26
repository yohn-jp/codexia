# MCP SDK v2 / 2026-07-28 プロトコル移行設計

**種別: 採用済みSDK移行契約。** MCP OAuthの `resource`/audience、client identity、`mcp:read/compute/propose`、assigned project、author-only承認は [MCP OAuth](MCP-OAUTH.md)、[Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md)、[Core](CORE.md) が正本。MCPをHTTP API/独自driverで再実装せず、[Toolchain](SPECIFICATION-TOOLCHAIN.md) の公式MCP TypeScript SDK v2を使用する。

HTTP は `modules/mcp/src/http.ts` の `createMcpHandler`、stdio は `modules/mcp/src/stdio.ts` の `serveStdio` で受ける。
両 transport は `modules/mcp/src/tools.ts` の `createCodexiaMcpServer` から同じツールを登録する。
`packages/api/src/oauth-mcp.ts` は OAuth の owner と MCP の権限を分ける。

## v2 SDKの採用とプロトコル世代を分ける

- **SDK**。実行時は `@modelcontextprotocol/server` v2 を使う。
  Fastify の既存 module HTTP adapter が渡す Web Request を公式 `fetch` ハンドラーへ接続する。
  stdio は `@modelcontextprotocol/server/stdio` を使う。
- **ツール:** `McpServer` の登録方式を公式migration guideに沿って変更する。input/output Schema、tool metadata、戻り値とerrorのvalidationをZod v4へ統一する。既存のtool nameやeffect権限を無断変更しない。
- **2026-07-28 wire protocol:** SDK v2のインストールだけでは自動で新世代にならない。2026のHTTPは原則statelessで、旧 `initialize`、`Mcp-Session-Id`、GET stream/DELETE sessionへの依存を取り除く。公式 `createMcpHandler(factory)` が2026 per-request HTTP entrypoint、stdioは `serveStdio(factory)` が新旧世代の接続を選ぶ。
- **異なる世代への扱い**。現行クライアントの移行期間と拒否条件は次節に定める。
- **Zod:** v2公式exampleは `zod/v4` に従う。v1互換の `zod/v3` が残るのは移行対象。v2側にschemaを導入しただけではcore toolの出力整合は証明されない。

公式: [MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)、[v1→v2 upgrade](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)、[2026-era opt-in](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)、[MCP conformance](https://github.com/modelcontextprotocol/conformance)、[Inspector](https://github.com/modelcontextprotocol/inspector)。

## プロトコルの互換期間

Codex CLI 0.172.0 は HTTP 接続時に `2025-06-18` の `initialize` を送る。
既存クライアントの移行期間として、2027-01-28 00:00 UTC より前は、公式 SDK v2 の旧世代 stateless fallback を利用できる。
互換モードで交渉できる版は SDK 2.4.0 の `SUPPORTED_PROTOCOL_VERSIONS` に従い、`2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`、`2024-10-07` を含む。
stdio の新規プロセスも同じ期限まで SDK が提供する旧世代の接続を受け付ける。
期限以降は HTTP の各リクエストと新規 stdio プロセスに `legacy: "reject"` を適用する。
互換期間中も、接続元の認可と対象作品の選択は各リクエストでやり直す。
MCP のセッション ID の発行、イベントストリームの再開、セッション削除は廃止する。
API epoch 3 以降の MCP エンドポイントは GET と DELETE の成功応答を提供しない。epoch 4 では認可済み MCP POST の不正 JSON に JSON-RPC parse error（HTTP 400、id: null、code: -32700）を返す。認可等の ApiError は維持する。

## 移行後のリクエスト境界

```text
External MCP client
    |
    | OAuth resource/audience + registered client
    v
Cloudflare Tunnel  /mcp[?projectId=assigned-id]
    |
    v
Fastify outer ingress / project selection / identity & CORS
    |
    v
Official SDK v2 handler (stateless, per request)
    |
    v
Codexia authorized tool/action adapter
    |  read / compute / propose (effect ceiling)
    v
Existing Core / PostgreSQL snapshot / proposal
    |
    +--> owner UI review -> owner-only approve/apply
```

**毎request認可が必須。** 旧session mapからprojectやprincipalを信頼してはならない。複数projectが割り当てられたclientは、既存設計どおり明示した対象projectを選ぶ。ID不一致、別project、scope不足、別clientの委譲、project/versionが古い操作を拒否する。MCPが永続正本を直接更新しない境界は不変。

## HTTP transport、OAuth、sessionの変更

| 項目 | 現行v1 | 目標v2 + 2026 wire | 受入観点 |
| --- | --- | --- | --- |
| handshake | initialize + initialize notification | 2026-era per-request envelopeと必要なcapability discovery | supported protocol版本のnegotiation |
| session | `Mcp-Session-Id`とserver map / idle timeout | 2026-eraではper-request state。author projectの状態はserver trusted contextで再解決 | request間のidentity混同とメモリリークを拒否 |
| HTTP method | GET/POST/DELETEを使う旧sessionful入口 | SDK公式2026 HTTP handling。旧session処理を削除 | POST/Content-Type/headers/abortと不正method拒否 |
| stream | SSEとtransport session lifetime | 2026 per-request SSEとcloseによるcancellation、必要なsubscription protocol | 中断やerrorが別clientへ漏れない |
| identity | mcpSessionIdentity / project in session | token/client/assigned projectを**毎request**検証 | cross-client replay、stale assignment、scope step-up |
| protocol headers | `Mcp-Session-Id` 等 | `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` とリクエストごとの `_meta` | ヘッダーと本文の不一致、CORS、401/403 |
| stdio | StdioServerTransportのv1接続 | serveStdio factory、stdioから同じtool/action群 | STDOUTはJSON-RPCのみ、終了/abort、caps |
| approval | core proposal、owner UI approve/apply | **同じ**Core actionと権限。MCP approve/applyは引き続き禁止 | scopeだけでauthorに昇格不可 |

2026-eraではserver-side identityがper-requestとなる。過去のv1サーバーで使った内部lifecycle mapを新しいprotocolへそのまま引き継ぐことはしない。既存のresource/response/partial streamの保持が必要なら、approved state modelとして再設計し、理由とcleanup条件を明記する。

## OAuth/ACL/公開経路

1. OAuth protected-resource metadataのexact resource、issuer、JWKSとtoken typeは現行 [MCP OAuth](MCP-OAUTH.md) の規範を維持する。Cloudflare Accessの通過、Better Auth session、owner bearer、MCP bearerは代替可能な同一権限ではない。
2. `CODEXIA_OAUTH_MCP_CLIENT_IDS` とserver側assigned projectsの保護を維持。管理画面でclientを表示したこと自体では認可許可にしない。
3. `mcp:read` / `mcp:compute` / `mcp:propose` は効果上限。実ツールのeffect、project、object/revision権限の**両方**をAPI admission/adapterで検証する。
4. 2026-07-28に要求されたissuer識別やtoken/credential分離、scope step-upはSDKのoptionが存在するだけで成立しない。Better Auth OAuth Providerと認可層のconfig/protocolが実際に満たすことを確認する。**公式 `createMcpHandler` はHost/Origin検査を実施しないため、Fastify outer ingressで許可Host・OriginとDNS rebinding保護を実装し、ヘッダー不一致・Host偽装を負のテストで拒否する。**
5. public metadataと/api/authのpathは [External interfaces](EXTERNAL-INTERFACES.md)・[HTTP platform migration](HTTP-PLATFORM-MIGRATION.md)と一致させる。Better Auth公式endpointの変化をMCPからのアクセス拡大に使わない。
6. strict `/mcp` と、割当作品を示す `?projectId` の正規化・URL逸脱を検証する。Cloudflare Edge、Fastify、SDKでpath解釈が異なってはならない。

## Tool Schemaと追跡

- `modules/mcp/src/tools/{project,knowledge,story,search,legacy}.ts` と `tools.ts` で実際に登録するtoolをインベントリ化。tool名、説明、input/output Schema、read/compute/propose、project/snapshot requirement、size/time limit、エラーcode、対応するAction IDを記録する。
- Tool Schemaの正本はSDKに渡す実行Schemaに置き、Markdownからの入力/出力を二重に手書き維持しない。設計上の意味、作用と禁止はMCP-OAUTH/CORE/MODULESが所有する。
- StrictDocでは `REQ-MCP-*`、`EXT-MCP-*`、tool/Action、source range、TEST-ID、CI証拠を接続する。単にtools/listに載るだけではproposal/author-only invariantを満たしたことにならない。
- `legacy.ts` 等の名前だけで廃止と判断しない。要求・runtime使用の逆照合で不要と確定したcompatibilityのみ削除する。旧仕様の保持を無期限に認めることもしない。

## 検証計画

| ID | 層 | 試験と合否 |
| --- | --- | --- |
| MCPV-001 | Compile/schema | v2 SDK+Zod v4で全toolの登録・入出力schemaが型・実行時に有効 |
| MCPV-002 | Protocol conformance | `npx @modelcontextprotocol/conformance server --url <isolated-url>/mcp --requirements 2026-07-28` を隔離認可環境で実行。required failureなし。スコア対象外failureは別記 |
| MCPV-003 | Inspector | Inspector CLI/Webでツール名/Schema、各transport、相互運用・再接続・新世代へのnegotiationを確認 |
| MCPV-004 | Cross-principal | owner、MCP、失効client、別project、scope不足/過剰の認可拒否。MCPによるapprove/apply不可 |
| MCPV-005 | State integrity | snapshot競合、提案後の作者承認、replay/duplicate、transaction receipt、実PostgreSQL再起動 |
| MCPV-006 | Transport/lifecycle | HTTP/stdio、stream abort、timeout、invalid header、oversized input、shutdown/drain、別request/別clientの漏えい |
| MCPV-007 | Protocol-era boundary | 2026-only と期限付きの 2025 fallback を試す。旧 sessionful 操作は移行期間中も 405 となり、期限以降は 2025 系の呼び出しも拒否する |
| MCPV-008 | Client interop | 採用する外部AIクライアントでOAuth PKCE、token refresh、対象選択、Tool/Resultの実通信 |

conformanceの `--requirements 2026-07-28` は仕様リリース時点のrequired scenario集合に対応し、単なる最新のall-suitesと区別する。テスト対象のOAuth authorization-server部分はMCP resource serverのconformanceだけでは証明できないため、Better Authの実認証E2Eで検証する。Inspectorが接続できることだけでconformance済みとしない。

## 実装順序と禁止

1. 現行v1のtransport/registrar/author scopes/CIを観測し、toolインベントリと既存テストの合否を固定する。
2. SDK v2のAPIと公式codemodを評価してtoolsをv2へ移行。stdio/HTTPは同じhandler factoryとCore action adapterを利用する。
3. 2026-eraを隔離環境で有効化し、sessionful既存機能との同等性・Protocol/permissionの違いを実証する。
4. Fastifyのouter admissionとMCP handlerを接続。OAuth metadata、tool limits、stream/recoveryの負のtestを実行する。
5. 保護された実クライアント/テストの受入が成立した後、不要なv1 session mapと恒久compatibilityを撤去する。

SDK と Zod の固定版は [依存台帳](DEPENDENCY-INVENTORY.md) で管理する。
公式 codemod は旧 SDK の import と登録 API の差分確認に使う。
transport とプロトコル世代の変更は、公式移行ガイドに従って検証する。
個々の受入結果は MCPV ID と exact-source の実行証拠を PR または CI artifact で照合する。
