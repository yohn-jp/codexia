# HTTP API 詳細契約・Operation台帳

**種別: 規範的API設計。** この文書は **APIのmethod/path、入力・出力DTO、HTTP status・エラー、競合・冪等性、version、検証可能性** を所有する。principalとURLごとの許可・拒否は [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md)、OAuth/Better Authのプロトコルは [API AuthN/AuthZ](API-AUTHN-AUTHZ.md) と [MCP OAuth](MCP-OAUTH.md)、Coreの変更/receiptの意味は [Core](CORE.md) が正本である。ここで第二の権限モデルや代替writerを作らない。

**ベースライン:** main@e02933aead466b14cbcd336905b9c2a2a2b39f06。実装の所在・一部DTOを読み取った初期契約であり、全route・全fieldを網羅していない。後述の未充足項目を完全なOpenAPIと偽らない。存在するpathは目標となるpathの実装状況とは別に管理する。

## 契約境界

- **Web/iOS/Core API:** packages/api/src/server.ts がFastifyの共通admissionとCore API routeを所有。認証済みowner bearerはAPIからproject/objectまで検証する。
- **PostgreSQL persistence API:** packages/api/src/persistence-routes.ts が /api/v1/persistence/ 以下の明示的操作を所有する。MCP bearerの直接アクセスは拒否する。
- **Better Auth:** /api/auth/ 以下のprotocol endpointはpackages/api/src/better-auth.ts と使用する公式ライブラリの契約に従う。ログインUIやMCPは独自のOAuth serverを作らない。
- **MCP HTTP:** /mcp とproject下のstreamable入口は modules/mcp/src/http.ts のtransport契約であり、HTTP上のJSON-RPC toolは [External interfaces](EXTERNAL-INTERFACES.md) とMCPのtool Schemaを持つ。独立した原稿保存APIではない。
- **Module contribution:** packages/api/src/server.ts、modules/各実装、capability/Action descriptorに従う。module名だけでowner-wide readを許可しない。
- **Public reader:** /api/public/projects/... はshare capabilityに限る。公開範囲とprivate persistenceを混ぜない。
- **Edge:** deploy/cloudflare/ui-routes.json のorigin route対象と一致しなければ公開可能とみなさない。Edge経由の通過とアプリの認可を分離する。

## Operation-IDと記載粒度

Operation IDは安定の設計用識別子であり、URLの改名や実装完了を意味しない。全HTTP method+具体path（wildcardを展開した組）は、最終的に一つのOperation IDを持つ。各operationの必須列は次のとおり。

| 構成要素 | 必須契約 |
| --- | --- |
| Request | method・path・path/query/header/bodyの各field、型、必須/任意、最大長・上限、既定値 |
| Response | 2xx各statusとfield/schema、nullable、cursor、etag/receipt、content-type、streaming lifecycle |
| Failure | 400/401/403/404/405/409/412/429/503等の**実際に適用される**status/code、漏えい禁止、retryの可否、client復旧 |
| State | principal、project/object、version/revision、idempotency、transaction、変更の帰結と副作用 |
| Link | REQ-ID、設計節、handler symbol、関連SQL object、DTO定義、TEST-IDと実行証拠 |
| Lifecycle | 現行/採用済み将来目標/廃止。公開互換性・変更時の評価とrelease epoch |

実装と仕様の差はこの文書/trace台帳に記録し、コードだけから正本を生成して正当化しない。OpenAPI Schemaを導入する場合、**設計正本と型/handlerの一意の生成・照合方向**を決定するまで両方を独立編集可能な正本としない。

## HTTP Operation初期台帳

下表は構造を確認した入口の「初期索引」。許可主体は [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md) が決定する。詳細schema未掲載の行は **INCOMPLETE** とする。

| Operation ID | method + path（主なfamily） | principal | handler/契約位置 | 詳細化状況 |
| --- | --- | --- | --- | --- |
| API-HEALTH-001 | GET /api/health | ANON | packages/api/src/server.ts | 下記に部分契約 |
| API-HEALTH-002 | GET /api/ready、GET /health/{live,ready,startup} | ANONの最小観測 | packages/api/src/server.ts | INCOMPLETE |
| API-VERSION-001 | GET /api/version、GET /api/browser/version | ANON | packages/api/src/server.ts、deploy/*compatibility.json | INCOMPLETE |
| API-OWNER-001 | GET /api/session | OWNER-API | packages/api/src/server.ts | INCOMPLETE |
| API-OWNER-SESSION-001 | POST /api/auth/codexia/owner-session | OWNER-SESSION cookie only | packages/api/src/server.ts, packages/api/src/better-auth.ts | partial; read-only owner confirmation |
| API-CORE-001 | GET/POST /api/projects | OWNER-API（MCPのGETは条件付き） | packages/api/src/server.ts | INCOMPLETE |
| API-CORE-002 | GET /api/projects/:p、/{tree,history,status,observation,snapshot,scenes/:d} | OWNER-API / project割当済みMCP-read | packages/api/src/server.ts | INCOMPLETE（path別IDを展開） |
| API-CORE-003 | GET /api/projects/:p/{actions,modules,contributions,search,writing-stats} | effectによる | packages/api/src/server.ts、module runtime | INCOMPLETE（path別IDを展開） |
| API-CORE-004 | POST /api/projects/:p/actions/:actionId | effect/actor別 | packages/api/src/server.ts | INCOMPLETE |
| API-CORE-005 | POST /api/projects/:p/{proposals,approvals,apply} | 提案条件・owner承認別 | packages/api/src/server.ts | INCOMPLETE（操作別IDを展開） |
| API-CORE-006 | GET/PUT /api/projects/:p/recent-activity、GET/POST /api/inbox*、GET /api/jobs* | OWNER-APIのみ | packages/api/src/server.ts | INCOMPLETE（path別IDを展開） |
| API-PERSIST-001 | GET /api/v1/persistence/status | OWNER-API | packages/api/src/persistence-routes.ts | 部分定義 |
| API-PERSIST-002 | GET /api/v1/persistence/projects | OWNER-API | packages/api/src/persistence-routes.ts | 部分定義 |
| API-PERSIST-003 | POST /api/v1/persistence/projects | OWNER-API | packages/api/src/persistence-routes.ts | 部分定義 |
| API-PERSIST-004 | POST /api/v1/persistence/import | OWNER-API | packages/api/src/persistence-routes.ts、work-archive.ts | INCOMPLETE |
| API-PERSIST-005 | GET/PATCH /api/v1/persistence/projects/:p、GET .../:p/archive | OWNER-API | packages/api/src/persistence-routes.ts | INCOMPLETE（path別IDを展開） |
| API-PERSIST-006 | GET/POST /api/v1/persistence/projects/:p/documents | OWNER-API | packages/api/src/persistence-routes.ts | INCOMPLETE |
| API-PERSIST-007 | GET/PATCH/DELETE /api/v1/persistence/projects/:p/documents/:d、PATCH .../:d/metadata | OWNER-API | packages/api/src/persistence-routes.ts | 部分定義（path別IDを展開） |
| API-PERSIST-008 | GET .../documents/:d/revisions、POST .../documents/:d/restore | OWNER-API | packages/api/src/persistence-routes.ts | INCOMPLETE |
| API-PERSIST-009 | .../{anchors,nodes,assertions,changesets,review-feed} | OWNER-API | packages/api/src/persistence-routes.ts、native-knowledge-service.ts | INCOMPLETE（全path・methodを展開） |
| API-AUTH-001 | /api/auth/* およびOAuth/.well-known公開metadata | protocol別 | packages/api/src/better-auth.ts、auth-schema.ts | INCOMPLETE（library定義と照合） |
| API-MCP-001 | /mcp、/api/projects/:p/modules/mcp/streamable | MCP-CLIENT + assign/scope | modules/mcp/src/http.ts、packages/api/src/server.ts | INCOMPLETE |
| API-PUBLIC-001 | GET /api/public/projects/:p/modules/:module/* | SHARE-READER | packages/api/src/server.ts、各公開module | INCOMPLETE |
| API-BACKUP-CONSOLE-001 | GET /api/console/backups/status、GET /api/console/backups/config、PUT /api/console/backups/config/draft | OWNER-SESSION、If-Matchと書込時のfresh | [Backup console](BACKUP-CONSOLE-CONTRACT.md)・将来のFastify route | **目標/未実装。BKC-001〜003** |
| API-BACKUP-CONSOLE-002 | POST /api/console/backups/config/probes、GET .../config/probes/:id、POST .../config/{activate,disable} | OWNER-SESSION＋probe/revisionとfreshの適用 | [Backup console](BACKUP-CONSOLE-CONTRACT.md) | **目標/未実装。BKC-004〜007** |
| API-BACKUP-CONSOLE-003 | POST /api/console/backups/runs、GET /api/console/backups/runs、GET /api/console/backups/runs/:id、GET /api/console/backups/recovery | OWNER-SESSION。OPERATOR権限に昇格不可 | [Backup console](BACKUP-CONSOLE-CONTRACT.md) | **目標/未実装。BKC-008〜010** |
| API-SETUP-001 | /api/auth/codexia/setup/* | SETUP等・厳密な状態別 | [AuthN/AuthZ](API-AUTHN-AUTHZ.md) | **ACCEPTED TARGET / NOT IMPLEMENTED** |

**展開必須:** 集約表の波括弧表記・wildcardは設計概要でしかない。最終版では全メソッド＋実pathに対してID、schema、権限、code symbol、testを独立に記録する。現在の family IDで全ルートをカバーしたと報告しない。既存の [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md) には全般の個別認可表があり、それを漏れ検査の入力にする。

## 実ソースから確認した詳細契約

### API-OWNER-SESSION-001 — 管理コンソールの所有者セッション確認

- POST `/api/auth/codexia/owner-session`。JSON bodyは空object `{}`、cookie credentialだけを受け付ける。要求には公開originと完全一致する`Origin`が必要。missing/mismatched `Origin`、`Authorization` header、cookieとbearerの併用を拒否する。
- Better Authが署名・期限を検証したセッションのuser IDが、server設定のowner subjectと一致する場合だけHTTP 200、bodyは`{"authenticated":true}`。user/session ID、email、consent、credentialを返さない。
- 有効sessionがない場合は401 `AUTHENTICATION_REQUIRED`。owner以外、bearer credential、cross-originは403。JSON bodyが空object以外または型が違う場合は400 `OWNER_SESSION_REQUEST_INVALID`。
- `Cache-Control: no-store`はserver共通security headerで適用。cookieをOWNER-API bearerやAPI project/sessionに変換しない。実装は [route authorization](ROUTE-AUTHORIZATION-CONTRACT.md) のOWNER-SESSION境界と、本issue #662のconsole route entryで使う。
- SOURCE: `packages/api/src/server.ts` のexplicit route admission、`packages/api/src/better-auth.ts` の`checkOwnerSession`。
- TEST: `packages/api/src/server.test.ts` と `packages/api/src/better-auth.persistence.test.ts`。

### API-PERSIST-001 — 永続化の状態

- GET /api/v1/persistence/status。owner API admissionを必要とする。
- persistenceが利用可能なら HTTP 200、JSON bodyの available はboolean、provider は postgres または null。
- persistence health が失敗すれば HTTP 503、エラーcode PERSISTENCE_UNAVAILABLE。準備未完了を成功へ変換しない。
- SOURCE: packages/api/src/persistence-routes.ts の status分岐、packages/api/src/server.ts の入場制御。
- TEST候補: packages/api/src/persistence-routes.test.ts、tests/e2e/persistence-database.acceptance.spec.ts。exact-source結果は未記録。

### API-PERSIST-002 — projectの列挙

- GET /api/v1/persistence/projects。HTTP 200、JSON bodyは projects の配列と nextCursor（文字列またはnull）。
- query limit: 既定200、上限200。cursorはlistProjectPageの順序に束縛し、無効なcursorの扱いも契約テストに必要。
- MCPにこのpersistence pathの直接アクセスを許可しない。MCPの割当済みproject列挙は別のCore操作を使う。
- SOURCE: persistence-routes.ts の projects GET、project-pagination.ts。

### API-PERSIST-003 — project作成

- POST /api/v1/persistence/projects。入力 title は空でない文字列、最大256文字。settingsを送る場合はJSON object。
- 成功時HTTP 201、bodyは project。永続化エラーや認可拒否を201へ変換しない。
- SOURCE: persistence-routes.ts の projects POST、PostgreSQL transactionのcreateProject。
- TEST候補: persistence-routes.test.ts、persistence-database.acceptance.spec.ts。

### API-PERSIST-007 — documentの保存と競合

- PATCH /api/v1/persistence/projects/:p/documents/:d。bodyには baseRevisionId、changes配列、resultingSha256等の正規の差分が必要。clientIdは X-Client-Id またはbody、冪等性識別子は Idempotency-Key headerから取得する。
- 成功時HTTP 200の更新結果。履歴と新revisionの保存をDB側で検査する。競合時にはHTTP 409、code PERSISTENCE_CONFLICT、detailsとcurrentを返す分岐がある。
- アプリは再試行時に**同じoperation identity**を保持する。レスポンス不明時に新規操作として重複適用しない。
- SOURCE: persistence-routes.ts の documents/:d PATCH、postgres-store.ts の保存トランザクション。
- 不足: changes要素/shaの詳細Schema、全エラー型、receiptのfield、ヘッダーの必須条件を正規の型と実APIで照合する。

### API-PERSIST-009 — KnowledgeとChangeSet

- native Knowledge/Anchor/Assertionの操作はproject scope、revision・expectedVersionと状態遷移に拘束する。mergeにはpreviewDigest、projectVersionと明示confirmが必要。
- ChangeSetの提案POSTと approve/reject/apply POSTは**異なる操作**。各承認/拒否/適用はexpectedVersionを必要とする。MCPはauthor-onlyの承認/適用へ昇格しない。
- SOURCE: persistence-routes.ts、native-knowledge-service.ts、native-knowledge-actions.ts、postgres-store.ts。
- 不足: 各operationとJSON型を分離した完全DTO/エラー/権限表。

## 共通エラー・セキュリティの契約

- 入場前のcredential不正と、入場後の操作/資源への権限不足を区別する。projectや文書の存在を不要に漏らさない。
- 許可されたprincipal、method、target object、version、mutation effectが一つでも不一致ならfail closed。静的UIでボタンを隠すだけでは認可にならない。
- 400系の入力契約違反、401/403の認証認可、404の非存在、405のmethod違反、409などの競合、503の依存障害について、実装されたstatus+機械可読codeをoperationごとに照合する。全statusが全routeで発生すると推測しない。
- POST/PATCH等のunsafe methodで、idempotencyとbase revisionの有無・再送動作を明記する。HTTP成功がPostgreSQLの作者承認を意味するとは限らない。
- cursor、payload長、stream size、rate・timeouts、SSE中断、schema上限は各routeに明示する。未確認なら空欄ではなく INCOMPLETE。
- HTTP APIの権限はmethod別に定義し、MCPを含む各operationのnegative authorization testを要求する。

## 詳細化・導入ツールの受入基準

1. server.ts、persistence-routes.ts、auth providerの登録済みルート、全module contribution、public reader、/mcpを列挙し、path+methodの全行をこの台帳と照合する。
2. 全入力/出力のDTO、エラーとheader、version・idempotency・authorizationにSchema定義または等価な型契約を与える。
3. 仕様→handler・型・DB object・test、handler→要求の双方を [Traceability](../verification/TRACEABILITY-REGISTER.md) に記録する。
4. **採用済み目標:** [HTTP platform migration](HTTP-PLATFORM-MIGRATION.md)に従ってTypeSpecをAPIワイヤの編集正本とし、OpenAPI 3.1.0を生成、Fastify標準ルート/JSON Schema/Ajv、Orval生成client、Redocly/Scalar/oasdiff/Schemathesisで実装・表示・検証する。Better Authのライブラリ管理OAuth endpointは別生成ソースとして検証する。**実導入・全route網羅は未完了**であり、コードに合わせた仕様の追認を禁止する。
5. 稼働環境のOpenAPI/HTTP検証が未実行ならVERIFIEDとしない。設計書の追加自体ではCIやhandlerの改修を要求しない。

## バックアップ管理API（採用済み目標・未実装）

`/api/console/backups/*` は通常の `OWNER-API` bearer用作品APIでもMCPのtool/actionでもない。Cloudflare Workers配信 `/console/backups` から**OWNER-SESSION専用・CSRF/Origin保護**で呼ぶ。fresh proofが必要なmutationと、各method、status/error、version/idempotency、secretの非表示は [Backup console contract](BACKUP-CONSOLE-CONTRACT.md) の `BKC-001`〜`BKC-010` が所有する。

- 契約DTOはTypeSpec→OpenAPI3.1で生成するが、現時点ではOperation-ID索引だけ。秘密を含むcredential inputはwriteOnlyであり、OpenAPI公開例やScalarの静的Pagesに実値を含めない。
- `202`のprobe・activate・manual backup要求は`operationId`/`probeId`/`runId`を返し、成功は**実executor receiptをGETで再取得して**初めて判断する。別にPOST本番復元エンドポイントは存在しない。
- 異常系として401/403/404/409/412/422/429/503と、重複/応答不明、S3 credential失効、metadata SSRF、bucket越境、CSRF、owner session expirationを実APIで検証する。
