# 外部インターフェース・信頼境界契約

**種別: 規範的外部IF設計。** Codexiaの境界を越える通信・配布・資格情報・データ交換・障害/回復を、インターフェースごとに一意のIDで追跡する。サービスの機能・責務は [System design](SYSTEM-DESIGN.md)、principal別の認可は [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md)、OAuth/MCPは [API AuthN/AuthZ](API-AUTHN-AUTHZ.md) / [MCP OAuth](MCP-OAUTH.md)、初期導入・更新は [Deployment](../deployment/README.md)、[Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md)、[Update flow](../deployment/UPDATE-FLOW.md) が正本である。ここに別の認証系や代替管理プレーンを発明しない。

以下は設計と関連設定/コードの所在を確認する契約台帳であり、本番のCloudflare/Tailscale/IdP/GHCRに実際に接続し、正常/異常を受入した証拠ではない。

## インターフェースIDと責務

| ID | 通信・データの向き | protocol / 入口 | 資格・境界 | 正本・実装の所有先 |
| --- | --- | --- | --- | --- |
| EXT-EDGE-001 | Browser → Cloudflare Workers Static Assets | HTTPS /、/desktop/*、/oauth/*、/console/*。旧`/mobile/*`routeは現行の製品配信に含めない | AccessでUI入口を保護。ただしUIのAccess認証はAPIのproject認可にならない | [Deployment](../deployment/README.md)、deploy/cloudflare/ui-routes.json、app/ |
| EXT-EDGE-002 | Browser/iOS/MCP client → Cloudflare Tunnel → VM Fastify | HTTPS /api*、/health*、/mcp*、/.well-known/* | TLS/Edge audienceとアプリ内OAuth・resource authorizationを分離 | deploy/cloudflare/ui-routes.json、public-protocol-paths.json、packages/api/src/server.ts |
| EXT-AUTH-001 | Browser/iOS → Codexia Better Auth | OAuth 2.0 code + PKCE S256、sign-in/consent、JWKS/metadata | 登録済みpublic client、exact redirect URI、issuer/audience、session/CSRF | [Auth](API-AUTHN-AUTHZ.md)、packages/api/src/better-auth.ts、app/src/oauth.ts |
| EXT-AUTH-002 | Better Auth ↔ optional external OIDC IdP | OIDC discovery、authorization、callback、token/identity | 外部IdP credentialをCodexia API bearerとみなさない。設定なしでもPasskey利用可能 | [Auth](API-AUTHN-AUTHZ.md)、packages/api/src/auth-mode.ts、better-auth.ts |
| EXT-MCP-001 | External AI client → Codexia /mcp | OAuth protected resource + MCP 2026-07-28 Streamable HTTP / JSON-RPC | 登録MCP client、assigned project、mcp:read/compute/proposeのみ。approval/apply禁止 | [MCP OAuth](MCP-OAUTH.md)、packages/api/src/oauth-mcp.ts、modules/mcp/src/http.ts、tools/ |
| EXT-MCP-002 | Local trusted MCP adapter → Core actions | MCP stdio | 運用実行環境のtrusted identityと同一Core action/effect。別writer禁止 | [Modules](MODULES.md)、modules/mcp/src/stdio.ts、tools.ts |
| EXT-DB-001 | VM API/Core → PostgreSQL | pg protocol/transaction、別schema | public author dataはPostgreSQL正本。auth schemaとroleを分離 | [DB detail](DATABASE-DETAIL-CONTRACT.md)、packages/persistence-postgres/src/postgres-store.ts、packages/api/src/auth-schema.ts |
| EXT-OPS-001 | GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → VM | private control-plane SSH / declarative deployment | protected environment、host key pin、release certificate。Cloudflare公開面を管理SSHに流用しない | [Deployment](../deployment/README.md)、deploy/ansible/、.github/workflows/backend-deployment-handoff.yml |
| EXT-OPS-002 | GitHub Actions ↔ GHCR / frontend Workers release | registry / CI artifacts / Cloudflare API | exact-source certification、immutable digest、separate component releasesと権限 | [CI/CD](../verification/CI-CD.md)、.github/workflows/backend-release.yml、frontend-release.yml |
| EXT-OPS-004 | Owner browser console → Fastify /api/console/backups/* → restricted backup executor | owner session protected HTTPS、運用schemaの設定/ジョブ/receipt。オペレーターが API と executor を有効化 | S3 destinationだけをownerが指定。APIはVM/SSH/IAM/operator credentialを渡さない。任意RPC・SSRF・MCP bearer不可 | [Backup console](BACKUP-CONSOLE-CONTRACT.md)、[Admin UI](../design/ADMIN-SCREEN-FLOW.md)、[Route auth](ROUTE-AUTHORIZATION-CONTRACT.md) |
| EXT-OPS-003 | VM/backup job → local/remote backup保護先・**S3互換オブジェクトストレージ**と隔離restore | age encrypted backup/restore、S3 HTTPS API。実 S3 と独立復旧ホストでの運用受入を要する | 原稿・認証・host historyの扱い、鍵・宛先・保管/復旧権限を分離。S3 writerに削除権限を与えない | [Backup](../deployment/BACKUP.md)、deploy/backup/、.github/workflows/push-backup.yml |
| EXT-SHARE-001 | Reader → 公開コンテンツAPI | HTTPS GET /api/public/projects/:p/modules/:module/* | share capability、公開版、失効確認。原稿/private Evidenceへ到達禁止 | [Publishing](../design/PUBLISHING.md)、[Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md) |
| EXT-IOS-001 | **Target**: Installed native iOS SwiftUI → Codexia API/OAuth | HTTPS/Swift typed client from shared OpenAPI、OS OAuth public client/PKCE callback、URLSession | bundleにclient secretを埋め込まない、Keychain refresh、native protected journal、同一Core/API権限 | [iOS SwiftUI](IOS-SWIFTUI-ARCHITECTURE.md)、[delivery](../deployment/IOS-CLIENT.md)（iOS実装・受入は未完了。Retired Capacitor bridge removed） |

この台帳には認証が成功した/通信可能であるという判定を含めない。EXT-OPS-003の具体的な保管先など、保護情報は公開Markdownへ平文で書かない。Secretの**名称、責任、参照元、更新/失効方式**を記述し、値は環境のsecret managerに置く。

## Edge routeとpublic protocolの契約

- deploy/cloudflare/ui-routes.jsonの観測値: 静的Workerは /*、originへ除外するroute familyは /api*、/health*、/mcp*、/.well-known/*。このroute定義はEdge公開の候補経路であり、API側のmethod/認可を保証しない。
- deploy/cloudflare/public-protocol-paths.json は /mcp、OAuth protected-resource metadata、authorization-server metadata、OIDC discovery、authorize/token/introspect/revoke/userinfo/consent/JWKS、Passkey authentication、OIDC callback等の**公開protocol pathsの一覧**。GET/POST等の実methodとpayloadはBetter Auth/API実装との照合が必要。
- /oauth/login、/oauth/consentと静的assetsはWorkers側のUI。OAuth protocol endpointはAPI側。ブラウザーCookie・sessionを作品APIの長期tokenとして使わない。
- /console、/console/setup、/console/security、/console/identityは**採用済みの将来UI目標**。setup-only APIも現行実装済みと誤認しない。
- 任意のCORS originを安全とみなさず、same-originと例外の正規宣言、Origin/CSRF/PKCEをそれぞれ検証する。
- Health/metadataはsecret、project名、token、owner識別情報を返さない。GETできることがowner認可の証拠とはならない。

**必要な検証:** Terraform/Access/Tunnelとui-routes.jsonの差分、path precedence、query付き/末尾slash/不正method、metadata公開とAPI私有pathの拒否、ownerでないブラウザー・MCP clientでのBOLA、Access停止時のsafe failure。現時点で本番実設定との突合は未確認。

## OAuth / OIDC / MCPの具体契約

### EXT-AUTH-001 と EXT-AUTH-002

- 認証する主体とtoken issuerを明示する。外部OIDCはBetter Auth本人確認の入力であり、外部のID tokenやaccess tokenをCodexia API admissionへ直接渡さない。
- downstream API bearerはCodexia Better Auth発行で、issuer、audience、exp、jti、client、owner subject、scope等をAPI側で照合する。signatureだけで権限は成立しない。
- Browser/iOSはpublic client、Authorization Code + PKCE S256。registered redirect exact-match、同意、revocation、token refreshと期限切れを検証する。
- upstream OIDC未設定、provider障害、callback不整合、Passkeyキャンセル、refresh失敗時も原稿local journalを黙って破棄しない。
- 現行のenv設定と配置は packages/api/src/environment.ts、auth-mode.ts、better-auth.ts、deploy/ansible/auth-runtime.env.j2、[Auth runbook](../../deploy/ansible/AUTH-RUNTIME.md)。secretの値をドキュメントやPagesへ公開しない。
- [API contract](API-CONTRACT.md)でHTTP method、body/schema、auth response/errorを全件展開する。library-managed endpointはインストールされたversionの仕様と照合する。

### EXT-MCP-001 と EXT-MCP-002

- OAuth resource/audienceは設定されたAPI resourceであって任意のproject URLではない。single-assigned projectは /mcp、複数assigned projectは /mcp?projectId=:assigned-id で一つを選ぶ。
- client allowlistとserver側project assignmentは packages/api/src/oauth-mcp.tsおよび環境設定が認可を所有する。client自己申告projectだけで権限を決めない。
- permitted effectは read / compute / propose。approval/apply、作者のrecent-activity、inbox、管理設定、直接PersistenceはMCPから拒否する。
- Tool名、入力/出力Schema、権限、snapshot、エラー、timeout、replay、処理上限の物理一覧は modules/mcp/src/tools/ のregistrarとshared action descriptorから抽出し、将来のschemaツールで実装と突合する。
- HTTP と stdio は公式 SDK v2 の共通サーバーファクトリーからツールを登録し、認可済み Core action を呼ぶ。
  プロトコルの採用版と互換期限は [MCP 移行設計](MCP-V2-MIGRATION.md) に従う。
  HTTP への接続後もツールごとの effect を判定する。内部 LLM 実行の拡張は凍結する。
- 代表検証候補は tests/integration/mcp-acceptance.test.mjs と packages/api/src/oauth-mcp.test.ts。各toolのpositive/negative境界まで証明できるかは別途監査する。

## 配備・registry・backup外部IFの受入

| IF | 正常動作に必要な観測点 | 失敗・復旧の検証 |
| --- | --- | --- |
| EXT-OPS-001 | certified commitと署名されたhost identity、許可された環境、Ansible収束、VMのhealthy API・DB | SSH/Tailscale失敗で変更しない、host key mismatchを拒否、失敗したdeployの状態・再実行を判定 |
| EXT-OPS-002 | exact-source artifactとGHCR image digest、Frontend/Backendのepoch/persistence互換 | 古い/不明/誤digestやschema違いを拒否、未認定mainを昇格しない |
| EXT-OPS-003 | 鍵の権限、バックアップ内容と保存先の保護、**S3互換bucketへのage暗号文転送・checksum検証・再取得**、リストア後のfingerprintと原稿/認証の一致 | 破損・鍵欠落・復旧先違い・古いbackup・S3転送中断・資格情報失効は安全停止。S3は追加のオフVM保管先でありDB正本ではない。コンテナー戻しとDB restoreを混同しない |
| EXT-SHARE-001 | 有効なshare capabilityと公開版のreadのみ | 期限切れ・撤回・別project・private Evidence・method違反を拒否 |
| EXT-IOS-001 | OAuth callbackとToken scope、UIから同じAPI/Revisionへの到達 | OS認証中止、復帰、token失効、local draft保持、物理端末での再検証 |

Secretsの実値、production owner data、実認証token、バックアップ機密のテスト出力は禁止する。公開CIではsynthetic dataと隔離DB/hostを使う。現物への変更/公開をこの文書の追加だけで許可しない。

## Interface recordの必須フィールド（網羅化時）

全IFについて最低限、ID、sender、receiver、protocol/version、入口FQDN/route、認証主体/秘密の供給先、request/response Schemaまたは交換形式、timeout/retry/idempotency、正常結果、失敗/遮断/回復、データ分類/保管・廃棄、ログ/監視、owner、実装/設定パス、テストID/実行証拠、現行/目標/廃止を記録する。

全外部IFのendpointと交換payload・roleの**網羅照合は未実施**。接続設定を列挙しただけでVERIFIEDとしない。追加の外部サービス/SDKや管理プロトコルは採用済み要求への対応を先に記録する。

## ツール導入の前提

**採用済み目標:** [Toolchain](SPECIFICATION-TOOLCHAIN.md)、[HTTP platform](HTTP-PLATFORM-MIGRATION.md)、[MCP v2](MCP-V2-MIGRATION.md)、[Tooling acceptance](../verification/SPECIFICATION-TOOLING-ACCEPTANCE.md)。外部IFは実際のプロトコルに適したschema/宣言を維持し、TypeSpec/OpenAPIをMCPやTerraformの第二正本として強制しない。LikeC4は構成図、Threagileは脅威リスク、既存Mermaidは画面/状態遷移を所有する。上記のEXT-EDGE-002に記したFastifyは**継続採用する実行基盤**。TypeSpec/OpenAPIと明示的Fastifyルートへの移行は未実装。各ツールは未導入・未検証であり、仕様上の主体・権限・管理経路を変更しない。
