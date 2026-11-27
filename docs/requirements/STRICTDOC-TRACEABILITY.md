# StrictDocによる要求・実装・検証追跡の詳細設計

**種別: 採用済み追跡設計・部分適用。** [Requirements governance](README.md) と [Requirement register](REQUIREMENT-REGISTER.md) の既存採用REQ-ID 33件をStrictDoc Markdown nodeへ移行し、HTML/JSON生成・relation検査・CI taskを実装した。要求の正しさや製品適合をStrictDoc単独で証明するものではない。現状のgateと残件を末尾の表に記録する。ツール選定は [Toolchain](../architecture/SPECIFICATION-TOOLCHAIN.md)。

## 二択の結論と適用範囲

- **採用:** StrictDoc。要求の関係・source file/range trace、双方向coverage matrix、静的HTML、JSON/ReqIF exportが中核。
- **不採用:** Sphinx-Needs。強力なDocs-as-Codeだが、Sphinx/MyST、各種need import/link拡張を組み合わせて今回の追跡を構築する設計となる。Codexiaは要求とソース追跡を専門ツールに一元化したい。
- **未保証:** StrictDocのMarkdown機能は公式にexperimental。TypeScript/TSXのAST関数同定は公式な実装済み保証がなく、Node `node:test` / PlaywrightのJUnit形式は、StrictDocが公式に挙げる自動取り込み形式に含まれていない。ファイル/範囲relationとテストID参照が基礎であり、自動symbol coverageやJUnit ingestの完全対応を前提にしない。

公式: [StrictDoc formats](https://strictdoc-project.github.io/formats/)、[Markdown specification](https://strictdoc.readthedocs.io/en/latest/latest/spec/Markdown.md.html)、[Source-code traceability](https://strictdoc.readthedocs.io/en/latest/latest/docs/strictdoc_01_user_guide.html)。

## 仕様のownershipと1回だけの変換

`docs/requirements/REQUIREMENT-REGISTER.md` はStrictDoc nodeの**唯一の編集正本**である。旧台帳の33件のREQ-ID、要求文、決定状態、設計owner参照を一度だけ移行した。現在のaccepted wordingを優先し、実装候補とテスト候補の参照を適合証拠とみなさない。

1. 各`REQ-*`は個別のMarkdown見出しとStrictDoc metadataで管理する。変換時に最新accepted registerと各設計ownerを照合し、`REQ-UI-001`のDesktop React Web / iOS SwiftUI境界を含む現行の要求文と参照を維持した。
2. `REQ-*` の既存IDは変更・再利用しない。`O01/O02` 等の個々の検証義務もrelation可能なnodeまたは検証IDとして管理する。
3. 同一要求をMarkdown表とStrictDoc nodeで**並行編集しない**。Requirement registerだけを編集し、HTML/JSONを生成物として扱う。
4. 既存の自由文・Mermaid・API/DB/External設計のMarkdown全文を機械的にStrictDoc固有dialectへ変換しない。必要な領域正本をURL/UIDで参照する。
5. 生成されたHTML、matrix、JSON、ReqIFは派生物。公開済み表に誤りがあれば要求源と関連付けを直し、生成物を手編集しない。

**Authoring形式:** StrictDoc 0.32.1の拡張Markdown exportを実測した。Grammarは`REQUIREMENT`と`TEST` nodeを定義し、CIは同一sourceから2回HTML/JSONを生成し、HTMLの検索timestamp、確認済みのMarkdown document MID、およびStrictDoc検索indexのkey順と、生成元Python `set`に由来するdocument membership配列順だけを正規化する。membershipの値と他の出力は比較に残す。別のStrictDoc versionやMarkdown機能を使う場合は再評価する。

TEST nodeには、`Execution scope`として`TRACE_NODE`、`TRACE_BROWSER`、`PRODUCT`のいずれかを記録する。テスト実装のネイティブ登録には、安定したTEST-IDを文字列リテラルの`[TEST-ID]` prefixとして置く。AST discoveryは登録からID、source path、行、表示名を導出する。複数の独立したTEST-IDを一つのテストケースが検証する場合は、登録タイトルの先頭に異なるID prefixを連続して置き、各IDを同じsource registrationへ結ぶ。Requirement RegisterのTEST nodeには`Case name`や`File` relationを複製せず、source位置を手入力しない。

AST discoveryは静的な登録を列挙し、実行結果とは別の情報として扱う。discovery対象のテストsourceを変更したPRは既存の`requirements-trace` taskを選択する。テストをStrictDoc trace taskの実行対象から移動しても、登録に付いたExecution scopeからsource fileを再発見して同じsuiteへ含める。`TRACE_NODE`と`TRACE_BROWSER`はStrictDoc trace taskで実行し、`PRODUCT`は通常の製品検証taskで実行する。trace taskで実行しない`PRODUCT`の結果を`NOT_RUN`から昇格しない。

現在の要求nodeは`REQUIREMENT-REGISTER.md`に記録し、StrictDoc grammarとJSON exportをCIで検査する。以下は簡略化した構造例:

~~~markdown
# Codexia requirements

## PostgreSQL is authoritative

**UID**: REQ-DATA-001
**Status**: ACCEPTED

全ての作品本文・Revision等の永続正本はPostgreSQLとする。
~~~

`Decision status`、`Conformance status`、`Applicability`等の属性はrepository grammarとNode verifierで許容値・ID一意性を検証する。実際の要求本文と受入条件は各nodeおよびowner文書が所有する。

## 関係モデル

| 関係 | 始点 → 終点 | 具体的なリンク |
| --- | --- | --- |
| decomposes | REQ → obligation | REQ-API-002 → 保存競合・冪等性・応答不明の各義務 |
| specified-by | obligation → normative design | API-CONTRACTのoperation、AUTHN/AUTHZのprincipal、STATE-ATLASのscreen state |
| realized-by | obligation → implementation | `packages/api/src/persistence-routes.ts` のPATCH分岐と関連store symbol |
| exercised-by | obligation → verification scenario | TEST-API-...、TEST-DB-...、existing test title/target |
| verified-by | TEST-ID → exact-source evidence | GitHub Actions run/job/attempt/artifact/digest（実行済みである場合のみ） |
| reverse-trace | code/test/route/object → REQ | 意味が不明なコード・旧compatibility・無関係テストを見つける |

正本には対象ファイルと変更に追随可能な実装識別子を記録し、行番号は生成時に導出する。実装relationはsource file scopeと既存の関数・export・route・DDL object等の意味的識別子を保持し、手入力の`Lines`属性を持たない。ファイル関係だけで個々の義務を実装済みとみなさない。

外部のOpenAPI Operation ID、MCP tool名、SQL table/trigger、Terraform resource、CI taskなどへは、主に契約ファイル/owner内の一意のID・安定したGitのsource pathへ参照を作る。存在するコードを自動的に要求へ採用しない。

## 状態と証拠

要求決定状態（PROPOSED/ACCEPTED/RETIRED）と、適合状態（UNMAPPED/MAPPED_UNVERIFIED/PARTIAL/DEVIATION/BLOCKED/VERIFIED/NOT_APPLICABLE）を**別の属性**として維持する。テストの実行成功は要求全体の適合を自動認定しない。状態を集計する際は、要求の現行リリース適用/将来目標/廃止も区分する。

- 成功証拠: 発行したsource SHA、workflow run ID、attempt、task profile、独立したテストID、結果、検査環境、artifact digest。
- 不成功・未実行: FAILED / BLOCKED / NOT_RUNを失わず管理。CIのtask skipをPASSに変えない。
- test report: Node/Playwrightの実行観測は既存のreporterとexact-source証拠認定を使う。StrictDocの標準JUnit ingestを前提にせず、登録discoveryと実行観測をTEST-IDおよびsource identityで結ぶ。
- 公開: 必要なsummaryだけを静的HTMLへ掲載し、非公開のtoken、作者原稿、API cookie、内部VM情報、privileged CI artifactを配布しない。

## 導入ゲートと現状

| ID | 試験 | 現状と証拠 |
| --- | --- | --- |
| TRC-01 | 登録済み全REQ-IDを一度だけ変換 | **LOCAL_PASS**: main baselineの33 IDをStrictDoc requirement nodeと照合し、欠落・重複・余分なIDを検査 |
| TRC-02 | Markdown parse→HTML/JSON→同一入力から再生成 | **LOCAL_PASS**: StrictDoc 0.32.1のHTML/JSONを2回生成し比較。HTML検索timestamp、確認済みMarkdown document MID、検索index key順とunordered membership順のみを正規化し、membership値と他の出力を保持 |
| TRC-03 | REQ→設計→実装surface→obligation | **PARTIAL**: File relationのpathと明示したtyped surface identifierを検査する。生成Fastify routeのOperation IDと、AST discoveryによるTEST-ID・登録source・行・表示名を保持する。意味的な実装適合、全obligationに対するsymbol AST coverageは未証明 |
| TRC-04 | 実装側の逆引き | **PARTIAL**: bounded scanからHTTP method/path、MCP tool、DB object、Desktop UI control、Native iOS SwiftUI view、Terraform resource、Ansible source、GitHub Actions workflow定義を `reverseTrace` に記録する。Ansibleはsource YAMLすべてをsurfaceとして列挙し、4つの宣言済みentrypointとliteral `include_tasks` / `import_tasks`の到達関係からplaybook群を導出する。4件の最小path-specific candidate overrideはexample inventoryと、REQ-OPS-001候補に分類する3つのaccess/bootstrap secret sourceに限る。group IDとcandidate REQはnavigation metadataに限りobligation relationや実行証拠を作らない。孤立YAML、未解決・動的include、不正root、未分類entrypoint/overrideはgateを失敗させる。workflow定義は実行済みjob/runを意味しない。surface inventoryの分類と候補REQはaccepted relationと分離し、未分類・対応未接続surfaceも表示する。動的登録、全migration/live DB、実画面・実機挙動、適用済みIaC、host実行、隔離復元は静的source scanでは証明しない。 |
| TRC-05 | TEST→CI exact source evidence | `[TEST-ID]`付きネイティブ登録から静的に列挙したTEST-IDとsource identityを実行観測と照合する。照合キーはTEST-IDとdiscovery済みsourceであり、テスト表示名の変更や、trace taskで走らなかったケースの消失に依存しない。Pagesは同一SHAのVerify認定を確認できたケースにrun・attempt・artifact ID・digestを表示する。証拠を取得できないケースは未検証として残す。 |
| TRC-06 | 重複UID・切れた参照・inventory欠落・不正MIDへの故障注入 | **LOCAL_PASS**: `verify.test.mjs`の負例を実行。legacy product behaviorの適合試験とは区別 |
| TRC-07 | Repository Audit Pagesに静的サイトを公開 | StrictDoc HTML/JSONと `/requirements/traceability/` のstatus HTML/JSONを既存の唯一のpublisherが生成する。PR artifactをChromiumで検査し、mainの同じpublisherが公開する。公開URLとsource SHAが一致するまで `PENDING_PAGES_PUBLISH` を維持する。 |

## 現段階での実装範囲と残件

StrictDoc 0.32.1による要求HTML/JSON生成、REQ-IDとsource relationの検査、boundedなHTTP/MCP/DB/Desktop UI/Native iOS/IaC/Ansible/CI workflow reverse inventory、Node fault-injection、Playwright表示検査を既存CI taskと単一Repository Audit Pages publisherに統合する。`/requirements/traceability/` は既存の `obligationTrace`、`reverseTrace`、`caseExecutions` から要求・義務・reverse surface・exact-source観測・未解決gapを同じbuild SHAで投影する。StrictDoc Traceability Matrix、Deep Trace、Coverage Table、HTML/JSONへの直接リンクも併記する。各source/design/test参照はbuild SHAに固定し、test caseの `NOT_RUN`、`SKIPPED`、`TODO`、`AMBIGUOUS` とGitHub runのfreshnessを別々に保つ。部分的なFile relationやsource-scoped inventoryを要求適合と読み替えない。

dashboardの検索とarea/status/surface type filterはURL queryへ反映する。要求→obligation→設計/source/testと、source surface/test→obligationのanchor linkを相互に探索できる。inventoryに記録済みのclassificationとcandidate REQは表示するが、StrictDoc relationへ自動昇格しない。candidateも明示的NOT_APPLICABLEもないsurfaceは「分類なし」、分類はあるがobligation linkがないsurfaceは「obligation linkなし」として区別する。`UNMAPPED`は記録上リンクされていないことを示し、コード不存在の断定ではない。

この変更ではLikeC4の関係グラフを追加しない。関係の正本はRequirement Registerと既存StrictDoc relationのままであり、Matrix/HTML/JSONの標準出力と同じprojectionを使うdashboardで今回の双方向探索要件を満たす。新しいgraph authorityや別の要求台帳は導入しない。

このsource scanの観測限界は以下の通りである。HTTP/MCPの動的登録と実行時権限・副作用、PostgreSQL live `pg_catalog` と全環境の適用状態、Desktop UIの全runtime状態遷移、実機iOS UI、Terraformの適用済みresource、Ansible/hostの実収束は静的宣言と一致するとは限らない。現在のREQ-UI-006 state machineは未導入で、その設計上の全遷移を正規実装から抽出できない。これらは「観測不能・証拠不足」として残し、追加の実行証拠がない限りVERIFIEDにしない。

## 個別義務trace projection

`scripts/strictdoc/obligation-trace.mjs` は、StrictDoc node、ASTで発見したテスト登録、実行観測値から要求→個別義務→設計→source fileと意味的識別子→TEST-ID→exact-source run referenceを投影する補助APIである。入力にないrelationは推測せず、各欠落を`gaps`へ残す。要求の適合状態を認定せず、行の状態は最大でも`MAPPED_UNVERIFIED`であり、実行候補をVERIFIEDへ昇格しない。

個別義務nodeは`OBL-<REQ-ID>-O01` UID、`Parent` relationからREQ-ID、`Design reference`文字列から設計アンカー、`Test IDs`から明示TEST-IDを受け取る。実装relationはFile pathと既存の意味的識別子を保持し、手入力の`Lines`を持たない。TEST nodeはREQ `Parent` relationと`Execution scope`を持ち、source path、行、表示名はネイティブ登録のAST discoveryから導出する。TEST nodeに`Case name`や`File` relationを複製しない。義務node側の`Test IDs`がその義務との対応を示す。名前の類似度や実行されたcaseだけからTEST-ID relationを推定しない。

discoveryはliteral `[TEST-ID]` prefixのあるネイティブ登録を静的に列挙する。trace taskは`TRACE_NODE`と`TRACE_BROWSER`に属する発見済みsource fileに加え、既存の固定補助suiteを実行する。`PRODUCT` suiteは製品検証taskに属し、trace taskが未実行結果をPASSに変えない。実行時reporterはTEST-IDとdiscovery済みsource identityで観測を対応づける。未検出・曖昧・未実行の登録はgapまたは個別の未実行状態として残す。

APIの`runEvidence`は観測済みcase execution候補であり、各値は`testId`, canonical `url`, `repository`, `sourceSha`, `runId`, `attempt`, `job`, `task`, `result`を含む。呼出側は`expectedRepository`と`expectedSourceSha`を指定する。run URL、repository、source SHAの不一致や識別情報不足は違反となる。まだartifact upload前のrunも記録できるためartifact ID/digestはこの候補データに含めない。既存 Verify の certification job が実行と成果物を認定する。Pages は認定済み run と ZIP の identity を照合して、公開用の要約を生成する。台帳の `Exact-run reference` は `NOT_RUN` を保持し、実行結果は生成レポートから参照する。

故障注入テストは重複義務UID、切れたTEST-ID、repository外source path、不一致repository、exact-source実行の欠落を検査する。testの存在だけ、または成功結果だけでは要求の適合を証明しない。
