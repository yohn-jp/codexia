# GitHub Pages 機能・公開物の棚卸し

**観測台帳（非規範）**。対象は Repository Audit Pages の生成物。
画面の設計は [Pages 統合ポータルの UX 設計](../design/DEVELOPMENT-PAGES-UX.md) が所有する。

## 統合ポータルの生成物

単一の [Repository Audit Pages ワークフロー](../../.github/workflows/repository-audit.yml) が次のルートを同一の静的サイトに収録する。
公開先は GitHub Pages のプロジェクトパス `/codexia/`。

| サイト相対ルート | 機能 | データの範囲 |
| --- | --- | --- |
| `/` | Development Portal | サイトマップとデータ出典。サイト全体の台帳は `site-manifest.json` |
| `/api/` | API Reference | TypeSpecから生成したOpenAPI 3.1をScalarで静的表示。contractの出典・生成器lock・入力digest・出力digestを`site-manifest.json`と`api/manifest.json`に記録 |
| `/architecture/` | Architecture Atlas | ビルド対象 SHA の LikeC4 モデルと正本 Markdown。図の URL ハッシュと原文行を保持 |
| `/graph/` | Code Map | 同じビルド対象 SHA から Graphify が抽出した静的参照。既存の `?file=` と集約概観の URL を保持 |
| `/ci/` | CI Observatory | 閲覧時に公開APIからPRリビジョン一覧をページ単位で取得。選択したリビジョンだけjob/stepを取得。API履歴制約・未解決runを明示し、個別タスク時間は未計測 |
| `/security/` | Code scanning export | 利用者ブラウザーの読み取り専用認証で `main` の全状態アラートを GitHub API から取得、JSON/CSV に出力。公開ファイルに検出情報なし |
| `/audit/` | Source Audit | 公開リポジトリで観測したブランチ HEAD。root の `manifest.json` と SHA 別の snapshot、review の URL を保持 |

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

## PR #646 時点の観測記録

以下は統合ポータルの実装前に確認した出力と不足の記録。
GitHub Pages の配信先は当時の確認環境から未確認。

### 1. 公開制御と信頼境界

- **唯一のPages公開者:** [Repository Audit Pages](../../.github/workflows/repository-audit.yml)。`main`の`push`または`workflow_dispatch`で監査サイト一式を生成・Pagesに公開する。PRでは同じパッケージング処理を実行し、`repository-audit-preview` artifactへ保存するが公開しない。別のGraphify/CI/Atlas専用publisherはない。
- **同じ静的サイト内のデータ取得方法は異なる。** Auditはビルド時のremote branch HEADをパッケージし、Architecture/Graphはビルド時にcheckoutされたソースSHAを参照する。CIはページ閲覧時にブラウザーからGitHub Actionsの公開REST APIを取得する。日時・SHA・対象範囲を一律の「最新」と表示できない。
- **実行環境:** 監査は`repomix@1.19.0`と`@alibaba-group/open-code-review@1.13.13`を使用。Graphは`graphifyy[sql,terraform]==0.9.120`の`extract --code-only`と`cluster-only`（LLMなしの標準hubラベル）。Architectureは`@mermaid-js/mermaid-cli@12.2.0`のCLI+ChromeでSVGを生成し、Playwrightで表示を確認する。これらはPages公開物を生成するビルド依存であり、ブラウザー上の管理権限ではない。
- **公開データ:** 全ブランチの監査対象ソースを`repomix.json`と分割JSONで配布する。ルールによる秘匿ファイル・履歴・vendored skillの除外があるが、**それだけで非公開ブランチの機密性を証明しない**。公開対象の認可、漏えい検査とPages可視性の検討が必要。
- **非目標:** GitHub PagesはCodexia本番アプリのCloudflare Workers UI（`/console`を含む）ではない。PagesからVM、Ansible、Better Auth、原稿を操作しない。診断表示をCI合格、マージ可否、未使用コードの証拠と混同しない。

### 2. 現在のルートと生成元

| URL / 出力 | ユーザーができること・生成物 | 実装根拠 | 状況 |
| --- | --- | --- | --- |
| `/` | ブランチ・HEAD SHA・監査成功/partial/blocked・対象ファイル数を一覧し、全体/分割JSON、manifest、OCRレビュー入力へ移動 | [Audit exporter `renderIndex`](../../scripts/audit/export.mjs)、[delegate](../../scripts/audit/delegate.mjs) | 実装コード確認 |
| `/manifest.json` | 実行時点のブランチHEAD、snapshot/reviewの可用性と対象などを配布 | [exporter](../../scripts/audit/export.mjs) | 実装コード確認 |
| `/snapshots/<SHA>/manifest.json` | ソース選定・除外理由・パッケージ整合性を参照 | [exporter](../../scripts/audit/export.mjs) | 実装コード確認 |
| `/snapshots/<SHA>/repomix.json` | SHA単位の全体ソース監査JSONをダウンロード/表示 | [exporter](../../scripts/audit/export.mjs) | 実装コード確認 |
| `/snapshots/<SHA>/part-####.json` | アーキテクチャ、フロント、API、永続化等の責務別ソースを参照 | [exporter](../../scripts/audit/export.mjs) | 実装コード確認 |
| `/reviews/<SHA>/index.html` | Gemini等の**レビュー用入力資料**の対象ファイル/除外を確認 | [OCR delegate](../../scripts/audit/delegate.mjs) | 実装コード確認 |
| `/reviews/<SHA>/{gemini-review.md,gemini-diff.md,manifest.json,preview.json,rules.json}` | 同一SHAの完全/差分レビュー入力、選定ルールとカバレッジを取得 | [OCR delegate](../../scripts/audit/delegate.mjs) | 実装コード確認。AIによるレビュー結果ではない |
| `/ci/` | PR/SHA選択、ジョブ時系列、実行/待ち時間、blocking chain、最長step、履歴比較、診断JSONコピー | [CI entry](../../scripts/ci/dashboard/site/index.html)、[browser client](../../scripts/ci/dashboard/site/dashboard.js) | 実装コード確認 |
| `/ci/dashboard/{collection.mjs,analysis.mjs,diagnostics.mjs,timing.mjs}`、`/ci/impact/contract.mjs`、`/ci/verify.yml` 等 | ブラウザーCI解析の同梱ソース。利用者のUIページではない | [CI packer](../../scripts/ci/dashboard/collect.mjs) | 実装コード確認 |
| `/graph/` | ファイル・シンボル検索、ディレクトリ別の直接参照、参照元なし候補抽出、参照元/先一覧、隣接グラフ、SHA固定ソースリンク | [Graph packer](../../scripts/graphify-pages/pack.mjs)、[explorer](../../scripts/graphify-pages/explorer.html) | 実装コード確認 |
| `/graph/?file=<path>` | 選択ファイルのディープリンクを開く。入力は生成済みindex内のパスに限定 | [explorer](../../scripts/graphify-pages/explorer.html) | 実装コード確認 |
| `/graph/communities.html` | Graphify本来の集約コミュニティHTMLに、同一SHAのコミュニティ詳細・内部グラフ・構成要素・依存関係の探索を追加 | [Graph packer](../../scripts/graphify-pages/pack.mjs) | 実装コード確認 |
| `/graph/source.json` | 元SHAと集約件数・抽出モードを参照 | [Graph packer](../../scripts/graphify-pages/pack.mjs) | 実装コード確認 |
| `/architecture/` | LikeC4 のシステム構造と運用トポロジー、Mermaid の画面・状態・ER・導入・更新の図を開く。拡大・縮小、元行、hashディープリンクを利用できる | [Atlas packer](../../scripts/architecture-diagrams/pack.mjs)、[viewer](../../scripts/architecture-diagrams/index.html) | 実装コード確認 |
| `/architecture/#<group>-<index>` | SHA/文書/行の紐付く図へ直接移動する。ビルド時の`manifest.json`に存在するIDに限る | [Atlas JS](../../scripts/architecture-diagrams/atlas.js) | 実装コード確認 |
| `/architecture/manifest.json`、`/architecture/likec4/`、`/architecture/svg/*.svg` | 図の原文所在、SHA、LikeC4 モジュールと Mermaid SVG を配布 | [Atlas packer](../../scripts/architecture-diagrams/pack.mjs) | 実装コード確認 |

`/docs/`、`/audit/`、`/pages/` は**現行生成経路で公開済みと確認できない**。仮のサイトマップから存在するURLとして案内しない。

### 3. 機能詳細と観測上の限界

#### A. ソース監査 / OCRレビュー入力

- Remoteの`refs/heads/*`を観測したHEADごとにRepomixを実行し、前回の整合済みSHAはcache再利用する。branchはパッケージング中・公開後に進む可能性がある。
- 収録対象はGit blobの正規ファイルに限定し、`evidence/`、vendored agent skills、`.env`/`.pem`等の一部、非UTF-8/binary、サイズ上限等を除外する。Repomix固有の除外で`partial`になり得る。`blocked`はダウンロード不可。
- 責務ごとに最大9分類の分割JSONが作成される。OCRの`gemini-review.md`は**AIレビューを実行した結果ではなく、選定された差分・ソースを含む入力資料**。レビュー対象漏れ・欠落理由の表示が必要。
- 根本の制約: HTMLのトップはbranch一覧とダウンロードが主役。サイト内の機能探索やGraphへの直接入口がない。

#### B. CI Observatory

- [collector](../../scripts/ci/dashboard/collection.mjs)は公開GitHub APIから最大2ページ、直近200件程度のPR実行を取得し、実行されたSHAへの関連付けが一意な履歴に絞る。PRとSHAに基づく`Verify Codexia`を中心に20件程度の選定結果を出す。
- [analysis](../../scripts/ci/dashboard/analysis.mjs)はVerifyの公開`needs` DAG、step時刻、実行待ち、最長完了ジョブ、certification tailを分析。`diagnostics.mjs`はソースに結びついた比較・観測上の欠落を機械可読JSONへまとめる。
- 失敗/中断/skip、step時刻欠落、APIアクセス制限、切詰められた履歴を成功またはゼロとして扱わない。
- 限界: **task単位の時間・CPU/メモリ/IO・playwright specの真のコスト、全required check/branch protectionは可観測ではない。** 既存UIの「診断JSONコピー」はこの欠落を補完しない。

#### C. Graphify Code Map

- `graphify extract . --code-only`のAST由来`graph.json`を使用。`tests/**`、`docs/**`、`evidence/**`、`.agents/**`、`*.test.*`、`*.spec.*`を解析から除く。Graphifyの`source_file`を同じcheckoutの`git ls-files`と突き合わせ、追跡ファイルに限り索引化する。
- 現行explorerにはパス/シンボル検索、ディレクトリフィルタ、参照元なしフィルタ、1ファイルの参照先/参照元、グラフ上のクリック・キーボード選択、SHA固定GitHubソースへのリンクがある。画面中央の隣接グラフは**各方向最大8件**、下のリストは直接隣接の全件を扱う。検索結果一覧は**先頭200件**。
- ファイル間エッジは`imports`、`imports_from`、`re_exports`、`calls`、`references`、`depends_on`、`instantiates`、`inherits`、`implements`、`extends`、`uses`の限定された静的観測を集約する。複数エッジは件数と関係種別を保持するが、表示はファイル単位が中心。Graphify HTMLは別のコミュニティ概観として保持し、同一の解析結果から索引化された構成要素と関係だけを詳細表示する。
- 限界: 解析対象外ファイル、動的import、MCP登録、ルート登録、DBアクセス、CIの実行、リフレクション等の実行時到達を証明できない。**参照元0件 ≠ 未使用/削除可能**。多段探索、エッジの位置・根拠へのjump、変更前後比較、入口からの到達性と解析カバレッジの説明は現行UI/packingにない。

#### D. Architecture Atlas

- 正本Markdownの`mermaid`フェンスを抽出してSVG化し、SHA・文書パス・原文行・図ID付きのmanifestへ収録。選択、hash、zoom、SVG単体を提供し、Mermaid/CDNのブラウザー実行には依存しない。
- Atlasが表示するのは**設計上の状態遷移**であり、動く画面・認証された本番API・実装済みの機能とは一致しない場合がある。画面単位のUIプレビュー、コードの該当箇所、E2Eの証拠への関連付けは未定義。
- 既存viewerは独立CSS/ナビゲーションを持ち、サイト全体で共通のナビゲーション/情報設計は生成されていない。

### 4. ナビゲーションと公開の観測

| 入口 | 現行ナビゲーション | 不足 |
| --- | --- | --- |
| `/` | CI、Architecture、Repository（GitHub） | Graphへのトップ入口、サイトマップ、機能説明 |
| `/ci/` | Source audit、GitHub Actions | ArchitectureとGraphへの統一した移動 |
| `/graph/` | ファイル探索、communities、CI | トップ・Architecture・Auditへの共通導線 |
| `/architecture/` | Source audit、CI、Graph、原文GitHub | 図→対象ファイル→証明済みCIの関連づけ |
| `/reviews/<SHA>/` | 同じSHAのレビュー入力と選定情報 | 共通ヘッダー/パンくず・監査の戻り先 |
| `/snapshots/<SHA>/` | JSON/manifestの直接取得 | ユーザー向け目次/説明、所有者と公開範囲の明示 |

#### 版の正本

- Audit: **リモート各ブランチの観測HEAD**。個別ブランチごとにSHAが異なる。
- Graph: **ページ生成時のcheckout SHA**。コードのみのGraphify観測。
- Architecture: **同じビルドのcheckout SHA**。Markdownから生成した図の版。
- CI: **閲覧した時点の公開APIの一部**。結果の観測時刻はサイト生成時刻と同じではない。
- 文書リンク: GitHub上の`main`またはAtlasのSHA固定行。`main`リンクが現在のAtlasの図と異なる版を指す可能性がある。

### 5. 不足機能台帳（設計候補）

**P0 = 先に信頼・ナビゲーションを成立させる。P1 = 目的の分析を完結させる。P2 = 拡張。** これは現行動作の観測に基づく設計候補であり、すべての実装が承認済みという意味ではない。

| ID | 優先 | 現行と根拠 | 不足/必要な到達状態 |
| --- | --- | --- | --- |
| PG-01 | P0 | Audit `renderIndex`が`/`のHTMLを所有 | サイト総合トップと全機能サイトマップが必要。Auditは二次入口に切り出す案を評価 |
| PG-02 | P0 | 各ツールの`index.html`が別々にナビゲーションを定義 | 共通ヘッダー、カテゴリ、戻り先、深いURLを統一 |
| PG-03 | P0 | Audit branch HEADのソースJSONをPages配信 | 公開範囲/秘匿情報/未公開ブランチの承認と公開前検査を設計・検証 |
| PG-04 | P0 | Graphの`tests/**`等は除外、解析対象の割合不明 | tracked/対象/抽出成功/除外/未観測を明示するcoverage・confidence表示。未使用判定の禁止 |
| PG-05 | P0 | Audit/Graph/Atlas/CIで「現在」の基準が異なる | 出典・SHA・生成/観測時刻・切詰め/欠落・静的/ライブをツール別に表示 |
| PG-06 | P1 | Graphは選択ファイル中心の直接隣接グラフ・方向別上位8件 | 方向・関係種別・深さを制御できる多段ファイル/シンボル探索、重複や循環の処理 |
| PG-07 | P1 | Graphは各ファイルのsymbol文字列とedge集約 | シンボル・エッジの出典ファイル/行と信頼度へjump。Graphifyに出典座標がない場合は「未取得」と表示 |
| PG-08 | P1 | Graphは単一checkout SHAの解析のみ | 指定された2つの認証済みソース間でファイル/エッジ差分・解析対象差異を検証して表示 |
| PG-09 | P1 | Graph解析は静的ファイル間参照中心 | entrypoint/route/MCP/CI参照から到達を**別の検証ソース**で補足し、参照元0件を削除根拠にしない |
| PG-10 | P1 | CIはGitHub公開step時刻のみ | 真のtask別費用を扱うにはCI証拠artifactと権限/データモデルの合意が必要。未計測の値を推定しない |
| PG-11 | P1 | CIは選定run/PRに限定 | 全required check、workflowの切詰め、certificationの範囲を区別。全グリーン判定を誤表示しない |
| PG-12 | P1 | AtlasはSVG図の選択・元行リンク | 論理画面→サムネイル/UX契約/関連ファイル/テストへの横断を、SHA一致で成立させる |
| PG-13 | P1 | 発行物のサイト全体のmanifestなし | ページごとの出典・版・生成ステータス・導線を検査するサイト登録台帳 |
| PG-14 | P1 | 個別HTML/CSSでPC/モバイルのルールが分離 | アクセシブルな共通ナビ、レスポンシブレイアウト、キーボードとfocus/状態保持を検証 |
| PG-15 | P2 | `/reviews/<SHA>/`はレビュー資料配布のみ | Review資料の意味・coverage・SHAの戻り先を一貫した画面で示す |
| PG-16 | P2 | docsはGitHub文書リンクが正本 | Pages内`/docs/`ミラーの要否を検討。現段階はGitHub正本への直接リンクで十分 |

### 6. 調査の証拠と未確認事項

確認した生成元: [publisher](../../.github/workflows/repository-audit.yml)、[audit exporter](../../scripts/audit/export.mjs)、[delegate](../../scripts/audit/delegate.mjs)、[CI packer](../../scripts/ci/dashboard/collect.mjs)、[CI client](../../scripts/ci/dashboard/site/dashboard.js)、[Graph packer](../../scripts/graphify-pages/pack.mjs)、[Graph UI](../../scripts/graphify-pages/explorer.html)、[Atlas packer](../../scripts/architecture-diagrams/pack.mjs)、[Atlas UI](../../scripts/architecture-diagrams/atlas.js)、および各[既存のCI説明](CI-DASHBOARD.md)・[Graph説明](GRAPHIFY-PAGES.md)・[Atlas説明](ARCHITECTURE-ATLAS.md)。

未確認: 公開Pagesの実到達・現物スクリーンショット、最新main公開のartifact内容、対象全ブランチの公開可否、Graphify実データ内のソース位置属性、GitHub REST APIの現時点のレート制限、現行本番のページセキュリティヘッダー。**これらを未検証のまま「正常」「安全」と記載しない。**

## Code scanning export（2026-11-23 追加）

`/security/` の JavaScript が利用者権限で GitHub REST `/code-scanning/alerts` をページネーション取得する。CodeQL 等の tool 名、状態、位置、ルールをブラウザー内で表示し、認可された取得結果を JSON と CSV で保存する。PAT と API レスポンスは Pages ビルド時に取得しない。ソースは `scripts/code-scanning-pages/`、導線は既存 portal/navigation、受入は Pages の Chromium smoke。
