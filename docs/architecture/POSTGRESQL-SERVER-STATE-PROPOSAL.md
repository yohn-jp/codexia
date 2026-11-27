# サーバー永続状態の PostgreSQL 移行案

**種別は設計提案。** REQ-DATA-005 のデータ集約目標は採用済みであり、本提案の物理定義、権限境界、移行手順は承認を要する。
設計の所有者はデータモデルと永続化層、対象読者は API、認証、運用の開発者と配備運用者。
本提案は DB 専用バックアップの方式選定や本番復元の承認を扱わない。
採用時は [DB 詳細契約](DATABASE-DETAIL-CONTRACT.md) と [本番配備ライフサイクル](../deployment/DEPLOYMENT-LIFECYCLE.md) に反映する。
[データモデル](DATA-MODEL.md) と [バックアップ運用](../deployment/BACKUP.md) が、保持対象と独立復旧の条件を定める。

## 復旧対象と保持先

Core と Full は同じ API のジョブ履歴と Recent Activity を使い、Full にはモジュールの派生物が加わる。
同一 PostgreSQL クラスタ内の既存スキーマは引き続きそれぞれの状態を所有する。

| 対象 | 現行の保持先 | 提案する復旧境界 |
| --- | --- | --- |
| 作品、確定済みリビジョン、保存 receipt、作者が採用した Speaker モデルや訂正 | `public` のドメイン表と module record | 既存の PostgreSQL 正本 |
| owner、Passkey、OAuth、失効、共有許可 | `codexia_auth` と既存ドメイン記録 | 既存のロールと権限境界 |
| バックアップ設定、封印済み資格情報、実行状態、receipt | `codexia_backup` | API と executor の既存権限分離。封印解除鍵と独立保全証拠は別途管理 |
| ジョブ、保持対象の結果、通知、既読 | `/history/jobs/jobs-state.json` | `codexia_job_history` |
| 編集位置、読書位置、端末別の更新順序 | `/history/recent-activity/recent-activity-state.json` と `recent-activity-order.json` | `codexia_activity` |
| Speaker の適用済み推論ルール、表示対象の評価結果 | `/data/module-cache/speaker` | `codexia_speaker_state` |
| Semantic の検索索引と埋め込み、取得可能なモデル | `/data/module-cache` とモデルキャッシュ | 文書 revision と固定モデルから空のキャッシュへ再構築。対象ごとに実測 |
| ジョブの実行コンテキスト、SSE 接続、転送用一時ファイル | プロセス内または一時領域 | ジョブの確定記録は DB から回復し、実行途中のジョブは既存の中断状態へ収束 |
| VM 設定、運用資格情報、OS ログ、独立復旧証拠 | 各運用面 | 既存手順で再配備または取得 |

Speaker の推論と再学習は、存在する gate を読み、欠損時には空の gate を使う。
同じ原稿を復元しても gate の有無で結果が変わるため、適用済み gate と表示済み評価を保持する案とする。
評価の再実行で代替する案は、評価を実行した事実、使用した入力、適用の有無を復元できる場合に再評価する。
[Speaker の格納と利用箇所](../../modules/speaker/src/index.ts)

## PostgreSQL の物理定義

スキーマを分けた行指向の表を使う。
単一 JSONB スナップショットでも旧ファイルの原子的な置換はできるが、ジョブの識別子、cursor と writer の所属を SQL で検査できず、一つの cursor 更新で無関係なデータを一括更新する。
行を分け、可変の結果や評価本文だけを上限付き JSONB とする。

| 表 | 主キーと主要列 | 制約 |
| --- | --- | --- |
| `codexia_job_history.job` | `id text`。種別、owner key、project key、type、status、progress、result JSONB、エラー、作成時刻、更新時刻、終了時刻 | 現行の全体 ID 一意性と terminal 状態の不変性。終了時刻は terminal 状態と対応。再送は同一 identity と内容を要求 |
| `codexia_job_history.inbox` | `id text`。job ID、type、project key、通知文、状態、既読、作成時刻、既存 user ID | 独立した保持期限。元ジョブが既に保持対象外の通知があり得るため、job の削除と連動させない |
| `codexia_activity.cursor` | `(owner_key, project_id, device_type)`。scene ID、sentence offset、page index、更新時刻、現行 writer key | 端末種別、入力範囲、scope を検証。現行 writer は同じ cursor の writer 行を遅延外部キーで参照 |
| `codexia_activity.writer` | `(owner_key, project_id, device_type, writer_key)`。sequence、page sequence を `bigint` で格納 | 対応する cursor への外部キー。sequence は JavaScript の正の安全整数範囲、page sequence は 0 以上で sequence 以下 |
| `codexia_speaker_state.evaluation` | `(project_id, project_version, engine_identity)`。評価結果 JSONB、評価時刻 | project と source revision に結合。engine identity は module、engine、tokenizer と採用モデル revision を含む |
| `codexia_speaker_state.rule_gate` | `(project_id, project_version, engine_identity)`。gate JSONB、適用時刻 | 評価のみの操作で既存 gate を変更しない。空の gate の適用と未作成を区別 |

旧ジョブの project key と owner key、最近活動の owner key と writer key は SHA-256 値のまま保存する。
関連する公開 ID を推定して補わず、ジョブ新規登録時にも既存の scope 計算を使用する。
既に検証済みの project と一致しない旧ジョブは、由来と閲覧可能範囲を移行元で確認できる場合に限り元の key で保全し、確認できない場合は移行を停止する。
Recent Activity の project と device は平文の cursor 属性と突合できるため、scope を検証してから cursor と writer の組に変換する。
[ジョブの旧形式](../../packages/api/src/job-history-store.ts) と [Recent Activity の旧形式](../../packages/api/src/recent-activity-store.ts)

ジョブの結果確定、通知生成、未読通知の置換と保持上限の適用を同じトランザクションで行う。
競合する書込みは DB 内で直列化し、既存の最大 500 ジョブ、200 通知、結果 8 MiB、合計 32 MiB と実行中の結果予約を維持する。
SSE に publish する時点はコミット後とし、API 再起動時は未完了のライブジョブを既存の中断状態に変更する。
ジョブ ID の衝突拒否は保持中の行に対して維持し、保持期間を超えた ID の永久記録を別途持つ案は採用判断から分ける。

Recent Activity は対象 cursor をロックし、cursor と writer の順序を同じトランザクションで更新する。
古い再送による変更を拒否し、既存の同一 writer と同一 scene の条件を満たす遅延ページだけを、新しい cursor の時刻や位置を変えずに反映する。
順序ヘッダーを送らないクライアントの書込みは現行 writer を解除し、過去の sequence は保持する。
維持すべき旧ファイルの上限は 20,000 partition と、cursor および order の各 16 MiB。
DB の物理サイズに依存せず、従来と同じ論理サイズの尺度で上限を検証する。

### DB ログインとスキーマの所有

採用候補は、ジョブ、Recent Activity、Speaker の各スキーマに管理者が管理する専用の `NOLOGIN` 所有者と DML 用権限を設け、三領域の DML 用権限を既存のアプリケーション DB ログインに付ける構成とする。
いずれの領域も同じ API プロセスで処理するため、この案では新しいランタイム秘密が増えない。
スキーマと表の `PUBLIC` 権限を取り消し、所有者権限、DDL、ロールや grant の変更は管理および移行主体に限定する。
新規三領域の権限を認証またはバックアップのログインに付与せず、それらの権限もアプリケーション DB ログインに追加しない。
一つの API 接続が侵害された場合、共有ログインに許された三領域の DML が影響を受ける。

領域別ログイン案は、ある接続の権限を使って別スキーマを操作できないようにする必要がある場合に比較する。
すべての資格情報を同じ API プロセスが持つ構成では、プロセス全体の侵害範囲は分離できない。
分離案の採用には、接続の使い分け、VM での資格情報の生成と独立保全、復元時のロールと接続の再構成を新たに承認する必要がある。
承認時には共有案が許す影響範囲を受容するか、別の実行境界を要求するかを DB 詳細契約に記録する。

新規 DB と復元済み DB の両方で、`pg_catalog` と pgTAP を使い、role membership、schema ownership、default privileges、対象表の DML と DDL の実効権限を照合する。
実際の各ログインで試し、所有者への `SET ROLE`、追加 grant、認証とバックアップの各ログインによる新規表へのアクセス、アプリケーション DB ログインによる対象スキーマの変更を拒否できることを確認する。
[PostgreSQL 契約検証](POSTGRES-CONTRACT-VERIFICATION.md)

## 既存データの移行

移行は [通常更新](../deployment/UPDATE-FLOW.md) の互換条件外となるため、対象 ledger と履歴形式を限定した一回の独立保守操作として承認する。
現行 R8 の ledger 不一致拒否と R4 の DB 不在判定を維持する。
保護された production queue、既存 host lock、writer 停止、現行の DB と history の独立保全と復元証明を移行前に要求する。
汎用 Cutover の仕組みや継続稼働する移行サービスは設けない。

1. 移行元、旧候補と新候補の exact-source identity、DB cluster、旧 ledger、独立保存先の receipt を照合する。隔離ホストにバックアップを復元し、同じ入力と候補で移行をリハーサルする。
2. writer 停止を確認して旧 history と対象の Speaker ファイルを読取専用で固定する。現行 v2 backup の対象は DB と history である。復旧担当者が対象の Speaker gate と評価結果を別途暗号化してオフ VM に保全し、固定した source と manifest digest を既存の保護された移行記録に結び付ける。隔離リハーサルでは両方の保全物を同じ停止時点の入力として復元する。
3. 既存の型検査とサイズ、所有者、file mode、送信元 identity の検証を通してから取り込む。Recent Activity の order key を cursor と照合し、同じ writer が最後に書いたと記録されている場合は、旧形式の `itemHash` を cursor 内容と照合する。cursor と order の片側だけが更新された状態、未知の旧形式、欠損、重複または scope 不明の入力は無変更停止とする。空の初期状態は実際の不在を確認できる場合に限って受理する。
4. 適用済み SQL を改変せず、既存 ledger と advisory lock に沿って新しい catalog と検証済み行を確定する。source fingerprint、行数、scope 別の内容 digest、read 状態、cursor と writer の順序を照合する。同じ source からの再試行は既に確定した内容を再検証し、差分や未知の途中状態を既存データに上書きしない。データの冪等性を証明する記録は既存の保護された保守記録に結び付け、旧形式の `legacySources` も照合対象に含める。
5. Tunnel を閉じたまま候補 API を立ち上げ、通常の権限、owner、履歴の読み取り、readiness を確認する。新しい書込みを受理する前に失敗した場合は、旧 DB と旧ファイルの整合点を検証した上で承認済みの復旧に進む。候補が書込みを受理した後の失敗は、保存済みの新規データを含む回復点を決めてから復旧する。

### history の読み取りとバックアップの切替順

1. 現行の v2 と Speaker の追加保全を成立させ、両方を使って移行をリハーサルする。
2. 移行を受け入れた DB を唯一の書込み先にする。通常 API から旧ファイルへの参照と書込みを外す。独立保全から復元した DB を、旧 history と旧 `/data` をマウントせず隔離環境で検証する。この時点でも稼働環境の v2 producer が取得に使う history volume と、旧環境の復旧に必要な保全資料は保持する。
3. DB 専用方式の承認後、空の VM で独立復元を実証し、通常更新の事前保全が成立することを確認する。論理方式の v2 内の簡素化はこの順序に依存しない。[バックアップ運用](../deployment/BACKUP.md)
4. DB 専用方式に切り替えてから、新規取得に不要となった history volume、環境変数、旧ファイル実装と保守ツールを撤去する。archive、receipt、鍵および旧保全物の読取・復旧手順は承認済みの保持期限まで復旧担当者が利用できるようにする。保全物の削除は別の運用判断とする。

## 実装と復旧の受入

| 対象 | 証拠 |
| --- | --- |
| 新規 DB | 認定候補の Core と Full が history mount なしで API、認証、作品と新規状態を扱える。DB schema、権限、同一クラスタを pg_catalog と pgTAP で照合 |
| ジョブと通知 | terminal 再送、ID 衝突、再起動、容量超過、並行更新、DB 停止、コミット失敗を実 PostgreSQL で再現。成功状態と SSE がコミット済みの結果と通知に一致 |
| Recent Activity | device と project 分離、同一 ID の再送、順序逆転、遅延ページ、順序ヘッダーなし、DB 障害と API 再起動で既存の結果と拒否を照合 |
| 移行 | 旧 source の内容、owner と project、通知と順序、Speaker の適用 state を比較。途中中断、source 改変、cursor と order の不整合、権限拒否、再試行を実 DB で検証 |
| 独立復旧 | 新規の隔離 VM に構成と資格情報を正規手順で復元。独立保存先から DB を戻し、作品、owner、運用設定、ジョブ、既読、cursor、gate、API readiness を照合。空の派生キャッシュから固定モデルと索引を再生成 |

CI の検証は合成データと認定候補を使う。
実環境の移行可否は、独立復元に成功した保全証拠と対象 VM のデータ調査をもとに、運用者が別途判断する。
