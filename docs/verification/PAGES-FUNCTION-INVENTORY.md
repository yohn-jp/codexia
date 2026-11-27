# GitHub Pages 機能・公開物の棚卸し

**観測台帳（非規範）**。対象は Repository Audit Pages の生成物。
画面の設計は [Pages 統合ポータルの UX 設計](../design/DEVELOPMENT-PAGES-UX.md) が所有する。

## 統合ポータルの生成物

単一の [Repository Audit Pages ワークフロー](../../.github/workflows/repository-audit.yml) が次のルートを同一の静的サイトに収録する。
公開先は GitHub Pages のプロジェクトパス `/codexia/`。

| サイト相対ルート | 機能 | データの範囲 |
| --- | --- | --- |
| `/` | Development Portal | サイトマップとデータ出典。サイト全体の台帳は `site-manifest.json` |
| `/requirements/html/` | Requirements | 要件台帳から生成した StrictDoc の要求と追跡マトリクス |
| `/requirements/traceability/` | Traceability | 同一ソース SHA の要求、個別義務、実装面の逆引き、テストと取得できた証拠。機械可読版は `traceability.json` |
| `/api/` | API Reference | TypeSpecから生成したOpenAPI 3.1をScalarで静的表示。contractの出典・生成器lock・入力digest・出力digestを`site-manifest.json`と`api/manifest.json`に記録 |
| `/architecture/` | Architecture Atlas | ビルド対象 SHA の LikeC4 モデルと正本 Markdown。図の URL ハッシュと原文行を保持 |
| `/graph/`、`/graph/communities.html` | Code Map、Community Overview | 同じビルド対象 SHA から Graphify が抽出した静的参照。`?file=` によるファイルへの直接リンクとコミュニティの探索を提供 |
| `/ux/` | UX Simulator | 生成された設計と実装の投影、抽出範囲と観測の欠落。来歴は `manifest.json`、投影は `snapshot.json` |
| `/ci/` | CI Observatory | 閲覧時に公開APIからPRリビジョン一覧をページ単位で取得。選択したリビジョンだけjob/stepを取得。API履歴制約・未解決runを明示し、個別タスク時間は未計測 |
| `/security/` | Code scanning export | 利用者ブラウザーの読み取り専用認証で `main` の全状態アラートを GitHub API から取得、JSON/CSV に出力。公開ファイルに検出情報なし |
| `/audit/` | Source Audit | 公開リポジトリで観測したブランチ HEAD。root の `manifest.json` と SHA 別の snapshot、review の URL を保持 |
| `/snapshots/<SHA>/` | Source Snapshot | 対象ファイルと除外理由の manifest、全体および分割の Repomix JSON |
| `/reviews/<SHA>/` | Review Materials | OCR が選定したソースと差分、選定規則、対象範囲を含むレビュー入力 |

共通ナビゲーションと `site-manifest.json` から各機能の入口と出典をたどれる。
台帳は、ビルド時の参照、閲覧時の API 取得、ブランチごとの観測結果を区別する。
UX Simulator の入口は、同じソース SHA の公開用生成物を組み込んだ場合に掲載する。
要求と追跡の出力は、同じソース SHA の StrictDoc と追跡用の入力を照合する。[ポータル生成器](../../scripts/audit/portal.mjs) ／ [仕様公開用生成器](../../scripts/audit/specifications.mjs)

PR ではパッケージを `repository-audit-preview` に保存する。
アップロード前に生成済みサイトの台帳、内部リンク、監査公開物を検査する。
Chromium は 1440×900、768×1024、390×844、320×800 で画面遷移、ディープリンク、監査ファイルのダウンロード、CI API のエラーと再試行を確認する。
PR の `repository-audit-screenshots` には検証時の画面を保存する。
本番公開は main の Pages デプロイジョブが担当し、配信先での受入は対象デプロイに対して確認する。

## API Reference の観測

`/api/` はPagesのsource SHAに固定したTypeSpecとロック済みの依存関係からOpenAPI 3.1を生成し、Scalar 1.83.0のローカルbundleで表示する。
OpenAPIのsecurity scheme、operation、parameter、request/response schema、HTTP status/error responseを読める。
公開画面は現在登録される契約と採用目標の操作を区別する。Fastify 実装では current の操作を生成ルートとスキーマから登録する。動作適合と本番受入は個別の検証証拠を参照する。
security schemeは値を入力するUIを出さず、名称・方式・cookie名の読み取り専用要約を表示する。

Pages生成時に認証operationのrequest/response例を除き、契約に含まれるAPI server定義を公開用コピーから削除する。
ScalarのTry It操作、認証値入力、Authorize controls、AI操作を無効化し、Content Security Policyの`connect-src 'self'`で外部fetchを制限する。
security schemeやerror semanticsは文書に残し、認証値や保護されたschemaの実行時取得は行わない。

`api/manifest.json`にはPages source SHA、TypeSpecから生成したOpenAPIの出力先pathと公開用加工前のSHA-256、Scalar npm integrity、npm lockのpathとSHA-256、bundle出力のSHA-256を記録する。
`site-manifest.json`も同じScalar manifestを保持し、artifact verifierが固定された入力・lock・出力を照合する。
esbuild bundleのEOF legal noticesを残し、ScalarのMIT licenseを`api/THIRD_PARTY_NOTICES.txt`として同一digest registryに含める。
PRでは従来の`repository-audit-preview` artifactにのみ格納し、`main`の同じpublisherだけがPagesへ公開する。
ChromiumのPR smokeは1440、768、390、320 CSS pxで描画とreflowを確認する。公開済みPagesの配信先受入はこのローカルsmokeとは別に扱う。

## 各機能の出典と観測範囲

### 要求とトレーサビリティ

StrictDoc は要件台帳から要求と追跡マトリクスを生成する。
トレーサビリティ画面は個別義務と実装面、テスト、対応する証拠を結ぶ。
要求への適合は、対象の義務に対する実行証拠で判定する。
公開 URL での配信確認はビルドおよび要求適合の検証と別に行う。[要件台帳](../requirements/REQUIREMENT-REGISTER.md) ／ [追跡結果の読み方](TRACEABILITY-REGISTER.md)

### UX Simulator

同じソース SHA の設計正本と正規コードから画面、操作、遷移を別々に抽出し、抽象画面と遷移で比較する。
抽出できていない経路と、対応するソースを取得したが実行を観測していない経路は coverage に表示する。
作者の操作を検証する際は製品のブラウザーと実機の受入を行う。[UX Simulator 契約](../design/UX-SIMULATOR-CONTRACT.md)

### CI Observatory

ブラウザーが GitHub Actions の公開 REST API から PR のリビジョンを順次取得し、選択されたリビジョンについて job と step を表示する。
取得できた履歴には API の上限がある。
タスク単位の CPU、メモリ、I/O や全必須チェックの成否には、別の観測が必要となる。[CI dashboard](CI-DASHBOARD.md)

### Graphify Code Map と Architecture Atlas

Code Map ではファイルとシンボルを検索し、方向、関係種別、探索の深さを選んで静的な参照をたどれる。
表示する関係は対象ソースからの静的抽出に限られる。
未検出の参照元には、抽出対象外のファイルや実行時の登録が含まれ得る。[Graphify Pages](GRAPHIFY-PAGES.md)

Architecture Atlas は、LikeC4 のシステム構造と運用トポロジー、および正本 Markdown の Mermaid 図を公開する。
図へのハッシュ付きリンクと、対象ソース SHA に固定された原文行へのリンクを提供する。
画面や運用を受け入れるには、図が表す契約の挙動を実環境で確認する。[Architecture Atlas](ARCHITECTURE-ATLAS.md)

### Source Audit とレビュー入力

Source Audit は公開リポジトリから観測したブランチ HEAD を索引化する。
各スナップショットの manifest は、対象ファイル、除外理由、生成物のダイジェストを記録する。
`partial` は除外を伴うパッケージ、`blocked` は取得不可を示す。
レビュー資料には OCR が選定した入力とその対象範囲を含む。
正規の監査結果はレビューを実際に行ったときの記録で確認する。[監査出力の生成器](../../scripts/audit/export.mjs) ／ [レビュー入力の生成器](../../scripts/audit/delegate.mjs)

### Code scanning export

`/security/` は、利用者のブラウザーから GitHub REST API に認証付きでアクセスし、`main` の code scanning アラートをページ単位で取得する。
取得したツール名、状態、位置、規則は画面で確認でき、利用者の権限で取得した内容を JSON と CSV に保存できる。
資格情報と API の応答は利用者のブラウザーで扱う。[Code scanning export の実装](../../scripts/code-scanning-pages/)

## 公開境界

Pages は開発資料を静的に配信する。
作者用 UI と管理コンソールは Cloudflare Workers が配信し、作者データと管理操作の入場制御は本番 API が担う。
監査資料の公開前に、公開範囲、除外規則、秘密情報の検査を適用する。
公開 URL の受入は、対象デプロイで配信されたファイル、リンク、来歴を照合する。[公開ワークフロー](../../.github/workflows/repository-audit.yml) ／ [Pages 検証器](../../scripts/audit/portal.mjs)
