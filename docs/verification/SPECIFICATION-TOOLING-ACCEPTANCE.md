# 仕様ツールのCI・設計可視化・公開に関する受入設計

**種別: 採用済み品質ゲート設計・CI未変更。** 本書は [Toolchain](../architecture/SPECIFICATION-TOOLCHAIN.md) のツールを、[CI/CD](CI-CD.md)、[Test architecture](TEST-ARCHITECTURE-OPTIMIZATION.md)、[Traceability](TRACEABILITY-REGISTER.md) に従って**どの証拠で採用可否を判断するか**を所有する。CIの既存 `scripts/ci/impact/contract.mjs` と `.github/workflows/verify.yml` は依然唯一のverification task/plan authority。新しい単独ワークフローを乱立させたり、未実行の検証をpassしたことにしたりしない。

## ツールと責務（対抗案）

| 採用 | 不採用候補 | 受入のために本当に実行する内容 |
| --- | --- | --- |
| Redocly CLI 2 | Spectral | TypeSpec生成OpenAPI 3.1.0のlint/bundle、custom規則、壊れたschema/参照でfail |
| oasdiff | OpenAPI Diff | 前回承認仕様と新仕様のbreaking changes、severity、apiEpochとの整合を検査 |
| Schemathesis | Dredd | 隔離した実HTTP + PostgreSQLでpositive/negative/境界/状態遷移の探索 |
| pgTAP / pg_catalog | ORM生成schemaを唯一のDB証明とする | 実DDL/constraint/index/trigger/roleの列挙と負のtest |
| MCP公式Inspector/conformance | 自作protocol試験エンジン | 2026-07-28 required scenarios、HTTP/stdio相互運用 |
| LikeC4 | Structurizr DSL | 構成要素・接続・信頼境界のモデルと静的ビュー。既存Mermaid状態図を別正本にしない |
| Threagile | OWASP Threat Dragon | リスク/緩和策と実検証要求をコード管理し、CIでモデルを再評価する |
| k6 | Artillery | API/DB/MCP/streamの性能budgetを仕様から定義し、閾値で合否判定 |
| StrictDoc静的HTML + Scalar | VitePress中心 | 要求・source・test・schemaをGitHub Pagesの**既存唯一の公開者**から表示 |
| 既存Actions exact-source evidence | Allureを証拠の第二正本にする | run/job/attempt/artifact identityと結果の厳密な結合 |

## CI validationと適合段階

| 段階 | 検証と生成物 | fail条件 | 速さ/環境 |
| --- | --- | --- | --- |
| G0 ドキュメント静的 | StrictDoc parse、REQ-ID/relationのvalidation、TEST-ID付きネイティブ登録のAST discovery、Markdownリンク、TypeSpec compile | 欠落、重複、不正grammar、無効なreference、登録IDまたはExecution scopeの不整合 | 文書変更時の軽量CI |
| G1 HTTPスキーマ | TypeSpec→OpenAPI 3.1.0、Redocly、oasdiff、実行時 Fastify route inventory と JSON Schema 生成物の照合、Orval client再生成diff、TypeScript typecheck | 実routeの未定義、破壊的変更の無承認、二重schema、非決定的生成 | API/contracts/client変更時 |
| G2 実行時契約 | 使い捨てPostgreSQLのAPIでSchemathesis、owner/BOLA/競合/冪等性/receiptとMCP conformance | 仕様違反/認可迂回/保存不一致、未実行対象の偽PASS | API/MCP/DB変更時 |
| G3 データ契約 | migration適用→pgTAP/pg_catalog、Better Auth schema、復元、tbls生成 | 物理差分/不一致、schema identity異常、復元失敗 | DB/auth/migration/依存変更時 |
| G4 UX/host | 既存Playwright（正式対応Chromium。移行例外は [E2E execution](E2E-EXECUTION.md)）、XState v5の状態遷移義務、OCI、Ansible/Cloudflare config/probes、S3互換fixture | UI保存/復旧、session/auth、backup config/保全job/復元証拠、edge/deploy回帰 | 既存impact rulesに従う |
| G5 設計図/脅威 | LikeC4 validation、Threagile risk、公開の可否と画像/文書リンク | 不正なモデル、設計不整合、秘密露出 | docs/security/deploy変更時 |
| G6 性能 | k6 threshold、現行比較baseline、起動/stream/DB負荷 | 承認済みp95/p99、RPS、RSS、SSE維持等のbudget違反 | cheap smokeはPR、長時間は明示したisolated run |
| G7 追跡・証明 | 要求→仕様→実装→TEST-ID→exact-source evidence、逆引き未追跡一覧 | 未対応の採用済み要求や仕様外runtimeを未報告、証拠偽装、登録した検証scopeの消失 | 部分的にはPR、全量認定はrelease前 |

G0〜G7は受入モデルであり、実行タスクは [CI/CD契約](CI-CD.md) から参照する。
HTTP契約の検証は既存Verifyの `unit-http-contract` と `typecheck-http-contract` を使用する。
検証を追加するときは影響範囲、タスクの入力、実行証拠を同時に更新する。

## 既存REQ-IDから検証義務への接続

本書のG0〜G7の各ゲートは、**新しい独立製品要求ではなく既存要求の検証手段**である。最初の関連付けを以下に固定する（各gateの完全な合否は後続PRでテストにより証明する）。

| 要求 | 対象gate | 必ず確認する内容 |
| --- | --- | --- |
| REQ-TRACE-001 | G0、G7 | REQのID、逆引き、テストおよびexact-source証拠の結合 |
| REQ-API-001 | G1、G2 | method/path、OpenAPI Schema、error/authorizationと実APIの一致 |
| REQ-API-002 | G2、G4 | 原稿保存の冪等性・409競合・receipt・ブラウザ復旧 |
| REQ-DATA-001〜004 | G3、G4 | PostgreSQL物理schema、migration identity、実DB transaction |
| REQ-AUTH-001〜005 | G1、G2、G4 | owner/MCP/setup/readerの分離と、未実装管理目標の区分 |
| REQ-MCP-001〜002 | G2、G4 | SDK v2 transportとread/compute/propose・owner承認禁止 |
| REQ-EXT-001〜002 | G2、G4、G5 | Edgeルーティング、外部OAuth/MCP接続とtrust boundary |
| REQ-UI-001〜005 | G4 | 画面状態・保存保護・IME・アクセシビリティ |
| REQ-OPS-001〜003 | G3、G4 | setup、更新、backup/restoreの実ホスト・実DB証拠 |
| REQ-QUAL-001〜003 | G2〜G7 | 検証の配置、exact-source認証、性能budget |

この対応表だけで各REQのobligationを列挙したことにはならない。業務別の検証シナリオID・source symbol・実行証拠は [Traceability](TRACEABILITY-REGISTER.md) の専用関係で後続詳細化する。G0〜G7の実行・失敗注入が未実施なら要求の適合状態は変更しない。

## OpenAPI lint・diff・runtime検証の分界

- RedoclyはOpenAPI構造、参照、operationId一意性、HTTP status/scheme/response Schema、必要なタグ/説明/trace metadataをチェックする。アプリの認可は保証しない。
- oasdiffは候補のTypeSpecから生成したOpenAPIを基準コミットのOpenAPIと比較する。
  移行前の基準にはGitに保存済みのOpenAPIを使い、移行後の基準はそのSHAの依存ロックと生成スクリプトで再生成する。
  pull requestはイベントの `pull_request.base.sha`、mainへのpushはイベントの `before` SHAを基準にする。
  エラー級の非互換差分、イベントSHAの欠落、生成物とデプロイ互換設定のepoch不一致で失敗する。初回本番導入に限る epoch の限定是正は [API contract](../architecture/API-CONTRACT.md#操作の追加変更廃止) に従う。4 → 5 は基準 SHA と承認済み `ERR` の完全一致を確認する。oasdiff 自体は省略しない。
- Schemathesisは**隔離API**で実行する。書込み可能であるため本番や作者データに接続してはならない。Zod/TypeSpecの正常ケース、status/error/body、security testing、boundary/rate/invalid payload等を補強する。
- Schemathesisによる拒否確認と、Codexiaのowner-only / MCP-proposal / project-BOLA / write preconditionを別々の独立したテストとして保持する。
- 静的なOpenAPI形状を満たしても、opaque cursor、条件付きclient identity、アーカイブ参照整合性、ChangeSetの対象・重複・サイズ、自己mergeは業務上不正になり得る。positive-data検査はその場合に限りcanonical validationの予測と実応答のstatus/code/detailを照合する。それ以外は公式positive-data検査を実行する。適用結果を証拠に保持し、実DBの正常系・拒否系の対照試験も必須とする。単なる400の許容、検査対象除外、結果改変は禁止する。
- HTTP error/codeやoptional responseがTypeSpec上で定義されていない場合、ツールがスキーマを自動修正するのではなくAPI-CONTRACTへ設計決定を戻す。

## LikeC4・Architecture Atlasのownership

- **LikeC4が対象とするのはC4系のsystem context、container/component、依存方向、外部trust relationship。** プロダクト構成の意味は [System design](../architecture/SYSTEM-DESIGN.md) と [Internal boundaries](../architecture/INTERNAL-BOUNDARIES.md) が承認し、LikeC4はその採用設計を可視化する実行可能な構造契約。
- [Architecture Atlas](ARCHITECTURE-ATLAS.md) は、構造・信頼境界と運用トポロジーをLikeC4モデルからネイティブに表示する。画面・状態遷移、配備・更新手順、ER図は領域設計書のMermaidから表示する。
- **Threagile**は攻撃者、脅威、資産分類、リスクと対策・残留リスクを所有する。LikeC4の全構造を別の独立した真実として再記載しない。モデル間の対応は `EXT-*`/`REQ-AUTH-*` 等で参照し、データフロー/境界の相違をCI/レビューの逸脱として記録する。
- C4図/脅威図は「この通信・リスクが設計上存在する」を示す。実環境にEdge ruleが適用されている証明や攻撃不能の証明にはならない。
- 初期のリスク対象: OAuthとMCPのissuer/resource mismatch、BOLA、セッション混同、share-readerの拡張、偽のDB receipt、Cloudflare/Workers・Tailscale管理プレーン交錯、backup鍵/復元、公開Pagesの機密漏えい。

## k6性能・品質予算

数値目標をコードやベンチの観測値から逆算して**自動的に採用済み要求にしない**。UX/性能正本で承認された予算がある場合だけthresholdを置く。未決定の値は提案としてレビューし、勝手に有効なgateへ追加しない。

| シナリオ | 観測する指標 | 再現条件 |
| --- | --- | --- |
| 原稿保存とrevision receipt | p50/p95/p99、409 rate、DB commit latency、RSS | 同一原稿の競合、合成project/DB、同じactor/auth |
| Project/tree/snapshot取得 | cold/warm latency、payload bytes、CPU/DB queries | 作品サイズ・索引・pagination固定 |
| MCP tools.list/read/propose | end-to-end latency、auth denial、eventloop delay | v2 2026 protocol、scoped client、snapshot |
| SSE・通知 | stream確立・keepalive、切断、buffer/backpressure、memory | 同時stream数・継続時間・abort |
| UI入力・復旧 | INP、CLS、ドラフト復元と保存状態 | 既存Playwright/ブラウザー実操作。k6 HTTPだけでは証明しない |
| 配備/初期化 | OCI startup、ready、drain、migration確認 | Core/Full、アプリ/DBバージョン固定 |

PRでは小さな回帰チェック、長時間/高負荷は適切に隔離した条件下で実行。書込を含む試験は使い捨てDBと無権限ネットワークに限定する。

## GitHub Pagesへの公開

**現行ガバナンス:** [Pages inventory](PAGES-FUNCTION-INVENTORY.md)、[Architecture Atlas](ARCHITECTURE-ATLAS.md)、[Development Pages UX proposal](../design/DEVELOPMENT-PAGES-UX.md)。唯一の公開者は `.github/workflows/repository-audit.yml`、別のpages publisher/VM/Cloudflare secretsを追加しない。提案中の `/audit/` 移動などのURLを本書で暗黙採用しない。

- Repository Audit PagesはStrictDoc、Scalar、LikeC4の公開用生成物を組み立てる。
- Scalarリファレンスはサイト相対 `/api/` に置く。
  生成OpenAPIの許可された操作、入出力、認可スキーム、エラーを表示し、現在の操作と未実装の目標を識別できるようにする。
  Chromiumで契約への移動、検索、操作詳細、狭い画面と既存ルートを検証する。
- `/architecture/`、`/graph/`、`/ci/`、`/snapshots/<SHA>/` は既存URLを維持する。
- 本番APIに直接通信する `Try it out` や認証セッション/保護されたschemaの自動露出はしない。Scalarで許可するのは公開可能な静的契約表示。API実行は隔離した検証環境だけ。
- 生成manifestには各結果のsource SHA、generator/依存lock identity、入力契約ファイル、使用したOpenAPI/schemaのdigest、生成時点、private/public判定を保持する。
- PR previewでは公開せず従来のartifactへ格納し、mainの正規公開にのみ昇格する。GitHub Pages自体がCodexiaの本番Workers UI/Owner consoleになることはない。

## 証拠の取り扱いと完成判定

TEST nodeは`Execution scope`に`TRACE_NODE`、`TRACE_BROWSER`、`PRODUCT`を宣言する。
テストのネイティブ登録には文字列リテラルの`[TEST-ID]` prefixを置き、AST discoveryがTEST-ID、source path、行、表示名を抽出する。
一つのケースを複数の独立TEST-IDが参照するときは、異なるID prefixを登録タイトルの先頭に連続して置き、それぞれを同じ登録へ対応させる。
Requirement RegisterはobligationとTEST-IDだけを結び、手入力の`Case name`、TEST nodeの`File` relation、`Lines`属性を持たない。
実装relationはfile scopeと既存の意味的識別子を保持する。

`TRACE_NODE`と`TRACE_BROWSER`のsource fileは、discovery結果からtrace taskの実行対象に選ぶ。
この仕組みにより、テストを別のsource fileへ移しても、登録されたscopeが同じならCI実行から外れない。
discovery対象のテストsourceだけを変更したPRも既存の`requirements-trace` taskを選択する。
trace taskは従来の固定補助suiteも実行する。
`PRODUCT`は製品検証taskのscopeであり、trace taskによる未実行をPASSへ置き換えない。
実行観測はTEST-IDとdiscovery済みsource identityで結び、exact-source Verify認定とartifact identityの既存条件を維持する。

- CIの検査結果は `PASSED`、`FAILED`、`BLOCKED`、`NOT_SELECTED` を区別し、docsの `VERIFIED` へ昇格するには要求の**対象義務すべて**について成功証拠が必要。
- 追加検証がselectedなら、実行されたjob/attempt/artifactを同じplan digestとsource SHAに束縛する。selectedタスクがskipなら成功判定しない。
- Node `node:test`、Playwright、Schemathesis、pgTAP、conformance、k6の出力は、**実際の情報が含まれる形式で**保持する。report形式に合わせて成功結果をでっち上げない。
- StrictDocへの実行証拠リンクはexternal CI run/artifactを参照し、CI artifactのないソースコード参照をTEST PASSと誤認しない。
- 初期導入PRでは、mockデータ・登録済み全要求の関係と対応、壊れたID/route/schemaの故障注入を合否の基礎にする。範囲外の本番API、private repository data、秘密値を含めない。

## 実行結果の参照

受入結果は、該当するソースSHAのCI run、検査レポート、公開manifestから参照する。
公開済みの静的契約と、実DB、API、ブラウザー、稼働環境での適合は、各検証が実行された範囲で判定する。
