# 仕様ツールのCI・設計可視化・公開に関する受入設計

**種別: 採用済み品質ゲート設計・CI未変更。** 本書は [Toolchain](../architecture/SPECIFICATION-TOOLCHAIN.md) のツールを、[CI/CD](CI-CD.md)、[Test architecture](TEST-ARCHITECTURE-OPTIMIZATION.md)、[Traceability](TRACEABILITY-REGISTER.md) に従って**どの証拠で採用可否を判断するか**を所有する。CIの既存 `scripts/ci-contract.mjs` と `.github/workflows/verify.yml` は依然唯一のverification task/plan authority。新しい単独ワークフローを乱立させたり、未実行の検証をpassしたことにしたりしない。

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
| G0 ドキュメント静的 | StrictDoc parse、REQ-ID/relationのvalidation、Markdownリンク、TypeSpec compile | 欠落、重複、不正grammar、無効なreference | 文書変更時の軽量CI |
| G1 HTTPスキーマ | TypeSpec→OpenAPI 3.1.0、Redocly、oasdiff、Fastify route/JSON Schemaの生成・整合、Orval client再生成diff、TypeScript typecheck | 実routeの未定義、破壊的変更の無承認、二重schema、非決定的生成 | API/contracts/client変更時 |
| G2 実行時契約 | 使い捨てPostgreSQLのAPIでSchemathesis、owner/BOLA/競合/冪等性/receiptとMCP conformance | 仕様違反/認可迂回/保存不一致、未実行対象の偽PASS | API/MCP/DB変更時 |
| G3 データ契約 | migration適用→pgTAP/pg_catalog、Better Auth schema、復元、tbls生成 | 物理差分/不一致、schema identity異常、復元失敗 | DB/auth/migration/依存変更時 |
| G4 UX/host | 既存Playwright（Chromium/WebKit）、OCI、Ansible/Cloudflare config/probes | UI保存/復旧、session/auth、edge/deploy回帰 | 既存impact rulesに従う |
| G5 設計図/脅威 | LikeC4 validation、Threagile risk、公開の可否と画像/文書リンク | 不正なモデル、設計不整合、秘密露出 | docs/security/deploy変更時 |
| G6 性能 | k6 threshold、現行比較baseline、起動/stream/DB負荷 | 承認済みp95/p99、RPS、RSS、SSE維持等のbudget違反 | cheap smokeはPR、長時間は明示したisolated run |
| G7 追跡・証明 | 要求→仕様→実装→TEST-ID→exact-source evidence、逆引き未追跡一覧 | 未対応の採用済み要求や仕様外runtimeを未報告、証拠偽装 | 部分的にはPR、全量認定はrelease前 |

**この表のG0〜G7は要求される受入モデルであり、現状存在するCI task名ではない。** 実装時は `scripts/ci-contract.mjs` / `ci-impact.mjs` / `verify.yml` / release certifierへ一貫して組み込み、既存の20 job目安などのCI予算とindependent task parallelismを保つ。新しい検証を追加しただけで旧検証を消さない。差し替え時は旧テストの検出能力と新テストの合致を示す。

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
- oasdiffはPRの新しい生成OpenAPIと承認済みbaseから生成したOpenAPIを比較する。既存設計で定める `apiEpoch` とcompatibilityを評価し、無条件のbreaking変更を見逃さない。必要な変更は新API epoch/クライアント設計を先に採用する。
- Schemathesisは**隔離API**で実行する。書込み可能であるため本番や作者データに接続してはならない。Zod/TypeSpecの正常ケース、status/error/body、security testing、boundary/rate/invalid payload等を補強する。
- Schemathesisによる拒否確認と、Codexiaのowner-only / MCP-proposal / project-BOLA / write preconditionを別々の独立したテストとして保持する。
- HTTP error/codeやoptional responseがTypeSpec上で定義されていない場合、ツールがスキーマを自動修正するのではなくAPI-CONTRACTへ設計決定を戻す。

## LikeC4・Architecture Atlasのownership

- **LikeC4が対象とするのはC4系のsystem context、container/component、依存方向、外部trust relationship。** プロダクト構成の意味は [System design](../architecture/SYSTEM-DESIGN.md) と [Internal boundaries](../architecture/INTERNAL-BOUNDARIES.md) が承認し、LikeC4はその採用設計を可視化する実行可能な構造契約。
- 既存 [Architecture Atlas](ARCHITECTURE-ATLAS.md) のMermaidは個別画面・状態遷移・初期配備・更新と既存system viewを所有。LikeC4に移行したC4ビューのみ新モデルをownershipとし、元Mermaidの同じC4図は更新元を一本化/派生化する。既存状態遷移のMermaidは削除・無断移管しない。
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

- StrictDocの静的HTML/trace matrix、ScalarのOpenAPI表示、LikeC4から生成した静的図は**Repository Audit Pagesの生成物**として組み込むことを採用目標とする。URLの割当は既存サイトマップと別途照合し、既存の `/architecture/`、`/graph/`、`/ci/`、`/snapshots/<SHA>/` を勝手に壊さない。
- 本番APIに直接通信する `Try it out` や認証セッション/保護されたschemaの自動露出はしない。Scalarで許可するのは公開可能な静的契約表示。API実行は隔離した検証環境だけ。
- 生成manifestには各結果のsource SHA、generator/依存lock identity、入力契約ファイル、使用したOpenAPI/schemaのdigest、生成時点、private/public判定を保持する。
- PR previewでは公開せず従来のartifactへ格納し、mainの正規公開にのみ昇格する。GitHub Pages自体がCodexiaの本番Workers UI/Owner consoleになることはない。

## 証拠の取り扱いと完成判定

- CIの検査結果は `PASSED`、`FAILED`、`BLOCKED`、`NOT_SELECTED` を区別し、docsの `VERIFIED` へ昇格するには要求の**対象義務すべて**について成功証拠が必要。
- 追加検証がselectedなら、実行されたjob/attempt/artifactを同じplan digestとsource SHAに束縛する。selectedタスクがskipなら成功判定しない。
- Node `node:test`、Playwright、Schemathesis、pgTAP、conformance、k6の出力は、**実際の情報が含まれる形式で**保持する。report形式に合わせて成功結果をでっち上げない。
- StrictDocへの実行証拠リンクはexternal CI run/artifactを参照し、CI artifactのないソースコード参照をTEST PASSと誤認しない。
- 初期導入PRでは、mockデータ・登録済み全要求の関係と対応、壊れたID/route/schemaの故障注入を合否の基礎にする。範囲外の本番API、private repository data、秘密値を含めない。

## このPRの完了と次の受入

本書で**ツールごとの検証目的とガバナンスを確定**。実際に生成したTypeSpec OpenAPI、StrictDoc HTML、pgTAP schemaテスト、MCP v2 conformance、k6測定、LikeC4/Threagileモデル、Scalar公開画面、GitHub Actionsの新taskを**作成・実行したわけではない**。後続の導入PRでは、対応するG0〜G7の実行結果とCI影響を区別して報告する。
