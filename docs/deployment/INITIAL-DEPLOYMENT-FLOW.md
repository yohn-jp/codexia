# 初期デプロイの遷移設計

新規 VM を Ansible で構成し、Cloudflare Workers の `/console/setup` から登録キーと Passkey で初回所有者を登録する。
本書は、新規 VM の構築から PostgreSQL、本人認証、API の公開までの状態、遷移、停止条件を定める規範的設計である。[本番Deploymentライフサイクル](DEPLOYMENT-LIFECYCLE.md) が全状態の経路選択、初回Backend activation、保守・復旧・排他の横断契約を所有する。
SSH ポートフォワード方式も移行中の運用手順として利用できる。[システム基本設計](../architecture/SYSTEM-DESIGN.md) [IaC](IAC.md) [Push deployment](PUSH-DEPLOYMENT.md) [Ansible 運用](../../deploy/ansible/README.md) [認証初期化](../../deploy/ansible/AUTH-RUNTIME.md)

## 初期構築・公開までの状態遷移

[グラフィカルな遷移図を開く](https://yohn-jp.github.io/codexia/architecture/#first-1)

```mermaid
flowchart TD
    PRE["VMはAnsibleからSSH接続可能<br/>sudo・適合OS・管理経路あり"] --> INPUT["private inventory / ホスト鍵pin / Secrets供給<br/>新規 or 既存復旧モードを宣言"]
    INPUT --> CHECK{"inspect: 対象・DB/volume・復旧意図は一致?"}
    CHECK -->|不明/不一致| STOP1["停止: 既存状態を破棄・初期化しない"]
    CHECK -->|はい| BOOT["Ansible bootstrap<br/>host → secrets → base → auth-runtime"]
    BOOT --> DB{"正本のDB状態"}
    DB -->|空・新規構築を承認済み| EMPTY["初回登録待機状態へ"]
    DB -->|既存ownerを復旧済み| RESTORED["既存owner/Passkey/clientを検証<br/>新しい初期キーは生成しない"]
    DB -->|復旧途中/不整合| STOP2["停止: 復旧が先<br/>セットアップ画面でownerを再作成しない"]
    EMPTY --> GRANT["CSPRNG 256-bitの一回限りキーを発行<br/>hash保存・秘密経路で所有者に渡す"]
    GRANT --> SETUPONLY["通常Frontend + 同じFull Backendのsetup-only API<br/>既存Access・Tunnel経路"]
    SETUPONLY --> KEY["所有者本人: ブラウザーでキー入力"]
    KEY --> PASS{"キー検証・WebAuthn Passkey ceremony"}
    PASS -->|中断・期限切れ・競合| RETRY["状態再照合・必要なら明示再発行<br/>owner二重作成は拒否"]
    RETRY --> KEY
    PASS -->|APIで原子的に確定| OWNER["owner ID・Passkey・grant失効を確定"]
    OWNER --> CLIENT["認証済みsetup APIでWeb/iOS/内省client照合"]
    CLIENT -->|不整合| STOP3["停止: 本番公開しない<br/>登録結果の再検証"]
    CLIENT -->|準備完了| PREP["保護されたactivation preparation<br/>setup-only停止・初回本番配備承認待ち"]
    RESTORED --> PREP
    PREP --> CERT{"認証済みmain Full digest/証明書<br/>互換Frontend・DB/認証/バックアップ/公開承認OK?"}
    CERT -->|いいえ| STOP4["停止: セットアップ以外の業務APIは公開しない"]
    CERT -->|はい| DEPLOY["保護された初回activation・暗号化backup<br/>互換UIを再確認してBackend deploy"]
    DEPLOY --> HEALTH{"API・認証・Tunnel・UI正常?"}
    HEALTH -->|いいえ| STOP5["停止/切戻し・transaction復旧<br/>owner DBは初期化しない"]
    HEALTH -->|はい| ACT["setup APIの登録権限を無効化<br/>通常のownerログイン・/consoleへ"]
    ACT --> ACCEPT{"VM reboot / 公開経路 / 独立restoreを実測?"}
    ACCEPT -->|いいえ| PARTIAL["稼働と本番受入を区別して記録"]
    ACCEPT -->|はい| DONE["初期導入受入完了・初回承認解除"]
```

**DB の空状態と既存状態は別の分岐**である。未知の volume を新規クラスタとして初期化し直さず、既存環境の資格情報を暗黙に置換しない。公開画面から実行するデプロイではなく、認可された運用者による導入である。

## 収束ステージ・所有権・障害時の動作

| 遷移 | 実行権限・入力 | 成功判定 | 失敗時 |
| --- | --- | --- | --- |
| `bootstrap` | 既存 bootstrap管理者、承認済み private inventory | host/secrets/base と許可した auth-runtime を順序どおり収束 | 途中で失敗した状態を観測し、同じ inventory の明示的な再適用に限定 |
| `inspect` | bootstrap またはサービス利用者、private inventory | サポート対象 OS、所有 ID、既存資源の観測 | 読取専用で中断 |
| `host` | 必要な sudo とアカウント作成承認 | rootless user、Podman/systemd 条件 | UID 衝突や既存 unit の予期せぬ自動起動を拒否 |
| `secrets` | mode 0400/0600 の保護 credential ファイルと承認 | Podman secret の内容・所有が一致 | 不足・異なる secret を自動修復・rotation しない |
| `base` | network/volume/PG/Tunnel の所望状態 | 固定 volume、Podman、PostgreSQL 17 の同一性 | 既存 DB・container drift を拒否 |
| `auth-runtime` | 審査済み Full digest、DB・認証初期化承認 | 原稿 migration ledger、別 auth role/schema、秘密設定 | API は非公開のまま停止 |
| 初回キー発行 | Ansibleの承認済み新規構築、空の正本DB、CSPRNG | 256-bit一回限りキーのハッシュ保存、期限と配送先の明示、setup-only入口の検証 | 既存owner・復旧中なら発行禁止。ログ/CI artifactに平文キーを出さない |
| owner・client 登録 | Workersの`/console/setup`、有効な初期キー、本人のWebAuthn | Better Authの永続owner、Passkey、Web/iOS/内省client照合。キー即時失効 | 中断・再送・競合でもowner一人。未完成時は業務APIを有効化しない |
| `deploy` | protected GitHub Environment と証明済み Full digest | migration・auth・origin・API ready | durable transaction record に従い復旧 |
| 公開受入 | 実 VM、Cloudflare、実ブラウザー、独立復元ホスト | API・OAuth・reboot・バックアップの観測 | fixture 成功だけで受入扱いしない |

管理経路は **GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → rootless Podman Quadlet**。公開 UI/認証入口は Cloudflare **Workers Static Assets**、API origin は Cloudflare Tunnel。`/console`と`/console/setup`は通常の `codexia-frontend` Worker の同じFull静的アーカイブ・Desktopアプリルートであり、登録キー検証はVMのFastify/Better AuthとPostgreSQLが担当する。初回登録専用Worker・Environment・Terraform経路切替・別Frontendビルドを設けない。Cloudflare Terraform / Access policy は別承認・別検証を要する。MCP は管理 VM の初期構築経路ではない。

## VMの入力契約と担当者の作業（合意済み目標）

**VMの基準:** 構築対象VMに対してAnsibleコントローラーからSSH接続でき、宣言されたユーザーが必要時にsudoできること。Ubuntu 26.04 x86-64、systemd/cgroup v2などのサポート条件はAnsibleの事前検査で強制する。VM作成プロバイダーやTerraformの導入をこの契約の前提にしない。VMの手作業によるPodman/DBインストールは不要。

| 順番 | 誰が | 実行・入力 | 誰に何を引き渡すか |
| --- | --- | --- | --- |
| 1 | インフラ管理者 | VMのSSH到達、sudo、ホスト鍵pin、公開FQDN・TLS/Access経路、秘密情報の供給元を準備 | Ansibleコントローラーへinventoryと承認済み環境 |
| 2 | Ansible/構築担当 | inspect → bootstrapでOS・DB・Auth・Quadletを収束。DBが新規か復旧か判定する | 「初回登録待ち」「既存owner復旧待ち」「停止」の機械可読な結果 |
| 3A | 新規DBの場合: Ansible | ownerを**作成せず**、256-bit CSPRNG初期キーを一回だけ生成しハッシュを認証DBに記録。平文は保護された一回限りの配送経路で所有者本人に渡す | 本人に`/console/setup`、初期キー、有効期限。CIログやURLには載せない |
| 3B | 既存DBの復旧の場合: 復旧担当 | DB/原稿履歴、owner ID、Passkey/OAuth client、PostgreSQL role、Podman secretを独立バックアップ・秘密管理から復旧・検証 | ownerへ既存資格情報によるログイン確認。**新しい登録キーは発行しない** |
| 4 | 初回owner本人 | Workersで配信される`/console/setup`からキー検証・Passkey登録 | Better Auth上の唯一のownerと登録消費の確定結果 |
| 5 | 構築担当/保護されたAPI | Web/iOS/内省クライアントの登録とresource/redirectをAPI側で照合。OIDCは任意で、認証後に`/console/identity`から設定 | 保護された初回deployの入力条件と確認状態 |
| 6 | 保護されたGitHub Actions | 配備承認、証明済みdigest、DB schema/backup、Cloudflare/Tunnel、health確認 | 本番owner login可能な`/console`。setup側の登録権限を閉じる |

**初回登録時の起動モード**

`auth-runtime` 後に、通常運用と同じ Fastify と Better Auth を **setup-only モード**で起動し、Cloudflare Tunnel 経由で限定公開する。
許可するのは、セットアップ状態の取得、キーの認可、Passkey の登録、登録完了確認に必要な認証 API と readiness に限る。
作品 API、MCP、owner 設定変更、任意のサインアップ、一般向け OAuth クライアント登録は 403 や 503 で拒否する。
公開前に Workers の静的ルート、Access の経路とオリジン境界、WebAuthn の RP ID と HTTPS オリジンを検証する。Frontendが存在しない・候補と異なる場合は、R4後の確認済み新規install・owner未登録・通常API未稼働を根拠に、[R5の初回Frontend配備](PRODUCTION-BOOTSTRAP.md#publishing-the-normal-frontend-for-first-owner-enrollment)で認定済みFullアーカイブを通常Workerへ配備する。通常のFrontend releaseの互換性チェックは変更しない。既存のUI/Access/Tunnel経路は登録前後で同一とし、登録前の業務API拒否はBackendが強制する。
Access に加えてセットアップキーによる認可を要求し、キーは登録フォームに入力する。
登録した Passkey と対応する owner は、登録が完了した時点で確定する。

**登録キーの権威:** Ansibleによる発行操作は、アプリが提供する制限付きbootstrap操作を利用し、平文を永続DB/Ansible fact/ログ/CI artifact/Workers assetへ書かない。正本DBにハッシュ、発行時刻、24時間の期限、失効・消費状態を記録する。繰り返しのAnsible適用は平文キーを再生成せず、失効や紛失からの再発行には**owner未登録を再検証した運用者の別承認**を要する。キー総当たりに対するレート制限、TLS、CSRF/Origin、競合時のDBロック・一意制約を備える。所有者の生成・Passkey確認・キー失効は再試行・競合でも**単一owner**という不変条件を守る。通常ログイン・OAuth/MCP認可にこのキーを流用しない。

**初回セットアップ画面:** UIの入口/画面/異常系の正本は [管理画面遷移](../design/ADMIN-SCREEN-FLOW.md) とする。キー入力、Passkey登録、完了確認、クライアント準備、初回公開待ちが連続したフローである。作業途中でSSHによる一時サーバー起動、SQL更新、owner IDの手転記を求めない。失敗・中断時はDB状態を再照合して続行または明示停止する。**UIがAnsibleやVM管理権限を取得して本番公開することはない。**

## 宣言的な初期化と公開の責務分離

**採用済み設計:** 宣言的inventoryと承認で新規VMへ`bootstrap`一操作で`host → secrets → base → auth-runtime`を順序どおり収束させる。初回キーはAnsible管理下で安全に生成・配送するが、ownerをAnsibleは作成しない。通常Frontendを配備し、同じFull Backend imageをcanonical API slotのsetup-onlyモードで起動する。本人による通常Workers上の `/console/setup` / Better AuthでのPasskey登録を経て、保護されたactivation preparationでowner/clientを照合しsetup-onlyを停止した後、別途承認された本番activationに進む。通常FrontendやTerraform経路の再配備・切替は不要。新規・復旧・通常更新を混同せず、再適用は冪等。秘密情報や既存データを無条件に初期化しない。既存VMで専用DBの不在が確認された場合も、[R4のDB不在時再初期化](DEPLOYMENT-LIFECYCLE.md#db不在時の再初期化r4) に従い同じ新規導入を実行する。

**運用受入:** `bootstrap` は `host`、`secrets`、`base`、承認済みの `auth-runtime` を順に実行する。新規導入で承認を明示すると、同一オリジンの setup-only API と暗号化した一回限りのキー配送を構成できる。[認証運用手順](../../deploy/ansible/AUTH-RUNTIME.md)に従い、Cloudflare 経路、使い捨て VM と実ブラウザーで受入を確認する。SSH ポートフォワード方式は移行中の既存手順として維持する。`inspect`、個別ステージ、`deploy-lifecycle-fixture`、`restore-drill` は引き続き利用できる。

初回 API container が存在しない `deploy` では、保護環境の `CODEXIA_INITIAL_INSTALL_APPROVED=true` と `CODEXIA_DATABASE_INITIALIZATION_APPROVED=true` が必要で、いずれもデフォルト false。承認しても migration/所有者の検証を迂回しない。成功後は false に戻す。再試行時は既存 transaction とデータを観測してから行う。Bootstrap中断の再開条件、証明済みFull artifact、保護されたowner引き渡しと独立activation起動は [Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md) に従う。

## 復旧状態と受入

```mermaid
stateDiagram-v2
    [*] --> SSHReady
    SSHReady --> HostReady : inspectとbootstrap承認
    HostReady --> DataReady : secrets/baseを収束
    DataReady --> SetupPending : 空DB・明示的に新規構築
    DataReady --> RestorePending : 既存状態・復旧を要求
    RestorePending --> OwnerReady : owner/認証/業務DBを同一性検証
    RestorePending --> Blocked : バックアップ・secret不足
    SetupPending --> SetupExposed : 256-bit grant・setup-only API・edge保護確認
    SetupExposed --> OwnerReady : Passkey + ownerを原子的に確定
    SetupExposed --> Blocked : キー失効・不正な状態
    OwnerReady --> ActivationPending : client照合・setup停止・認証設定確定
    ActivationPending --> Active : 保護された初回activation・必要時pair配備
    Active --> Accepted : 公開経路・再起動・独立restore実測
    SSHReady --> Blocked : 接続・ホスト証明失敗
    DataReady --> Blocked : 不明なDB・migration不一致
    ActivationPending --> Blocked : 証明・バックアップ・承認不足
    Blocked --> RestorePending : 既存データなら復旧専用
    Blocked --> SetupPending : 新規と空DBを再確認・承認
```

- **DB/認証不一致:** 既存データ・role・Secret を勝手に削除・変更しない。公開 API は開始せず、承認済み復旧/移行へ送る。
- **公開の失敗:** Tunnel/Access 経路の受入を API 起動成功と区別する。管理用 Tailscale/SSH を公開経路に依存させない。
- **バックアップ:** ローカルの暗号化 archive は同一 VM の消失には耐えない。独立保管と `restore-drill` の別ホスト実行を本番の復旧能力の受入に含める。

**受入証拠:** 使い捨て Ubuntu VM で空状態・再適用・既存データの採用/拒否・secret drift・schema 不一致・owner 登録・Full 初回起動を検証する。実 VM では reboot、Cloudflare 公開 routing、Web 認証、独立バックアップ復元を別途観測する。検証未実施を PASS として報告しない。

## VMの再構築と所有者資格の復旧

VMを作り直すだけで初回owner登録を再開してはならない。新規モードへの分岐は**DBが空で、独立バックアップに復旧対象がないことを運用者が確認・承認した場合のみ**許す。空に見えるDBでも、障害復旧中・ボリューム未マウント・Secret不一致であれば新規登録は禁止する。

```mermaid
flowchart TD
    REBUILD["VM再構築: Ansible SSH接続可能"] --> INTENT{"運用者の宣言したモード"}
    INTENT -->|完全新規・データなし承認| EMPTY["DB・認証が空であると検証"]
    EMPTY -->|確定| NEW["セットアップキーを発行<br/>/console/setupへ"]
    EMPTY -->|矛盾/旧環境の兆候| HALT["停止・独立バックアップを調査"]
    INTENT -->|既存環境の復旧| RESTORE["暗号化DB/履歴を独立ホストから復旧<br/>roleとPodman Secretを復元"]
    RESTORE --> CHECK{"原稿DB・Better Auth・owner ID<br/>Passkey/client・schema整合を確認"}
    CHECK -->|不正/不足| HALT
    CHECK -->|合致| LOGIN["既存Passkeyで本人認証<br/>新規キーを発行しない"]
    LOGIN -->|成功| GO["証明済みdigestを保護されたdeployで有効化"]
    LOGIN -->|端末喪失| RECOVER["管理権限による本人回復承認<br/>同じowner IDにPasskey追加"]
    RECOVER --> GO
    GO --> ACCEPT["公開経路・復旧試験・同一性を実測"]
```

**復旧の鍵:** PostgreSQL dumpと履歴だけでは完了しない。PostgreSQLのロール、Podman Secret、復号鍵、OIDC設定、OAuth client/署名鍵、ownerの同一性を元の環境から再現する。暗号化バックアップが同じVMにしかない状態を災害復旧可能とは呼ばない。既存owner IDが維持できない場合に、初回登録を代替復旧手段として利用することは禁止する。
