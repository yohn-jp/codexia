# サーバー永続状態の PostgreSQL 移行案

**種別は設計提案。** REQ-DATA-005 のデータ集約目標は採用済みであり、本提案の物理定義、権限境界、移行手順は承認を要する。
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

管理者が新規スキーマを所有する権限グループを設定し、各スキーマの `PUBLIC` 権限を取り消す。
API には既存の VM 上の DB 接続から必要な行操作だけを許し、DDL と移行操作を管理者に限る案とする。
この案では API プロセスの認証情報を共有するため、一つの API 接続が侵害された場合に三領域の DML を相互に隔離できない。
別ログインへの完全分離はその境界を強化する一方、資格情報の VM 生成、再配備、独立復旧を追加で設計する必要がある。
承認時はどちらを要求するかを明示し、`codexia_auth` と `codexia_backup` への横断 grant を禁止する。
移行の証明には pg_catalog と pgTAP を使い、schema ownership、default privilege、API による DDL 拒否、認証ロールとバックアップロールの新規表へのアクセス拒否を実 DB で照合する。
[PostgreSQL 契約検証](POSTGRES-CONTRACT-VERIFICATION.md)

## 既存データの移行

移行は [通常更新](../deployment/UPDATE-FLOW.md) の互換条件外となるため、対象 ledger と履歴形式を限定した一回の独立保守操作として承認する。
現行 R8 の ledger 不一致拒否と R4 の DB 不在判定を維持する。
保護された production queue、既存 host lock、writer 停止、現行の DB と history の独立保全と復元証明を移行前に要求する。
汎用 Cutover の仕組みや継続稼働する移行サービスは設けない。

1. 移行元、旧候補と新候補の exact-source identity、DB cluster、旧 ledger、独立保存先の receipt を照合する。隔離ホストにバックアップを復元し、同じ入力と候補で移行をリハーサルする。
2. writer 停止を確認して旧 history と対象の Speaker ファイルを読取専用で固定する。Speaker ファイルの保全方法を移行承認に含める。現行 v2 backup の対象は DB と history であり、`/data` にある gate と評価結果の保全は v2 artifact の成功だけでは確認できない。
3. 既存の型検査とサイズ、所有者、file mode、送信元 identity の検証を通してから取り込む。Recent Activity の order key を cursor と照合し、同じ writer が最後に書いたと記録されている場合は、旧形式の `itemHash` を cursor 内容と照合する。cursor と order の片側だけが更新された状態、未知の旧形式、欠損、重複または scope 不明の入力は無変更停止とする。空の初期状態は実際の不在を確認できる場合に限って受理する。
4. 適用済み SQL を改変せず、既存 ledger と advisory lock に沿って新しい catalog と検証済み行を確定する。source fingerprint、行数、scope 別の内容 digest、read 状態、cursor と writer の順序を照合する。同じ source からの再試行は既に確定した内容を再検証し、差分や未知の途中状態を既存データに上書きしない。データの冪等性を証明する記録は既存の保護された保守記録に結び付け、旧形式の `legacySources` も照合対象に含める。
5. Tunnel を閉じたまま候補 API を立ち上げ、通常の権限、owner、履歴の読み取り、readiness を確認する。新しい書込みを受理する前に失敗した場合は、旧 DB と旧ファイルの整合点を検証した上で承認済みの復旧に進む。候補が書込みを受理した後の失敗は、保存済みの新規データを含む回復点を決めてから復旧する。

移行後の通常運用は DB のみへ書く。
旧ファイル、volume、旧メンテナンスツールの撤去は、旧 history を参照せずに復元と通常運用が成立し、[バックアップ運用](../deployment/BACKUP.md) の既存保全を置き換える方式が別途承認されてから実施する。
既存の復旧資料の削除は、この設計の移行操作から分離する。

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
