# XState v5 状態機械の採用・所有権・検証契約

**種別: 採用済み技術・部分導入済み。** Desktopの原稿保存・復旧、Native ChangeSet review、本人認証管理の一部でXState v5を使用する。状態の意味・許される操作とエラー時の復旧は [Interaction contract](INTERACTION-CONTRACT.md)、[Screen State Atlas](SCREEN-STATE-ATLAS.md)、[Core](../architecture/CORE.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)、[Backup console](../architecture/BACKUP-CONSOLE-CONTRACT.md) が先に決める。XStateは複雑な遷移だけを**実行可能な状態機械に写像する**ため採用する。既存React UIの単純なローカル状態を機械的に全面置換しない。

## 対象と不変条件

| 領域 | 導入順 | machineの責務 | 正本・副作用の責務 |
| --- | --- | --- | --- |
| WRT-01/REC-01 原稿保存・復旧 | **最初** | 未送信・ブラウザー保護・DB保存中・応答不明・409競合・復旧・確認済みの直交状態とevent/guardをモデル化 | PostgreSQLのcommit/receipt、IndexedDBのjournal、IMEは既存の専用サービスが担う |
| REV-01/REV-02 ChangeSet | 保存machineの受入後 | 提案の読み込み・比較・承認・適用・競合・拒否と要求者のイベント | 作者承認/適用の可否はCore/API/DB transactionが決定 |
| AUTH/CON-10・CON-20 | 保存machineの受入後に適用範囲判断 | ownerの画面認証状態、WebAuthnキャンセル、待機、リンク検証 | Better Auth/OAuth/WebAuthnのプロトコル/署名/権限はライブラリとAPIのまま |
| CON-30〜34 バックアップ | console workflowの実装時 | draft・probe・activate・job受付・接続断/結果不明・receipt確認・service再接続 | 進行中の保全run・secret・worker・S3・Podman・PGはバックアップ制御プレーンが正本 |

**必須不変条件:** `saved`や`backup succeeded`はサーバー側で確認したreceiptを受けた場合だけ成立。画面で`SUBMIT`を送った時点では成立しない。MCP/owner権限はmachine guardの見た目ではなくAPI/Coreで再判定する。初回owner登録・認証失効は既存のidentity正本を更新しない。API再起動・ブラウザリロードは新たな永続正本の生成を意味しない。

## 状態設計の規則

1. 機能の要件ID、画面ID、CTRL ID、API operation ID、machineの`state`/`event`/`guard`を対応付け、**到達不能状態・失敗系・キャンセル**をモデルに含める。単純なbooleanフラグ群の二重正本は作らない。
2. machine contextは画面の一時情報とID、受信した観測値だけを保持する。原稿本文の確定正本、認証資格、S3 secret、job receiptの唯一正本をmachine contextに作らない。
3. actorの非同期処理は既存のHTTP/IndexedDBサービスを呼び出すadapterを通す。retryには同じrequest identity/idempotencyを持たせ、`abort`が実DB commitを巻き戻したとみなさない。
4. `loading`、`ready`、`recoverable-error`、`unauthorized`、`forbidden`、`unknown-result`、`conflict`などの共通表示は要件に従って写像し、異なる原因をひとつの`error`に潰さない。
5. 独立した複数状態（例: ブラウザーdraft保護とDB receipt）には明示的なparallel stateを使用できるが、状態の組合せが許可されることをcounterexampleで検証する。
6. effectを実行するactivity/actorは安全なcleanupと再起動条件を持ち、同じイベントを2度配信しても原稿や保全jobが重複作成されない。
7. diagrams/READMEは要件・machineの対応を説明する派生表示。Mermaid画面図の業務意味は [Screen State Atlas](SCREEN-STATE-ATLAS.md) が所有し、machineから図を生成する場合も両者の意味的差分をレビューする。

## machineとAPIの具体例

`WRT-01.SAVE_REQUESTED` → `saving` → `SAVE_ACK(receipt)` → `db-confirmed`。
`SSE断/timeout` → `unknown-result` → `QUERY_RECEIPT(same operationId)` → `confirmed` または `recoverable`。
`409` → `conflict` →作者の比較判断→**新しい明示save要求**。

同様に、バックアップは`SAVE_DRAFT`→`probe-running`→`probe-passed`→`activate-requested`→`active-confirmed`とし、`202 Accepted`や`probe-passed`を`remote-backup-verified`へ昇格させない。サービスがwriter quiesce中に切断されてもバックアップrun IDを再照合する。

## 実装対象の境界

- 既存UI状態管理、React 19、現在のauthoring API/journal実装を確認し、状態機械の実装を**対象機能の既存コンポーネント/フック**へ導入する。新しい巨大なglobal app state storeを作らない。
- XState `createMachine`、actor等のv5安定APIと、Reactとの連携には保守される公式パッケージを使う。実導入の時点でv5最新版と依存compatibilityを `DEPENDENCY-POLICY.md` / `DEPENDENCY-INVENTORY.md` に記録する。v6 betaやAPIの無根拠なpinは採用しない。
- テストはmachineの全到達state/edgeを機械的に列挙しただけでは不十分。**独立した設計要件から期待状態と拒否・副作用を作る**。サーバーAPI/IndexedDBとブラウザーの実結合をE2Eで検証し、machineの実装を期待値へコピーしない。

## 受入

| ID | 条件 |
| --- | --- |
| XST-001 | 保存・復旧について要件/画面ID/全イベント、不正遷移と失敗/中止のテストを写像 |
| XST-002 | 409/412、応答消失、連続編集、2tab、別document/author、再起動、IME、IndexedDB quota不足で未確定原稿を失わない |
| XST-003 | receiptが無い状態をDB確定表示にしない。各保存操作のidempotencyとrecoveryを実PostgreSQL/Chromiumで検証（旧Mobile・公開面の例外は [E2E execution](../verification/E2E-EXECUTION.md)） |
| XST-004 | 状態機械の拒否だけに依存する認可を作らず、既存APIのprincipal/owner/BOLA拒否を維持 |
| XST-005 | ChangeSet/auth/backupへの展開はそれぞれの状態正本と比較し、重複stateや不要なglobal actorを追加しない |
| XST-006 | 決定したXState version、API、採用範囲、追加したCI source/test identityをexact-sourceで検証 |

DesktopのWRT-01/REC-01保存・復旧は [`persistence-save-machine.ts`](../../app/src/application/persistence-save-machine.ts) と [`PersistenceWorkspace.tsx`](../../app/src/persistence/PersistenceWorkspace.tsx) が担当する。次の機械は操作対象を画面単位で保持し、既存APIの結果を表示に写像する。

| 画面・操作 | Desktopでの適用範囲 | 判定と再照合の正本 |
| --- | --- | --- |
| REV-01.A、REV-02.A | [Native ChangeSet review](../../app/src/persistence/native-review-machine.ts) の取得・選択、承認・却下と別操作での適用、競合・応答不明 | review feed、ChangeSet APIのversion・statusと適用receipt |
| CON-10.A | [Passkey再認証](../../app/src/settings/owner-passkey-reauth-machine.ts) とWebAuthnの中断、結果の再取得 | Better Authのセッション・Passkey API |
| CON-20・CON-21.A | Desktop連携先画面の [OAuth同意撤回](../../app/src/settings/owner-grant-revocation-machine.ts)、本人確認、撤回結果の再照合 | owner-security identity・revoke-consent APIの対象grant・revision・receipt |

機械の単体テストと、既存の `native-review`・`oauth-web` Chromiumタスクで状態と副作用を検証する。画面を経由しないChangeSetの認可拒否は、Better AuthのAPI統合テストで確認する。

Module proposalの承認・適用とローカルの非表示、OIDCプロバイダーの設定・リンク管理、バックアップ操作はこの適用範囲の外にある。ネイティブSwiftUIクライアントにはReact/XState runtimeを導入しない。
