# URL・API・principal 別の認証認可設計

**種別: 規範的設計。** 本書は、入口URL、HTTP method、呼出principal、作品/対象資源、デプロイ状態を組み合わせた許可・拒否の正本である。[認証設計](API-AUTHN-AUTHZ.md)、[MCP OAuth](MCP-OAUTH.md)、[初期導入](../deployment/INITIAL-DEPLOYMENT-FLOW.md)を具体化する。**単一owner製品**であり、未合意の組織管理者、共同編集者、二線レビュアー等のロールを新設しない。

## Principal と所有権

| Principal | credential と成立条件 | 許可される能力 | 明示的な禁止 |
| --- | --- | --- | --- |
| ANON | 未認証。browser/robot | 静的アセット、最小health/metadata、正規share reader入口 | 作品一覧、原稿、管理、MCP、write |
| SETUP | **目標・未実装**。新規DB・owner未登録・承認済み初期構築で発行した256-bit一回限りのgrantと短命setup transaction | 初回本人Passkey ceremonyとowner登録のみ | 通常owner login、原稿、IdP設定、MCP、VM管理 |
| OWNER-SESSION | Better AuthのSame-origin安全なsession。危険操作はfresh reauthentication | Passkey、session、本人のIdP/同意設定、OAuth認可 | cookieを原稿API bearerとして流用しない |
| OWNER-API | Better Auth発行のOAuth access token。issuer/audience/署名/expiry/jti/client/owner subject/`codexia:api`を検証 | PostgreSQL作品の参照・編集・レビュー承認/適用 | MCP登録clientや任意IdP subjectの昇格 |
| MCP-CLIENT | OAuth access token、登録client allowlist、server側project assignment、`mcp:read/compute/propose` | 指定作品の許可effect、提案まで | 直接Persistence、承認・適用、owner-wide通知・認証設定 |
| SHARE-READER | 公開readerの非推測capabilityと公開版/失効の照合 | 明示された公開資源のGETのみ | 下書き・別作品・履歴・private Evidence・mutation |
| EDGE-CI | Cloudflare Service Authによる明示されたread-only identity probe | exact pathだけのHTTP観測 | 作者API、認証同意、作品、運用SSH |
| OPERATOR | protected GitHub Environment、Tailscale OIDC、pinned SSH、別途承認 | IaC、DB保全、秘密管理、配備、Edge policy | Webのowner session/SETUPキーをインフラ資格として利用 |

**認可の判定順序:** mode/method/path → HTTPS/Origin/CORS/CSRF → 証明のissuer・audience・credential状態 → principal分類 → project assignment → 実際のobject/revisionとaction effect → durable transaction条件。**一箇所でも否定・不明ならfail closed**。UIボタンの非表示、Cloudflare Access通過、IDをURLに入力できることは認可の根拠にならない。

## 静的WebのURLと認証境界

| URL | 利用主体と入口契約 | APIで必須の認可 | 目標／現状 |
| --- | --- | --- | --- |
| `/` | ANONがDesktop/Mobileを選択 | 画面選択は認証不要 | 実装済み |
| `/desktop/*` | Ownerの作品・原稿・Knowledge/レビューを表示。Access保護 | OWNER-API / project-object authorization | 実装済み |
| `/mobile/*` | 同一原稿をIonicで操作。`?view=` は表示stateのみ | OWNER-API。同じ保存・認可の正本 | 実装済み |
| `/oauth/login` | 有効なsigned OAuth requestを持つ利用者の認証入口 | OWNER-SESSION、Passkeyかリンク済みOIDC | 実装済み |
| `/oauth/consent` | 登録済みclient/scopeの許可または拒否 | OWNER-SESSION、same-origin、認可要求の検証 | 実装済み |
| `/r/:module/:project/:slug` | 公開linkを受け取ったSHARE-READER。公開する場合のみAccess例外を明示 | share capabilityをAPIが確認し公開版のGETに限定 | 公開reader実装あり／実Edge受入は別 |
| `/console` | ownerの管理home | OWNER-SESSION＋API側owner確認 | **合意済み目標・未実装** |
| `/console/setup` | 初回だけの本人登録ウィザード | SETUP＋DBが新規構築承認済みかつowner未登録 | **合意済み目標・未実装** |
| `/console/security` | Passkey/sessionの本人管理 | OWNER-SESSION＋危険操作のfresh再認証 | **合意済み目標・未実装** |
| `/console/identity` | 連携OIDC、OAuth clients/grantsの管理 | OWNER-SESSION＋owner確認＋対象別権限 | **合意済み目標・未実装** |
| その他 `/console/*` | 404。認可エラーをhomeへ誤誘導しない | なし | 目標 |
| VM/Cloudflare設定 | **専用Web画面を設けない** | OPERATORだけの管理プレーン | 合意済み |

Cloudflare Worker Static Assetsは画面を配信し、API、MCP、OAuth metadataをTunnel経由でFastifyへ通す。**URLごとのAccess policyとWAF除外は明示的に設計・検証する**。author画面のAccess制御を、公開share、setup、必要なOAuth protocolに機械的に継承しない。逆に公開例外は作者API全体へ広げない。静的画面が表示できても、APIから認可済みデータが返ることを意味しない。

## HTTP API: メソッド・資格別の権限マトリクス

| HTTP path/method群 | 必須資格・境界 | 拒否すべき操作 |
| --- | --- | --- |
| `GET /health/*`、`GET /api/version`、`GET /api/browser/version` | ANONから最小readiness/identityのみ。EDGE-CIもexact probe限定 | DB URL、owner/秘密、原稿一覧の露出 |
| `GET /.well-known/oauth-*`、OIDC/JWKS metadata | ANONへ公開プロトコルmetadataのみ | Dynamic Client Registration許可との混同 |
| `/api/auth/oauth2/{authorize,token,revoke}` | Better Auth protocol、登録済みclient、PKCE、exact redirect、audience、grant/token状態 | 未登録client、他IdP token、静的API bearer |
| `POST /api/auth/oauth2/consent-context`、同意決定 | OWNER-SESSION、same-origin、signed request、CSRF | cross-origin、scope逸脱、黙ったauto-consent |
| `/api/auth/*` Passkey/session/consent管理 | OWNER-SESSION。追加削除・ポリシー変更はfresh再認証 | MCP/OWNER-API bearer/SETUPキーを管理セッション化 |
| `GET /api/auth/codexia/setup/status`（目標） | ANONへ機密のない登録可否状態のみ | ownerの存在詳細、grant値の漏えい・cache |
| `POST /api/auth/codexia/setup/authorize`（目標） | owner不在＋NEW_APPROVED、期限内grant、CSRF/Origin、rate limit。短命setup transactionのみ生成 | 普通のAPI bearerやowner session発行、キーreplay、復旧DBでの新規owner |
| `/api/auth/passkey/{generate-register-options,verify-registration}`（setup時・目標） | 短命setup transactionに拘束されたWebAuthn ceremony、RP/origin/UV/challenge、原子的なowner登録＋grant消費 | 部分owner作成、同時登録二重成功、既存ownerの上書き |
| `GET /api/session`、`GET /api/v1/persistence/status` | OWNER-API。workspace認証とDBの独立観測 | 画面stateをowner資格とみなす |
| `GET /api/v1/persistence/projects*` | OWNER-API、毎回project/object scopeを検証 | MCP直アクセス、project列挙 |
| `POST/PATCH/PUT/DELETE /api/v1/persistence/*` | OWNER-API、対象・version/revision・冪等キー・transaction前提 | stale write、他作品、提案による承認迂回 |
| `/api/v1/persistence/projects/:id/{changesets,review-feed}` | 読取はOWNER-API、`approve/reject/apply`は作者の別操作＋最新version | MCP/SETUP/SHAREの判断・適用 |
| `GET /api/projects*`、`GET /api/projects/:id/*` | OWNER-API。またはMCP-CLIENTの`mcp:read`＋server project assignment | clientの申告projectIdだけを信用しない |
| `POST /api/projects/:id/actions/:name` | OWNER-API、またはMCP-CLIENTが許可された`read/compute/propose` effect | action名変更やgeneric dispatch経由の権限上限回避 |
| `POST /api/projects/:id/{proposals,approvals,apply}` | 提案は認可された作者/外部agent。承認・適用はOWNER-APIのみ | MCPの承認・apply、version不一致の適用 |
| `/mcp[?projectId=:id]` | 登録MCP-CLIENT＋OAuth resource/audience、effect scope＋assigned project。複数作品なら明示選択 | owner OAuth clientのMCP流用、他project、作者だけの操作 |
| `GET /api/public/projects/:id/modules/:module/*` | SHARE-READERのcapability、共有版・失効チェック | private drafts、ownerAPI、公開しなかったEvidence |
| `/api/jobs*`、`/api/inbox*`、`/api/projects/events` | OWNER-APIの私有ジョブ/通知/全作品stream | MCPのowner-wide eventや個人通知へのアクセス |
| `OPTIONS /api/*` | 明示したCORS origin/method/headerのみ | preflight 204を認証成功と解釈。cross-origin Cookie |

**重要:** `/api/auth/codexia/setup/*` は合意済みの**目標endpoint名**であり、現行mainで動作していない。公開APIのSchema/operation/状態は実装PRで固定し、Better Authを迂回する別の認証サーバーを作らない。MCPのallowlistとproject assignmentは現状の保護されたサーバー設定が正本であり、認証clientの表示・登録だけを更新しても有効権限を変更したことにしてはならない。

## プロトコル拒否・復旧の契約

| 状態 | HTTP | 画面側の契約 |
| --- | --- | --- |
| 未認証・token期限切れ/失効 | 401＋適切なBearer challenge | 再認証。未保存draftは保持し、前操作を勝手に再実行しない |
| 有効な資格だがprincipal/scope不足 | 403 | 禁止理由を安全に提示。操作を成功扱いしない |
| 存在しない／他作品の非公開資源 | 404（非列挙）または専用403 | 存在の推測を避け、元の画面へ |
| 入力/method/データの無効 | 400/405/422（採用したSchemaに従う） | 該当欄と再入力。二重送信をしない |
| stale version/Revision/ChangeSet | 409/412 | 最新と編集中の内容を並べ、明示判断へ |
| 試行回数超過（初期キー、認証） | 429＋Retry-After | 再試行可能条件を示し、secretは表示しない |
| DB/Auth停止、API draining | 503 | 失効と混同せず回復操作。local journal保持 |
| mutationの応答不明 | receipt照合が確定するまで不明 | 同じidempotency keyで照合。新しい操作を生成しない |
| 公開link失効 | 404/410の合意済み値 | reader内で終了表示し、別の私有URLへ転送しない |

cookie利用のmutationはCSRF/SameSite/Originを検証、cross-origin APIは明示したHTTPS originだけの**bearer-only**とする。機密応答には`Cache-Control: no-store`。setup key、OAuth secret、原稿は静的アセット、query、ログ、監査Pagesのartifactへ送らない。

## 設計の結合・受入条件

[画面・操作台帳](../design/SCREEN-CONTROL-CATALOG.md) のcontrol IDは本書のprincipal・HTTP method・object guardを参照し、[画面ごとの遷移図](../design/SCREEN-STATE-ATLAS.md) と一致する。承認済み設計が画面から呼べても、APIで拒否されなければ未達である。

最低限、ANON/SETUP/OWNER-SESSION/OWNER-API/MCP-CLIENT/SHARE-READER/EDGE-CIを交差実行し、正常・クロス作品・expired・revoked・stale・並列・不正Origin・同時setup・DB障害を実APIで確認する。**PRのCIと実Cloudflare/実VMの受入は別**。検証しない経路をPASSとみなさない。
