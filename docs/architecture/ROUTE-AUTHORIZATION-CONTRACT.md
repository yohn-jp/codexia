# URL・API・principal 別の認証認可設計

**種別: 規範的設計。** 本書は、入口URL、HTTP method、呼出principal、作品/対象資源、デプロイ状態を組み合わせた許可・拒否の正本である。[認証設計](API-AUTHN-AUTHZ.md)、[MCP OAuth](MCP-OAUTH.md)、[初期導入](../deployment/INITIAL-DEPLOYMENT-FLOW.md)を具体化する。**単一owner製品**であり、未合意の組織管理者、共同編集者、二線レビュアー等のロールを新設しない。

## Principal と所有権

| Principal | credential と成立条件 | 許可される能力 | 明示的な禁止 |
| --- | --- | --- | --- |
| ANON | 未認証。browser/robot | 静的アセット、最小health/metadata、正規share reader入口 | 作品一覧、原稿、管理、MCP、write |
| SETUP | **setup-only runtime**。新規DB・owner未登録・承認済み初期構築で発行した256-bit一回限りのgrantと短命setup transaction | 初回本人Passkey ceremonyとowner登録のみ | 通常owner login、原稿、IdP設定、MCP、VM管理 |
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
| `/` | ANONのWeb入口。現行のstart画面はDesktopのみを選択し、`/desktop/`を開く。旧保存値のMobile選択はDesktopへ移行 | 画面入口は認証不要。APIの作者権限は別に検証 | Desktop起動を実装済み |
| `/desktop/*` | Ownerの作品・原稿・Knowledge/レビューを表示。Access保護 | OWNER-API / project-object authorization | 実装済み |
| `/mobile/*` | 旧Ionic React Mobile authoringの撤去済みroute。現行製品の入口ではなく、互換維持なし | 有効な作者APIは引き続きOWNER-APIで認可。Native iOSは別アプリ入口・同じAPI認可 | 現行routeなし |
| `/oauth/login` | 有効なsigned OAuth requestを持つ利用者の認証入口 | OWNER-SESSION、Passkeyかリンク済みOIDC | 実装済み |
| `/oauth/consent` | 登録済みclient/scopeの許可または拒否 | OWNER-SESSION、same-origin、認可要求の検証 | 実装済み |
| `/r/:module/:project/:slug` | 公開linkを受け取ったSHARE-READER。公開する場合のみAccess例外を明示 | share capabilityをAPIが確認し公開版のGETに限定 | 公開reader実装あり／実Edge受入は別 |
| `/console` | ownerの管理home | OWNER-SESSION＋API側owner確認 | Desktop Web 実装あり。Cloudflare・VM 受入は別 |
| `/console/setup` | 初回だけの本人登録ウィザード | SETUP＋DBが新規構築承認済みかつowner未登録 | 実装済み。Cloudflare・VM 受入は別 |
| `/console/security` | Passkey/sessionの本人管理 | OWNER-SESSION＋危険操作のfresh再認証 | Desktop Web 実装あり。実 Edge 受入は別 |
| `/console/identity` | 連携OIDC、OAuth clients/grantsの管理 | OWNER-SESSION＋owner確認＋対象別権限 | 運用者の OIDC 設定状態の表示と保存済み OAuth 同意の参照、取消しを実装。所有者による OIDC 設定は採用目標 |
| `/console/backups` | S3保管先設定、remote保全・復元証拠、手動保全要求 | OWNER-SESSION、危険変更はfresh reauth | Desktop Web 実装、運用受入は別 |
| `/console/backups/destination` | S3 draftとwrite-only secretの設定 | OWNER-SESSION。credential登録と有効化はfresh | Desktop Web 実装、運用受入は別 |
| `/console/backups/verification` | 接続試験、probeとactiveの独立結果照合 | OWNER-SESSION。activationはfresh | Desktop Web 実装、運用受入は別 |
| `/console/backups/history`、`/console/backups/recovery` | 保全receipt、隔離復旧の**表示のみ** | OWNER-SESSION | Desktop Web 実装、運用受入は別 |
| その他 `/console/*` | 404。認可エラーをhomeへ誤誘導しない | なし | 目標 |
| VM/Cloudflare設定、本番データ復元 | **専用Web画面を設けない** | OPERATORだけの管理プレーン。例外としてS3保管先/保全要求はowner consoleからtyped APIで指定可能だがVM操作権限ではない | 合意済み |

Cloudflare Worker Static Assetsは画面を配信し、API、MCP、OAuth metadataをTunnel経由でFastifyへ通す。**URLごとのAccess policyとWAF除外は明示的に設計・検証する**。author画面のAccess制御を、公開share、setup、必要なOAuth protocolに機械的に継承しない。逆に公開例外は作者API全体へ広げない。静的画面が表示できても、APIから認可済みデータが返ることを意味しない。

バックアップ API と executor はオペレーターが有効にする。
S3 保全と独立復旧の受入には、それぞれの環境での証拠が必要となる。[Backup console contract](BACKUP-CONSOLE-CONTRACT.md)

## HTTP APIの認可マトリクス

[TypeSpecで定義するワイヤ契約](../../packages/http-contract/src/main.tsp) はmethod/pathと資格のHTTP上の表現を定める。
同じbearer形式でも、許可するprincipalや作品はこの表と個別の規則で決まる。
静的APIリファレンスは契約を表示し、アクセスの許可はAPIの入場制御と業務処理が判断する。

| HTTP path/method群 | 必須資格・境界 | 拒否すべき操作 |
| --- | --- | --- |
| `GET /health/*`、`GET /api/version`、`GET /api/browser/version` | ANONから最小readiness/identityのみ。EDGE-CIもexact probe限定 | DB URL、owner/秘密、原稿一覧の露出 |
| `GET /.well-known/oauth-*`、OIDC/JWKS metadata | ANONへ公開プロトコルmetadataのみ | Dynamic Client Registration許可との混同 |
| `/api/auth/oauth2/{authorize,token,revoke}` | Better Auth protocol、登録済みclient、PKCE、exact redirect、audience、grant/token状態 | 未登録client、他IdP token、静的API bearer |
| `POST /api/auth/codexia/owner-session` | 通常APIのOWNER-SESSION、正確なsame-origin、空のJSON object | bearer、setup専用モード、owner以外、セッション情報の開示 |
| `POST /api/auth/oauth2/consent-context`、同意決定 | OWNER-SESSION、same-origin、signed request、CSRF | cross-origin、scope逸脱、黙ったauto-consent |
| `/api/auth/*` Passkey/session/consent管理 | OWNER-SESSION。追加削除・ポリシー変更はfresh再認証 | MCP/OWNER-API bearer/SETUPキーを管理セッション化 |
| `GET /api/auth/codexia/owner-security/oidc`、同じリソースの `POST /{stage,link,activate,disable,remove}` | OWNER-SESSION。更新は exact Origin、CSRF、fresh再認証。各操作で対象 revision と許可済み issuer を検証する。[Owner OIDC 契約](OWNER-OIDC-MANAGEMENT-CONTRACT.md) | 管理用 bearer、operator 許可範囲外の登録、無検証の有効化、Better Auth の provider 管理 API への公開アクセス |
| `POST /api/auth/sign-in/sso`、`GET /api/auth/sso/callback/codexia-owner-oidc` | 通常ログインは同一 origin と固定 provider key。callback は Better Auth が検証した state と、候補の紐付け時には開始した owner session を照合する | ブラウザー指定の任意 provider、任意の戻り先、未検証の state での紐付け |
| `GET /api/auth/codexia/setup/status` | ANONへ機密のない登録可否状態のみ | ownerの存在詳細、grant値の漏えい・cache |
| `POST /api/auth/codexia/setup/authorize` | owner不在＋NEW_APPROVED、期限内grant、CSRF/Origin、rate limit。短命setup transactionのみ生成 | 普通のAPI bearerやowner session発行、キーreplay、復旧DBでの新規owner |
| `GET /api/auth/passkey/generate-register-options`、`POST /api/auth/passkey/verify-registration`（setup時） | 短命setup transactionに拘束されたWebAuthn ceremony、RP/origin/UV/challenge、原子的なowner登録＋grant消費 | 部分owner作成、同時登録二重成功、既存ownerの上書き |
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
| `GET /api/console/backups/{status,config,runs,recovery}`と `GET /api/console/backups/config/probes/:id` | **OWNER-SESSIONのみ**。CSRF/Origin、server owner subject、no-store。実行resultは別途receipt照合 | OWNER-API bearer、MCP-CLIENT、SETUP、ANON、SHARE-READER、EDGE-CI、secret平文返却 |
| `PUT /api/console/backups/config/draft` | OWNER-SESSION＋fresh（credential登録時）、If-Match revision、write-only secretとoperator allowlist | 認証不足、任意S3 endpoint egress、任意VM path、Podman/SSH/Ansible引数、秘密再取得 |
| `POST /api/console/backups/config/{probes,activate,disable}` | OWNER-SESSION。activate/disableはfresh再認証、probeとrevision一致、必要な確認。全operationはbounded requestとdurable receipt | 未検証設定のactive化、required off-VM不成立で無承認disable、S3 object削除・IAM管理 |
| `POST /api/console/backups/runs` | OWNER-SESSION＋fresh・writer停止の影響確認。202はdurable request受付のみ | MCP/外部OAuth bearerからのbackup要求、実行未確認の成功、任意コマンドや本番restore |
| `OPTIONS /api/*` | 明示したCORS origin/method/headerのみ | preflight 204を認証成功と解釈。cross-origin Cookie |

`POST /api/auth/codexia/setup/profile` は正当な短命setup transactionをプロフィールに拘束する。`POST /api/auth/codexia/setup/complete` は確定したownerと一致する登録transactionだけで、事前承認済みOAuth clientの確認を再試行する。いずれも通常のBetter Auth認可には使わない。MCPのallowlistとproject assignmentは現状の保護されたサーバー設定が正本であり、認証clientの表示・登録だけを更新しても有効権限を変更したことにしてはならない。

## 個別APIルートの認可表（wildcardではなく最終一致規則）

上記の`/api/projects/:p/*`は**一律のMCP read許可ではない**。以下の個別path/methodが上位の包括規則より優先する。`p`はプロジェクトUUID、`d`は文書ID、`a`はAnchor/Assertion ID、`n`はKnowledge ID、`c`はChangeSet ID。`O` = OWNER-API、`M-R` = MCP-CLIENTの`mcp:read`＋server割当、`M-P` = MCP-CLIENTの`mcp:propose`＋server割当。MCPからの直接Persistenceはすべて403であり、下の「O」はMCPが読むことを意味しない。

### Core APIとモジュール

| method・path | 許可principal / 条件 | 特別な制約・UI |
| --- | --- | --- |
| `GET /api/projects` | O / M-R | MCPは割当済み作品のみをページング・列挙 |
| `POST /api/projects` | O | titleの検証、新規作成は作者のみ |
| `GET /api/review-queue` | O / M-R | Mは私有提案を除外。author reviewは別 |
| `GET /api/projects/:p` | O / M-R | 同じprojectのobserveまで |
| `GET /api/projects/:p/{tree,history,status,observation}` | O / M-R | 固定project/version、存在しないsnapshotを現在値で代替しない |
| `GET /api/projects/:p/scenes/:d` | O / M-R | canonical document・snapshot境界、本文・根拠の可視範囲を限定 |
| `GET /api/projects/:p/snapshot?projection=editor` | O / M-R | project/versionの一致と有効documentを照合 |
| `GET /api/projects/:p/{modules,contributions}` | O / M-R | 有効profileと宣言済みcapabilityのみ |
| `GET /api/projects/:p/manuscripts/:d/snapshots`、`GET .../snapshots/:revision` | O / M-R | 要求した履歴版の到達可能性とbyte limit |
| `GET /api/projects/:p/{search,writing-stats}` | O / M-R | 検索語、結果・snapshotを制限 |
| `GET /api/projects/:p/recent-activity` | **Oだけ** | 作者の私有閲覧/執筆位置。MCPは403 |
| `PUT /api/projects/:p/recent-activity` | **Oだけ** | client order/generation検証。MCPは403 |
| `GET /api/projects/:p/actions` | O / M-R | Mには許されたeffectだけを公開 |
| `POST /api/projects/:p/actions/:actionId` | O / M-R/M-P/`mcp:compute`に対応するeffect | effectとsnapshot双方をサーバーで検査。MはAssistant/author-only拒否 |
| `GET /api/projects/:p/{proposals,proposals/:id,review-queue}` | O / M-R | Mはprivate proposalを除外し、他project参照不可 |
| `POST /api/projects/:p/proposals` | O / M-P | 版固定・proposal identity/冪等性・read/write set |
| `POST /api/projects/:p/approvals` | **Oだけ** | authorScopeとoperationIdsの承認 |
| `POST /api/projects/:p/apply` | **Oだけ** | 承認前提とDB receipt。MCPは403 |
| `POST /api/projects/:p/scratch` | **Oだけ** | 保存に影響するauthor-only操作 |
| `/api/projects/:p/modules/:module/*` | **Oが既定**。MはMCP transportの許可された`mcp` contributionのみ | moduleごとの宣言access/effect/methodを検査。AssistantをMから拒否 |
| `GET /api/jobs`・`GET /api/jobs/:id`・`GET /api/jobs/events` | **Oだけ** | job history/streamをMCPに漏らさない |
| `GET /api/inbox`・`POST /api/inbox/:id/read`・`POST /api/inbox/read-all` | **Oだけ** | 通知閲覧・既読は本人のみ |
| `GET /api/projects/events` | **Oだけ** | owner全作品stream。MCPは403 |
| `GET /api/public/projects/:p/modules/:module/*` | SHARE-READER | そのcontributionがpublic/readかつ正しいshare capabilityのGET。private APIの権限は付与しない |

### PostgreSQL persistence（全行がOWNER-API専用）

| method・path | 入場後に必要な資源・競合検査 |
| --- | --- |
| `GET /api/v1/persistence/status` | 認証されたownerのDB状態だけを示す |
| `GET /api/v1/persistence/projects` | ownerのproject一覧と正しいcursor |
| `POST /api/v1/persistence/projects` | 新規projectとtitle/設定の検証 |
| `POST /api/v1/persistence/import` | portable JSONのschema/hash/referenceを原子的に検証、既存作品に上書きしない |
| `GET /api/v1/persistence/projects/:p` | ownerのproject IDを確認 |
| `PATCH /api/v1/persistence/projects/:p` | expectedVersionとname/settingsの検証 |
| `GET /api/v1/persistence/projects/:p/archive` | 固定snapshotの現在状態をexport |
| `GET /api/v1/persistence/projects/:p/open-export` | 実行枠の取得前に作品へのアクセスを確認し、固定スナップショットから完全な ZIP を取得する。送信前に認証と作品へのアクセスを再確認する。[離脱用 ZIP の実装契約](OPEN-WORK-EXPORT-CONTRACT.md) |
| `GET /api/v1/persistence/projects/:p/documents` | 同じprojectの親/並びと取得上限 |
| `POST /api/v1/persistence/projects/:p/documents` | 親とpath、idempotency、本文の新規Revision |
| `GET /api/v1/persistence/projects/:p/documents/:d` | document/revisionが当該projectに属する |
| `PATCH /api/v1/persistence/projects/:p/documents/:d` | baseRevision、sha256、idempotency、保存receipt |
| `PATCH /api/v1/persistence/projects/:p/documents/:d/metadata` | expectedVersionと木の非循環性 |
| `DELETE /api/v1/persistence/projects/:p/documents/:d` | expectedVersion、明示的な削除、履歴保全 |
| `GET /api/v1/persistence/projects/:p/documents/:d/revisions` | immutable履歴とcursor/対象限定 |
| `POST /api/v1/persistence/projects/:p/documents/:d/restore` | 過去Revisionを新Revisionとして復元、冪等化 |
| `GET/POST /api/v1/persistence/projects/:p/documents/:d/anchors` | Revision一致、quote/rangeと登録権限 |
| `PATCH /api/v1/persistence/projects/:p/documents/:d/anchors/:a` | Anchor ID/currentRevision/versionを再検証 |
| `POST /api/v1/persistence/projects/:p/documents/:d/anchors/:a/mentions` | Evidenceとnodeが同一projectに属しconfirmed状態が整合 |
| `POST /api/v1/persistence/projects/:p/documents/:d/anchors/:a/assertions` | owner判断、EvidenceとAssertionの結合 |
| `GET /api/v1/persistence/projects/:p/nodes` | Knowledge一覧、filter/cursor/snapshotを固定 |
| `GET/PUT /api/v1/persistence/projects/:p/nodes/:n` | node同一性、version、作者が確認したstatus |
| `POST /api/v1/persistence/projects/:p/nodes/:n/{merge-preview,merge}` | previewDigest、targetID、projectVersion、明示confirm |
| `POST /api/v1/persistence/projects/:p/nodes/:n/{aliases,relations}` | source/targetとproject境界、曖昧名を自動確定しない |
| `GET /api/v1/persistence/projects/:p/nodes/:n/evidence` | node/anchorを同じsnapshotの根拠で返す |
| `GET/PUT /api/v1/persistence/projects/:p/assertions/:a` | assertion status/version・source ID・スコープを検査 |
| `GET/POST /api/v1/persistence/projects/:p/assertions/:a/evidence` | 根拠の属するprojectと役割を検証 |
| `GET/POST /api/v1/persistence/projects/:p/changesets` | 閲覧と提案を分け、POSTはactor・operation set・冪等性 |
| `GET /api/v1/persistence/projects/:p/changesets/:c` | 当該projectに属するChangeSetのみ |
| `POST /api/v1/persistence/projects/:p/changesets/:c/{approve,reject,apply}` | **それぞれ別操作**。owner・最新expectedVersion・適用前read/write setを確認 |
| `GET /api/v1/persistence/projects/:p/review-feed` | owner以外に非公開のレビュー資料を返さない |

本表の`{a,b}`や`GET/POST`は記法上の短縮であり、単一の曖昧なwildcard route実装を要求しない。バックエンドは実際に宣言したmethod/pathと対象IDを認証後に解釈し、未列挙methodを`405`、未定義pathを`404`で拒否する。**この表が広いprefixにMCP readを認めるものではない。**


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

### バックアップ専用操作の分離

`BKC-001`〜`BKC-010`の全method/path・入力/結果・proxy境界は [Backup console contract](BACKUP-CONSOLE-CONTRACT.md) が詳細化する。owner sessionを検証したFastify APIは、専用の運用schemaへ**設定・durable request**だけを書き、実際のS3送受信・writer停止・host lock・backup.sh・復元はoperator provisioned executorへ委任する。Web APIで秘密鍵を読取/配布したり任意のshell実行を行わせない。S3 provider egress allowlistとTLS/SSRF保護はAPI入力検証だけでなくexecutorでも独立に強制する。

**否定テスト:** ANON、OWNER-API、MCP-CLIENT（mcp:propose含む）、SETUP、SHARE-READER、EDGE-CIのすべてで`/api/console/backups/*`を拒否。owner sessionでもCSRF、Origin、古いrevision、古いprobe、credential未登録、reauth期限切れ、required保存先disable、二重run、unknown endpointは拒否し、秘密/API成功状態/遠隔削除を漏らさない。
