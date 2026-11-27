# HTTP API 詳細契約・Operation台帳

**種別: 規範的API設計。** この文書は操作の意味、競合・冪等性、互換性、検証義務を定める。principalとURLごとの許可・拒否は [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md)、OAuthとBetter Authのプロトコルは [API AuthN/AuthZ](API-AUTHN-AUTHZ.md) と [MCP OAuth](MCP-OAUTH.md)、Coreの変更とreceiptの意味は [Core](CORE.md) が正本である。

Codexiaが所有するHTTPのmethodとpath、DTO、header、ステータス、エラー、securityの正本は [TypeSpec](../../packages/http-contract/src/main.tsp) とする。
公開中の [API Reference](https://yohn-jp.github.io/codexia/api/) で各操作のHTTP表現を参照できる。ローカルでは `pnpm --filter @codexia/http-contract generate` で同じリビジョンのOpenAPIを生成する。

契約は90パスの115操作を収録する。
[ルート照合用の一覧](../../packages/http-contract/test/fixtures/admitted-routes.json) は、バックアップ管理11操作を含む現行の登録範囲を定義する。
`x-codexia-security-deviation` と `x-codexia-runtime-response-deviation` は、承認済みの互換基準と設計または実装の差を示す。
現行のジョブ一覧とOAuth同意一覧は配列を返し、互換基準ではオブジェクトとして定義されている。
MCP の HTTP 入口は TypeSpec で定義し、JSON-RPC のペイロードは [MCP プロトコル契約](MCP-V2-MIGRATION.md) に従う。
`POST /mcp` と作品別の POST 入口を公式 SDK に委譲する。
同じ二つの URL に対する GET と DELETE は、認可されたリクエストにも 405 を返す。
API epoch 4 で承認した契約是正では persistence の UUID、版番号、必須項目、長さ・範囲制約およびポータブルアーカイブの形状を TypeSpec 正本に記述する。MCP POST の 400 応答は、認可等の ApiError と JSON-RPC parse error の両方を明示する。Persistence の JSON body を要求する操作は未対応メディア型に415を返す。opaque cursorはAPIから返された値を使用する。保存はX-Client-Idまたは本文clientIdを必須とし、ChangeSetは7種のnative operationの形状、pathとcommandのproject一致およびwrite identity一意性を要求する。アーカイブの参照整合性、自己merge禁止等の業務制約は静的スキーマとは別に実行時に検証する。

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

TypeSpecの各操作には、英小文字と数字をアンダースコアで区切った明示的な `operationId` を付ける。
IDは重複させず、表示名や説明を変えるときも維持する。
共有または生成クライアントに公開するモデルには、`PersistenceDocument` のように領域と意味を表すPascalCase名を付ける。
操作の状態は `x-codexia-contract-status` で表す。
`target` は採用済みの未実装設計、`incomplete` は詳細または証拠が欠けている契約、`complete` はワイヤ定義が揃った契約を指す。
実行環境の適合はソースSHAに結び付いた検証証拠で判断する。

## 操作群と設計の参照先

操作群の設計を下表に示す。
個別のmethod/path、`operationId`、DTOはTypeSpecから参照し、許可主体は [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md) で確認する。

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
| project_scratch_post | POST /api/projects/:p/scratch | OWNER-API | packages/api/src/server.ts | 下記に添付の保存契約 |
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
| API-BACKUP-CONSOLE-001 | GET /api/console/backups/status、GET /api/console/backups/config、PUT /api/console/backups/config/draft | OWNER-SESSION、If-Matchと書込時のfresh | [Backup console](BACKUP-CONSOLE-CONTRACT.md)・将来のFastify route | **BKC-001〜003。operatorによる有効化が必要** |
| API-BACKUP-CONSOLE-002 | POST /api/console/backups/config/probes、GET .../config/probes/:id、POST .../config/{activate,disable} | OWNER-SESSION＋probe/revisionとfreshの適用 | [Backup console](BACKUP-CONSOLE-CONTRACT.md) | **BKC-004〜007。operatorによる有効化が必要** |
| API-BACKUP-CONSOLE-003 | POST /api/console/backups/runs、GET /api/console/backups/runs、GET /api/console/backups/runs/:id、GET /api/console/backups/recovery | OWNER-SESSION。OPERATOR権限に昇格不可 | [Backup console](BACKUP-CONSOLE-CONTRACT.md) | **BKC-008〜010。operatorによる有効化が必要** |
| API-SETUP-001 | /api/auth/codexia/setup/* | 可否の公開応答とSETUP transactionを分離 | [AuthN/AuthZ](API-AUTHN-AUTHZ.md)、`packages/api/src/owner-setup.ts` | setup専用routeを実装。保護された稼働環境での登録受入は別途確認 |

この表の分類IDは設計上の参照に使用する。
各method/pathとoperation IDの対応は生成OpenAPIで確認する。
ハンドラーと試験への追跡は [Traceability](../verification/TRACEABILITY-REGISTER.md) が扱う。

## 操作の意味と検証の責務

### 管理コンソールの所有者セッション確認（API-OWNER-SESSION-001）

- POST `/api/auth/codexia/owner-session`。JSON bodyは空object `{}`、cookie credentialだけを受け付ける。要求には公開originと完全一致する`Origin`が必要。missing/mismatched `Origin`、`Authorization` header、cookieとbearerの併用を拒否する。
- Better Authが署名・期限を検証したセッションのuser IDが、server設定のowner subjectと一致する場合だけHTTP 200、bodyは`{"authenticated":true}`。user/session ID、email、consent、credentialを返さない。
- 有効sessionがない場合は401 `AUTHENTICATION_REQUIRED`。owner以外、bearer credential、cross-originは403。JSON bodyが空object以外または型が違う場合は400 `OWNER_SESSION_REQUEST_INVALID`。
- `Cache-Control: no-store`はserver共通security headerで適用。cookieをOWNER-API bearerやAPI project/sessionに変換しない。実装は [route authorization](ROUTE-AUTHORIZATION-CONTRACT.md) のOWNER-SESSION境界とconsoleの入口で使う。
- SOURCE: `packages/api/src/server.ts` のexplicit route admission、`packages/api/src/better-auth.ts` の`checkOwnerSession`。
- TEST: `packages/api/src/server.test.ts` と `packages/api/src/better-auth.persistence.test.ts`。

### 公開Scratch APIの添付保存

`POST /api/projects/{projectId}/scratch` は、Scratchノートの本文と添付を一つのCore operationにまとめ、proposalの登録と所有者の承認を経て適用する。
適用が完了するとHTTP 201でノートの情報、添付、proposal、receiptを返す。
この操作はクライアント指定の冪等性キーを受け付けず、再送は新規作成として扱う。

添付の表示名には入力ファイル名の最後のパス要素を使う。
保存パスを組み立てる際は名前を正規化する。
保存パスは同名または正規化後に同名となる添付にも個別に割り当てる。
レスポンス、ノートのfront matter、本文内の添付参照はリクエストの添付順を保ち、本文の各リンクは対応する保存パスを参照する。

Fastifyが受け付けるJSONは12 MiBまでで、標準のBase64から復号した添付は合計8 MiBまでとする。
Coreのoperation上限は書き込み内容の合計8,388,608 UTF-16コード単位であり、添付のBase64と生成したMarkdownの両方を含む。
復号後に `n` バイトの添付は、Base64にすると `4 × ceil(n / 3)` コード単位を使う。
永続proposalの上限は正規化したproposal全体をJSONに直列化したUTF-8で8 MiBとする。
エンベロープとメタデータも容量を使うため、保存可能な添付容量は本文やファイル名などによって変わる。
サイズ超過はproposalの登録前にHTTP 413を返す。
エラーコードはJSON上限の場合に `BODY_TOO_LARGE`、添付または保存上限の場合に `SCRATCH_ATTACHMENT_TOO_LARGE` とする。
添付フィールドの不正や非正規のBase64はHTTP 400とする。

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
- 成功時は HTTP 200 と更新結果を返す。DB が履歴と新しい Revision を一緒に保存する。保存元の Revision が古い場合は HTTP 409 と `PERSISTENCE_CONFLICT`、`details`、`current` を返す。保存済みの冪等キーを異なる内容に再利用した場合は HTTP 409 と `IDEMPOTENCY_CONFLICT` を返し、保存済みの Revision を維持する。
- アプリは再試行時に**同じoperation identity**を保持する。レスポンス不明時に新規操作として重複適用しない。
- SOURCE: persistence-routes.ts の documents/:d PATCH、postgres-store.ts の保存トランザクション。
- TypeSpecは変更のUTF-16オフセット、結果のSHA-256フィールド、保存結果と競合時の現行revisionを記述する。
- 互換基準のため生成契約で強制できない入力制約と、実APIでのエラー型およびヘッダーの全条件は別途照合する。

### API-PERSIST-009 — KnowledgeとChangeSet

- native Knowledge/Anchor/Assertionの操作はproject scope、revision・expectedVersionと状態遷移に拘束する。mergeにはpreviewDigest、projectVersionと明示confirmが必要。
- ChangeSetの提案POSTと approve/reject/apply POSTは**異なる操作**。各承認/拒否/適用はexpectedVersionを必要とする。MCPはauthor-onlyの承認/適用へ昇格しない。
- SOURCE: persistence-routes.ts、native-knowledge-service.ts、native-knowledge-actions.ts、postgres-store.ts。
- 不足: 各operationとJSON型を分離した完全DTO/エラー/権限表。

ポータブル作品の import は正規化したアーカイブのハッシュで再送を照合する。
従来のクライアントから送られる `Idempotency-Key` は任意とし、保存操作の冪等キー要件は個別の operation に従う。

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
4. TypeSpecからOpenAPI 3.1.0を生成し、決定性、構造、互換性、実装との照合を [HTTP platform migration](HTTP-PLATFORM-MIGRATION.md) と [ツール受入契約](../verification/SPECIFICATION-TOOLING-ACCEPTANCE.md) に従って検証する。
5. Better Authが提供するライブラリ操作は公式契約に委ねる。Codexiaの認証アダプターとMCPのHTTP入口はTypeSpecに含め、MCPのtool schemaはSDK側が所有する。

### 操作の追加、変更、廃止

1. 領域設計で公開範囲、許可主体、リクエスト、成功・失敗時の応答を決め、該当するTypeSpecを変更する。
2. `pnpm --filter @codexia/http-contract generate` でOpenAPIを再生成する。TypeSpecと生成差分を同じ変更に含める。
3. `pnpm test:http-contract` で生成差分、Redocly、oasdiff、Fastifyのスキーマ適合を確認する。
   `pnpm --filter @codexia/app generate:http` と `pnpm --filter @codexia/app check-generated:http` でDesktop Webの生成クライアントとoperation照合を更新・検査する。
   iOS の API 生成契約への影響も確認する。Native iOS 開発と IPA CI の凍結はそのまま適用する。
4. 廃止予定を告知する場合はTypeSpecに廃止予定を記載する。互換性を壊す削除や変更は、利用者の移行とAPI epochの切替を規定する互換手順で扱う。
5. 初回本番導入の契約是正に限り、基準コミット `ed11a58d1c92f749d67e2d0db2c3d251c0bc5c87` からの epoch 3 → 4 を認める。oasdiff の実行・結果保存は必須で、許容対象は persistence 入力制約・アーカイブ形状と MCP POST の 400 応答の是正に限定する。この基準に対する許容範囲は当時の是正に限る。

6. 初回本番導入前であることを確認できた場合に限り、Backup Console の owner cookie 宣言と必須リクエスト、および MCP の 405 応答型を、一度の API epoch 4 → 5 で是正する。対象、基準 SHA、oasdiff の差分の完全照合と検証義務は [API epoch 5 契約是正](API-COMPATIBILITY-TRANSITION-PROPOSAL.md) に従う。同一 epoch の破壊的変更、承認外の基準や epoch、既存稼働環境への非互換自動更新は拒否する。

## バックアップ管理API

`/api/console/backups/*` は通常の `OWNER-API` bearer用作品APIでもMCPのtool/actionでもない。Cloudflare Workers配信 `/console/backups` から**OWNER-SESSION専用・CSRF/Origin保護**で呼ぶ。fresh proofが必要なmutationと、各method、status/error、version/idempotency、secretの非表示は [Backup console contract](BACKUP-CONSOLE-CONTRACT.md) の `BKC-001`〜`BKC-010` が所有する。

- [Backup ConsoleのTypeSpec](../../packages/http-contract/src/routes-backup-console.tsp) の11操作は、Fastifyのバックアップ管理プラグインが登録する。公開スキーマの認証宣言とワイヤ定義には残差があり、各操作の状態を `incomplete` とする。バックアップ実行基盤の有効化手順は [Backup Console provisioning](../../deploy/backup/CONSOLE.md) を参照する。
- 秘密を含む入力は書き込み専用とし、公開契約の例やScalarへ秘密値を含めない。
- `202`のprobe・activate・manual backup要求は`operationId`/`probeId`/`runId`を返し、成功は**実executor receiptをGETで再取得して**初めて判断する。別にPOST本番復元エンドポイントは存在しない。
- 異常系として401/403/404/409/412/422/429/503と、重複/応答不明、S3 credential失効、metadata SSRF、bucket越境、CSRF、owner session expirationを実APIで検証する。
