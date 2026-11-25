# 本番Deploymentライフサイクル設計

**種別: 正本・規範的設計（normative）。** 本書は、本番Deployment全体の状態分類、経路選択、初回協調配備、非互換切替、排他・再開・受入を所有する。対象読者はインフラ管理者、配備運用者、開発・検証担当者。承認済み設計目標であり、現行Workflowや実環境が全契約に適合済みであることを意味しない。

[システム基本設計](../architecture/SYSTEM-DESIGN.md)を上位とする。[初期導入](INITIAL-DEPLOYMENT-FLOW.md)はVM収束・owner登録、[互換更新](UPDATE-FLOW.md)は通常更新、[IaC](IAC.md)はAnsibleの所望状態、[Backup](BACKUP.md)は保全・復元、[CI/CD](../verification/CI-CD.md)はexact-source証明を所有する。本書はこれらを合成する横断契約であり、個別機能の第二正本を設けない。[Production Bootstrap](PRODUCTION-BOOTSTRAP.md)と[Push deployment](PUSH-DEPLOYMENT.md)は運用手順である。

**非目標:** VM提供基盤・Tailnet自体の構築、既存Ansible・backup・release検証の再実装、別writer・pull updater・常駐Deployment controllerの追加、互換性チェックの緩和、Web/MCPへのインフラ操作権限付与、暗黙のデータ削除。CloudflareのTerraform/DNS/Access/zone policy変更は既存の別承認・管理権限に従う。唯一のVM管理経路は GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → rootless Podman Quadlet とする。

## 状態観測と入力契約

所望状態は認定済みmainのFull Backend OCI digest・証明書・migration fingerprint・persistence format・API epoch・認証schema契約、対応するFull Frontendの検証済みarchive digest・producer/source identity・API epoch・公開OAuth設定で特定する。独立したcomponent versionの一致は互換条件ではない。既存exact-source/証拠再利用規則に従いmainとproducerを区別する。

変更前に以下の直交する軸を読取専用で観測する。各軸の状態は排他的に分類し、対象が存在しないことを確認した場合のみ未配備/未作成とする。観測不能・矛盾は不明として残す。通信失敗・Access拒否・確認済み旧形式・真の未配備を同一視しない。該当しない軸は理由を明示してN/Aとする。

| 軸 | 状態 | 観測証拠 |
| --- | --- | --- |
| M 管理接続 | 未準備／到達・認証済み／異常・不明 | VM ID、OS、Tailscale、SSH host key pin、操作者/rootless identity、必要なsudo |
| H 基盤 | 未構築／canonicalな部分構築／canonicalで正常／drift・不明 | Podman/systemd/UID/GID、Volume/Network/Quadlet、DB/Tunnel container・unit・Secretの一致 |
| D データ | 未作成／新規空／既存互換／既存非互換／復旧対象が欠落／不明・破損 | DB cluster ID、logical DB、volume、role・ledger・persistence、履歴・独立backup・復旧意図 |
| A 認証 | 未構成／登録待ち／登録済みだがactivation未準備／登録済み・検証済み／確認済み旧認証方式／回復必要／不明 | Better Auth schema、owner/Passkey/client同一性、setup marker・grant状態、Secretの存在・一致 |
| B Backend | clean未配備／setup-only／通常稼働・互換／通常稼働・非互換／停止・障害・残存状態／不明 | API container・unit・実digest・embedded identity・health、deployed-release/transaction記録 |
| F Frontend | 未配備／稼働・互換／稼働・非互換（確認済み旧形式含む）／障害／不明 | Worker version・traffic、artifact identity・profile/epoch・公開OAuth設定、routeとAccess |
| T 操作 | なし／既知の再開可能操作／中断・復旧必要／不明 | 操作ID、対象・承認・前提、host lock・durable transaction、fenceと旧/候補identity |

Cloudflare側のTunnel/DNS/route/AccessとVM内のTunnel runtimeは独立に観測する。外部Tunnelだけ既存なら既存token・経路を利用してVMを構築できる。VM上のTunnelだけ既存ならcanonical identity・所有者・Secret・network・unitの一致を確認して残りを収束する。別ユーザー・別構成のTunnelやDBを暗黙に採用・上書きしない。

Preflightは環境、host pin、観測時刻、source/candidate、現在のidentity、データ/Auth/backup状態、選択経路、不足する承認・証拠を束縛した機械可読な非秘密結果を返す。秘密値、資格情報付きURL、平文登録キー、原稿本文を記録しない。異なる環境への流用、古い観測に基づくmutationは禁止。

## 経路選択の優先順位

次の判定を上から順に適用し、最初に一致する経路を選ぶ。選択経路に必要な承認・証明が欠落する場合は無変更で停止する。中間経路の完了後は再観測して判定に戻る。新規installと既存環境の復旧意図は運用者が明示し、空に見える状態だけで選択しない。Dの「新規空」は未初期化のpristine状態を指す。schema/ledger初期化が完了したDBは原稿件数が0でも互換DBとして扱い、承認済みinstall intentとA/Tに基づき登録待ちを判定する。

| 経路 | 条件（先行条件は除外済み） | 実行と遷移先 |
| --- | --- | --- |
| R0 STOP / PREPARE | M未準備・異常、選択に必要な観測不明、解釈不能な操作記録、必要な承認・証明不足 | 無変更で停止。VM/SSH/edge/backupの前提を準備・調査し再観測 |
| R1 RESUME / RECOVER | Tに既知の未完了操作あり | 同一操作の記録・現状態・fenceを照合して再開または切戻し。未知記録はR0 |
| R2 RESTORE | 既存環境の復旧意図があり必要な保存状態が欠落・故障 | 独立backup・外部秘密管理から復元。必要なら先に基盤構築するが初回owner発行は禁止 |
| R3 MAINTENANCE | H drift、D既存非互換、確認済み旧認証方式からの変更、既存A回復必要、B停止・障害・残存状態またはF障害 | 明示保守・復旧・移行。先行保全・互換性判定。既存owner回復を新規登録と分離 |
| R4 BOOTSTRAP | H未構築/部分構築、D未作成/新規空またはA未構成で、新規・既存採用・復旧の意図が確定。承認済みinstallでDの欠落を確認した場合は旧B/Aの残存より優先 | 必要なhost/secrets/base/auth-runtimeを収束。新規初期化を別承認。既存identity/ledger/資格情報保持 |
| R5 OWNER_SETUP | 承認済み新規installでA登録待ちまたはactivation未準備、あるいはB setup-only | 制限付きsetup UI/APIと一回限りgrant。本人登録、client検証、保護されたactivation preparation。既存ownerを再発行しない |
| R6 ACTIVATE | H/D/A検証済み、B clean未配備 | F互換なら既存初回Backend配備。F未配備/非互換ならpair activation。初回・DB使用承認、backup |
| R7 CUTOVER | B通常稼働だが非互換、F未配備、またはF非互換かつ通常Frontend admissionが成立しない | 既存データ/owner保持、必要な移行・協調配備。既に互換な側を無用に再配備しない |
| R8 UPDATE / VERIFY | B通常稼働・互換、Fが正常で通常admission成立 | 変更のあるcomponentのみ通常互換更新。完全同一ならno-op＋health/identity検証 |

R0の不明は独立した証拠で確定した旧identityや未配備を含まない。R1の再開可能な操作が本人登録・別承認待ちなら待機状態を返し、自動再試行ループや新しい登録キー発行を行わない。R2で基盤のdriftがある場合は安全な明示修復を復元の前提とする。R3のmigrationとR7の対切替が同一保守操作に属する場合は一つのfence・保全・transactionで完結させる。途中で通常公開へ戻さない。既存データを新規として扱う経路はない。確認済みのDB不在に対する新規初期化は、既存データの変換・削除ではない。旧認証からの移行に新しいBetter Auth owner登録が必要なら、旧データ保全・新規認証の明示承認・別のclean targetを用いる保守経路でのみ行う。

### DB不在時の再初期化（R4）

VMの利用履歴や旧API epochではなく現在のDB状態を判定する。新規installの明示と既存のdatabase-initialization承認がある場合、管理接続・canonical基盤の確認と正常なPostgreSQL管理接続による専用logical DBの不存在確認（または新規基盤での確認済み未作成）を根拠に、R4へ収束する。接続不能・認証失敗・観測不明は不存在と見なさずR0で停止する。restore意図はR2を維持する。既存DBを削除・上書きする操作は一切含めない。

DB不在が確定した旧配備では、旧epoch・旧owner・旧API稼働記録は新しいDBの互換条件としない。既知の未完了操作はR1を優先し、不明な操作記録・基盤drift・対象所有者不一致は停止する。R4の保護された実行系統はproduction queueとcanonical host lockの下でDB不在を再検証し、Tunnel/APIを停止して旧API slotおよびDBに束縛された旧owner/setup/release状態だけを整理し、既存のclean target検証を満たす。PostgreSQL cluster・他DB・role・Secret・外部Tunnel/Access設定・独立backupは保持する。処理中断時は再観測し、不在が維持されている場合に限り整理を再開できること。既に作成・初期化されたDBは通常の新規空・install intentに束縛された再開契約に従い、暗黙に破棄しない。

既存BootstrapのDB初期化承認を用い、DB再作成固有の重複承認や旧epoch移行契約を要求しない。認定済みFull imageで現行schema/ledgerとBetter Authを初期化し、R5でownerを登録、R6で互換Frontendとactivationを行う。旧Frontendの存在はR4の妨げではない。通常update/adoptではDB不在を自動的な新規installへ読み替えない。

### 統合Deployment経路

[グラフィカルな遷移図を開く](https://yohn-jp.github.io/codexia/architecture/#lifecycle-1)

```mermaid
flowchart TD
    REQ["Deployment要求 / 所望release"] --> OBS["Production Preflight<br/>VM・DB・Auth・API・Frontend・操作記録"]
    OBS --> KNOWN{"必要な観測・承認が確定?"}
    KNOWN -->|いいえ| STOP["R0: 停止 / 前提準備"]
    KNOWN -->|はい| PENDING{"既知の未完了操作?"}
    PENDING -->|あり| REC["R1: 再開または切戻し"]
    REC --> OBS
    PENDING -->|なし| LOST{"既存状態の復旧が必要?"}
    LOST -->|はい| RESTORE["R2: 独立backup / Secret復元"]
    RESTORE --> OBS
    LOST -->|いいえ| DRIFT{"drift・DB/Auth非互換・障害?"}
    DRIFT -->|はい| MAINT["R3: 保守・復旧・協調移行"]
    DRIFT -->|いいえ| BASE{"基盤・DB・Auth runtime収束済み?"}
    BASE -->|いいえ| BOOT["R4: Bootstrap"]
    BOOT --> OBS
    BASE -->|はい| OWNER{"owner activation準備済み?"}
    OWNER -->|いいえ / 新規承認済み| SETUP["R5: 限定公開・owner登録<br/>activation preparation"]
    SETUP --> OBS
    OWNER -->|いいえ / 既存・不明| STOP
    OWNER -->|はい| API{"cleanなAPI未配備?"}
    API -->|はい| ACT["R6: 初回activation<br/>必要時pair activation"]
    API -->|いいえ| COMPAT{"通常release admission成立?"}
    COMPAT -->|いいえ| CUT["R7: 協調cutover"]
    COMPAT -->|はい| UPDATE["R8: 通常更新 / no-op"]
    MAINT --> OBS
    ACT --> ACCEPT["identity・health・Auth・データ・公開境界を検証"]
    CUT --> ACCEPT
    UPDATE --> ACCEPT
    ACCEPT -->|不成立| REC
    ACCEPT -->|成立| ACTIVE["Active / 独立した本番受入"]
    STOP -->|前提確定・再要求| OBS
```

### Frontend・Backendの配備マトリクス

候補B/Fは互いに互換であることが前提。H/D/Aの収束、承認・証明・Tの解決を先行する。setup-onlyはR5であり通常Bではない。「互換」は候補profile/API epochに対する状態で、DB migration/persistence/認証schema不一致、確認済み旧認証方式からの変更はR3が優先する。

| Backend ＼ Frontend | 未配備 | 非互換・旧形式確定 | 互換 |
| --- | --- | --- | --- |
| clean未配備 | R6 pair初回配備 | R6 旧UI置換＋初回Backend | R6 初回Backendのみ |
| 通常稼働・非互換 | R7 必要な移行＋pair配備 | R7 pair cutover | R7 Backend保守移行、F再検証 |
| 通常稼働・互換 | R7 Frontend初回配備、B維持 | R8 通常Frontend admission成立時のみ。それ以外はR7 | R8 独立更新/no-op |
| 停止・障害・残存状態 | R3復旧後再判定 | R3復旧後再判定 | R3復旧後再判定 |
| 不明 | R0 | R0 | R0 |

Frontend障害はR3、未観測はR0を先行する。空VMでも旧Frontendが残り得る。API停止だけではclean未配備ではない。API container/unit/activation link/transaction/release/rollback記録が残る場合は既存配備の回復とし、first-install承認で上書きしない。ただし、前節のDB不在が確認されR4の初期化が承認された場合に限り、旧配備の残存状態を整理する。

## 共通制御と個別移行の境界

単一本番環境を対象とする。経路分類R0〜R8と権限分離を維持し、実行責務を次の4系統に整理する。Preflightは全系統に共通する読取専用入口であり、R0は実行系統ではない。運用者が観測なしにWorkflow/経路を選ぶのではなく、所望releaseと明示した導入・復旧・保守意図から経路を決定する。

| 実行系統 | 対応する経路 | 再利用する責務 |
| --- | --- | --- |
| Bootstrap / Activation | R4・R5・R6 | Ansible収束、認定済み成果物、owner本人登録、初回Admission、必要時pair activation |
| Update | R8 | 既存の独立component lane、互換Admission、no-op、通常rollback |
| Cutover | R3の計画済み非互換変更・R7 | 先行stage、fence、保全、必要時個別Migration、協調配備・受入 |
| Recovery | R1・R2・R3の障害/復旧 | 既存journal、lock、復旧証拠、再開・復元・安全停止 |

共通制御は既存のrelease証明、Ansible task、Cloudflare adapter、backup/restore、host lock、durable transactionを合成する。共通化の単位は観測・経路判定・Admission・排他・保全・配備・検証・復旧であり、データ変換や認証移行の意味を推測する汎用エンジンではない。独自Migration DSL、任意コード実行、epochグラフ探索、常駐サービス/DB、別writer controller、常設Blue/Green、全旧epochの恒久サポートは設けない。必要なら一時的な隔離復旧・clean targetを使う。

### 所望状態と変更軸

候補pairを既存の互換性manifestと認定済み実artifactから特定し、観測されたsourceとの差分を独立に評価する。API epochの変更だけからDB変換や認証再登録の必要性を導出しない。

| 変更軸 | 通常Admissionが成立しない場合の処理 |
| --- | --- |
| Backend/Frontend digest・component version | 互換なら変更componentのみUpdate。全て同一なら検証付きno-op |
| API epoch・公開OAuth契約 | 候補pairの互換性とclient/route契約を確認し、必要な側のみ協調配備 |
| SQL migration fingerprint / ledger | owning schema契約の明示移行、ledgerとデータ検証 |
| Persistence format | owning persistence契約の明示変換と照合 |
| Auth schema | 既存owner/client/Secretを保持する明示移行・catalog検証 |
| Auth方式 | 明示した個別移行。本人登録が必要な場合のみ別clean targetを使用 |
| 基盤・外部route | Ansibleの所望状態収束または既存の別管理権限による保守。releaseから暗黙に変更しない |

複数軸が変わる場合は一つの承認対象・保守transactionの下で必要処理を組み合わせる。矛盾する処理や未定義の変換は実行せず停止する。変化しない軸の変換・再初期化・再登録を要求しない。

### 移行契約と計画

各非互換releaseは、直前の稼働本番構成（API epoch、ledger/fingerprint、persistence、認証方式/schema等の該当するsource契約）から候補targetへの移行契約を提供する。既存の `deploy/update-compatibility.json`、`deploy/frontend-compatibility.json`、artifact identity/certificateが所有する値を第二のmanifestに転記しない。移行契約には次を定義する。

- 対応するsource/target条件、変化する軸、必要な個別移行処理（API-onlyならデータ変換なし）、実行順序と実行前後の検証、保全/復元条件。
- source/targetに対して一意に解決できる、version管理された個別処理への静的な参照。既存のschema migration、persistence conversion、認証/backup/restore操作を再利用する。未認定の処理や運用入力の任意コマンドは実行しない。
- 実行前の互換性判定と、失敗・中断時の再開可能条件または保全点からの復旧条件。複数軸の移行順序が確定しない場合は停止する。

実装形態は既存コードへの最小限の明示的な登録・dispatchでよく、別の汎用frameworkや動的plugin registryを導入しない。直前の稼働本番からの直接移行を保証し、飛び越しや追加source対応は実際に必要な場合のみ明示契約を追加する。経路不在・複数一致・未知sourceはmutation前に停止する。移行専用コードは本番受入後、実際に必要な再開・復旧・保全点の再現期間が終了してから撤去できる。互換性fallbackとして残さない。

Preflightは既存の状態証拠と候補identityから、経路、変更軸、選択した移行契約、必要な操作・承認・保全/復旧・受入条件を含む非秘密の計画を返す。承認不足の場合は選択候補と不足理由を返してR0で停止する。計画を環境/host/DB/旧・候補identity/証拠/意図/保守窓に束縛してdigestで固定する。承認はその計画に対して行い、別artifact・別環境・変更後のsourceへ流用しない。queue/host lock取得後、各mutation直前に計画と現状態（または同一transactionの既知checkpoint）を照合する。drift、期限切れ、未知checkpointでは再計画または明示復旧を要求する。

### 運用と再開

通常の互換更新は既存release triggerと保護条件で自動実行する。非互換・初回・復旧では、運用者は計画、保守窓と必要な権限を承認し、controllerが必要な操作を実行する。自動で連続実行できるcheckpoint間を人間が手動でつなぐことを要求しない。ただし既存のbootstrap/DB使用・初回/公開・保守/復旧・Cloudflare権限の分離、本人Passkey登録、独立復旧環境の秘密と実際の受入証拠は省略・自動承認しない。独立保管/復元や機能受入が別の権限・環境を必要とする場合は証拠待ちで安全に停止し、同一計画を再開する。既存のphase承認はその保護条件を満たす形で維持する。

共通checkpointの意味は「観測・計画/承認 → stage → 必要時fence/保全 → 必要時Migration → 配備 → 受入 → 公開/記録確定」。不要な操作は理由を記録して省略できる。各checkpointの事後条件を観測してから次に進み、プロセス終了や固定時間の経過を成功証拠としない。失敗時は既知の記録に従い安全に再開・切戻し、条件が不足すればfenceを維持して明示復旧を待つ。公開後に新規書込みがあり得る場合、旧backupの無条件復元は不可。新規書込みの保全と承認済み復旧方法を確認してから復元する。

### 認証方式変更を伴う移行

旧認証方式が確認された既存環境は、未構築・空DB・owner回復と区別する。既存Better Auth ownerを保持できる場合はowner再登録を禁止する。保持できない別方式から新規owner登録が必要な場合のみ、承認済みclean targetで既存Bootstrap/限定setupを利用する。旧sourceの稼働identity・backup/復元可能性・単一writerの確保を先行し、旧業務データを持つsourceとtargetを同時に通常公開・書込み可能にしない。

対象データの移管は既存の正本データ・履歴契約に基づく個別Migrationとする。旧認証資格情報を新認証へ暗黙に移さず、targetで登録済みのowner/Passkey/client/Secretを上書きしない。必要な所有権対応は明示的に検証・変換し、原稿・revision/履歴・関連ID・権限の整合性を照合する。旧sourceの復元点、targetの認証保全、候補pairの受入がそろうまで通常公開しない。失敗しても旧sourceまたは保全済みデータを削除しない。個別移行実装を別の恒久的なデータ移管基盤に拡張しない。

## 実行権限と保護された引き渡し

Workflowファイル数は固定しない。論理モードと権限・承認・成功条件を分離し、既存保護環境、canonical Ansible task、release証明、backup/recoveryを再利用する。

| 実行経路 | 実行者・入力 | 完了と引き渡し |
| --- | --- | --- |
| Production Preflight | 保護された読取専用運用者、対象pin、読取権限 | 状態・経路判定。VM接続/syntaxだけでは完了しない |
| Production Bootstrap | 独立管理者・sudo、private inventory、stage別承認、認定済みFull | host/secrets/base/auth-runtime、初回登録待ち/既存owner検証/停止。通常APIは起動しない |
| Production Activation | 保護運用者、rootless配備identity、初回・DB使用・公開の別承認、owner本人 | setup-onlyを閉じ、認定済みartifactを有効化。必要時pair経路 |
| Production Update | 認定済みmainのcomponent release、保護された有効化承認 | 互換Backend/Frontend更新、no-op、rollback |
| Production Maintenance / Recovery | 明示保守/復旧承認、Cloudflare管理権限、復旧証拠 | 基盤修復、DB/Auth復元・migration、非互換pair切替、切戻し |

Bootstrap入力Full digestは既存release handoffの証明書・発行元・main tree/producer・profile・embedded identityに照合してからDB/auth migration、setup-only APIに使う。digest形式や指定だけでは認定しない。保護controllerからowner状態を照会し暗号化grantを秘密経路で引き渡す。本人登録後に既存activation preparationを実行し、owner subjectを手転記・生成しない。Bootstrap成功や登録完了を次のreleaseイベントの自然発生に依存させず、既存の正確な証明済み成果物を再検証して別承認のactivationを起動できること。

既存PostgreSQLクラスタでlogical `codexia` DBだけが欠落する場合は、対象DBの欠落・role・旧API状態・復旧意図を確定し、保全と明示承認後に既存の限定再作成処理を使う。別DB/volume/ownerを削除・再初期化する権限にはならない。

## 初回協調配備と非互換切替

通常Frontendは稼働Backendと既存Frontend identityを、通常Backendは互換な稼働Frontendを要求する。両方が未配備または旧epochが非互換なら通常経路は使わない。初回と保守のpair経路は、旧稼働identityの一致ではなく、**独立に認定された候補pair、確定した初期状態、明示承認、隔離・復旧条件**に基づく専用Admissionを持つ。通常更新チェックを無効化しない。

新規owner登録用Frontendが未配備/非互換なら、認定済み静的assetsを事前stageし、same-originのsetupルートと必要APIのみを制限付きで公開する。既存writer/ownerを保持する必要がある場合は別clean targetを使う。業務・通常OAuth/MCP経路は公開しない。setup-only API、Access/TLS/RP ID、登録キー追加認可、拒否経路を実測して本人へ引き渡す。登録後は既存の `--prepare-activation` 相当でowner/client検証、setup-only API/Tunnel停止、通常認証設定確定、clean API slotへの復帰を行う。

### 制限付き初回配備・協調切替・切戻し

[グラフィカルな遷移図を開く](https://yohn-jp.github.io/codexia/architecture/#lifecycle-2)

```mermaid
flowchart TD
    START["承認済み初回 / 協調配備"] --> PIN["認定済みBackend digest/certificate<br/>Frontend archive・Worker候補pin"]
    PIN --> PRIOR["旧状態・独立復旧証拠<br/>または承認済み新規空状態"]
    PRIOR --> LOCK["共通production slot・保守記録<br/>鮮度再照合・Ingress fence"]
    LOCK --> SETUP{"新規owner登録が必要?"}
    SETUP -->|はい| LIMITED["setup-only UI/API限定公開<br/>owner本人登録・準備完了"]
    LIMITED --> CHANGE{"writerまたはDBの変更が必要?"}
    SETUP -->|いいえ| CHANGE
    CHANGE -->|はい| QUIESCE["writer / setup-only停止<br/>host lock・backup"]
    CHANGE -->|いいえ| BACK
    QUIESCE --> DATA["必要な復元・migration・ledger/Auth検証"]
    DATA --> BACK["目標Full Backendを必要時起動<br/>fence内で検証"]
    BACK --> FRONT["pin済みWorkerを必要時のみ昇格"]
    FRONT --> CHECK{"pair・データ・認証・拒否経路正常?"}
    CHECK -->|はい| OPEN["fence解除・外形確認・記録確定"]
    CHECK -->|いいえ| FAIL["fence維持・旧Worker/Backend/DB/Auth復元"]
    FAIL --> VERIFY{"旧状態または新規の安全停止を検証?"}
    VERIFY -->|はい| HALT["保守結果を記録・再観測"]
    VERIFY -->|いいえ| BLOCK["保守状態維持・明示復旧待ち"]
```

1. 両候補を認定・pinし、通常trafficを変えずWorker候補をstageする。旧Worker version/traffic、Backend digest、Quadlet/Auth設定、DB/historyの復旧手段を確保。新規で旧releaseがなければ不在を記録。
2. 既存環境の非互換変更・復元では独立保管age暗号化backup、隔離復元、必要なmigration rehearsalを破壊的操作前に検証。role/Secret/鍵/ownerの復旧を別途保証。新規でも旧データ不在の承認と通常activation前のDB/Auth backupを要求。
3. 通常release/bootstrap/backupとの競合を排除し、公開hostname全体のIngress fenceを設定・実測。承認済みidentity GETと限定setup/受入経路以外を拒否。Tailscale管理経路は維持。
4. writer変更が必要ならhost lock下で旧writer/Tunnelを停止し最新backupを保全・検証。承認済みmigration/restoreのみ実行しledger・persistence・Auth/owner/client・データを照合。初回でもDB初期化をdeployに隠さない。
5. 必要なBackendだけ起動してdigest・readiness・単一writerを確認。Tunnelをfence下で接続し、必要時のみFrontend候補を100%昇格。双方の実identity、認証・拒否経路、データを検証してから公開。片側が既に目標互換なら無用な再配備・writer停止を要求しない。
6. 失敗時はfence維持、旧Frontend traffic、旧Backend digest/設定、必要なDB/history/Authを保全済み復旧点から戻す。旧releaseがない場合はsetup待ちまたは安全停止に戻しowner/データを削除しない。復旧検証なしにfence解除しない。公開解除後の外形検証失敗も再遮断・復旧判断へ送る。

## 排他・再開・証跡

- Bootstrap、Activation、Maintenance、Frontend/Backend mutationは同じ環境のproduction slotを共有する。保守状態はWorkflow寿命を越えて維持し、runner終了やowner登録待ちで解除しない。通常releaseは保守中に公開状態を変更しない。writer変更・backup・Auth初期化は既存host lockを再利用し、取得後に対象・前提・identityを再照合する。別lock/writer controllerを作らない。
- mutation前にdurable操作記録を作り、対象・意図・承認・DB cluster・候補/旧identity・完了checkpoint・backup receipt・fence状態を束縛する。既存deploy transactionと矛盾する第二台帳を作らない。失敗・中断時は記録と現状態を照合し、同一操作の既知checkpointの再開または承認済み復旧のみを許す。
- Bootstrapは段階完了と新規install intentを永続的に識別する。schema初期化済みだがgrant/installation marker未作成の場合、既存owner DBや未知DBと区別できる証拠がなければ停止する。同一cluster・承認済み新規意図・owner未登録が証明できる場合に限り再開。grantと暗号化handoff、期限切れ、owner登録、setup停止からactivationの各中断を扱い、Secret/ownerを再生成しない。
- 成功状態は `STAGED`（成果物）、`BOOTSTRAPPED`（基盤）、`SETUP_PENDING`（本人登録待ち）、`ACTIVATION_READY`（配備準備）、`ACTIVE`（公開配備の実測成功）、`ACCEPTED`（実環境受入）を区別する。これらは契約上の意味であり既存API/DB enumの変更を自動要求しない。停止・復旧待ち・不明を成功としない。一時承認と保守状態を完了後に解除して通常運用へ戻る。

## 受入契約

非互換変更のPRには、変更軸に対応する移行契約（API-onlyは変換不要の宣言を含む）、必要な個別実装、受入条件、復旧方法、直前の対応sourceからの試験を要求する。既存CI impact/証拠契約に従い、通常の互換変更に全移行fixtureを追加起動しない。互換性契約・個別移行変更は対象の移行/拒否/復旧試験を選択し、共通制御変更は全経路の回帰を選択する。既存main必須認定やrelease証明を弱めない。

API-onlyの非互換切替ではDB/Auth変換なし、別のepoch値でも同じ共通制御、対応しないsource/targetで無変更停止、片側が既に候補互換なら不要な再配備なしを検証する。epoch値の更新だけでWorkflow・共通制御の修正を必要としない。個別Migrationの追加は対応条件・処理・検証の差分に限定する。計画の改変、陳腐化、別host/DB/候補への承認流用、checkpoint矛盾、証拠欠落を拒否する。旧認証方式からの移管では既存データ・履歴の整合とtargetの本人登録済み認証保持、通常writerの排他、途中失敗からの安全な復旧を検証する。

CIは認定済み候補、使い捨てUbuntu/rootless Podman/PostgreSQL 17、Cloudflare限定権限fixture/APIモックで以下を検証する。実VM・実edgeの成功とは区別する。経路判定は全状態の直積を網羅的に評価し、各入力に対して選択経路が一意または明示停止となること、各分岐に到達可能な代表ケースがあることを確認する。

| ケース | 必要な検証 |
| --- | --- |
| 空VM・外部Tunnelのみ・canonical VM Tunnelのみ | 必要な基盤だけ収束、既存Tunnel保持、未配備pairから限定setup/activation、通常運用到達 |
| 部分構築・既存互換DB・既存owner | 冪等採用、owner/cluster/Secret/データ保持、登録キー再発行なし |
| 非canonical基盤・未知状態・欠落identity | 拒否、暗黙削除なし、旧形式/真の不在とAccess拒否・到達不能の区別 |
| 旧epoch/非互換schema・片側のみ配備 | 通常release拒否、fence内協調切替、必要な側のみ更新、writer/データ保全 |
| VM消失、論理DB欠落、owner資格回復 | 別ホスト復元、role/Secret/owner同一性維持、無承認初期化拒否 |
| 中断・競合・再実行 | schema/marker/grant/owner/prepare-activation、backup/停止/Backend起動/Worker昇格/公開解除の各checkpointで中断。再開または検証済み切戻し、二重writer・再owner発行・通常lane割込みなし |
| 不正artifact/承認/backup | 全経路で未証明・陳腐化候補、不正host/DB identity、保全不成立を拒否 |
| 通常運用と実環境受入 | 同一digest no-op、独立互換更新、rollback、VM reboot、実Cloudflare/Browser/owner認証・許可/拒否経路・独立復元の実測 |

証拠は既存CI artifactまたは保護運用記録で環境、source、artifact、操作ID、backup/restore receipt、観測結果を紐付ける。全経路の到達性とfail-closedを検証する。未観測は未検証、失敗は失敗、部分稼働は受入未完了とする。
