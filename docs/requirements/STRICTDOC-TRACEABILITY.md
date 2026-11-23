# StrictDocによる要求・実装・検証追跡の詳細設計

**種別: 導入済み追跡基盤・部分適用。** [Requirements governance](README.md) と [Requirement register](REQUIREMENT-REGISTER.md) の既存採用REQ-ID 33件をStrictDoc Markdown nodeへ移行し、HTML/JSON生成・relation検査・CI taskを実装した。要求の正しさや製品適合をStrictDoc単独で証明するものではない。現状のgateと残件を末尾の表に記録する。ツール選定は [Toolchain](../architecture/SPECIFICATION-TOOLCHAIN.md)。

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

StrictDocが直接扱えるsource-file/range relationを優先し、正本内に**対象パス、変更に追随可能な実装識別子、補助として行範囲**を記録する。TypeScript symbolをAST解析で自動同定できることは前提にしない。ファイル関係しか証明できない場合は、ファイル全体のリンクを個々の義務の実装証明とみなさない。

外部のOpenAPI Operation ID、MCP tool名、SQL table/trigger、Terraform resource、CI taskなどへは、主に契約ファイル/owner内の一意のID・安定したGitのsource pathへ参照を作る。存在するコードを自動的に要求へ採用しない。

## 状態と証拠

要求決定状態（PROPOSED/ACCEPTED/RETIRED）と、適合状態（UNMAPPED/MAPPED_UNVERIFIED/PARTIAL/DEVIATION/BLOCKED/VERIFIED/NOT_APPLICABLE）を**別の属性**として維持する。テストの実行成功は要求全体の適合を自動認定しない。状態を集計する際は、要求の現行リリース適用/将来目標/廃止も区分する。

- 成功証拠: 発行したsource SHA、workflow run ID、attempt、task profile、独立したテストID、結果、検査環境、artifact digest。
- 不成功・未実行: FAILED / BLOCKED / NOT_RUNを失わず管理。CIのtask skipをPASSに変えない。
- test report: StrictDoc公式の自動JUnit ingestは限られた実装言語の形式に対応し実験的。Node/PlaywrightのJUnitを認識するために**拡張子だけを偽装しない**。公式対応と照合できない場合は、標準のGitHub Actions run/artifact URLへの関係を使う。
- 公開: 必要なsummaryだけを静的HTMLへ掲載し、非公開のtoken、作者原稿、API cookie、内部VM情報、privileged CI artifactを配布しない。

## 導入ゲートと現状

| ID | 試験 | 現状と証拠 |
| --- | --- | --- |
| TRC-01 | 登録済み全REQ-IDを一度だけ変換 | **LOCAL_PASS**: main baselineの33 IDをStrictDoc requirement nodeと照合し、欠落・重複・余分なIDを検査 |
| TRC-02 | Markdown parse→HTML/JSON→同一入力から再生成 | **LOCAL_PASS**: StrictDoc 0.32.1のHTML/JSONを2回生成し比較。HTML検索timestamp、確認済みMarkdown document MID、検索index key順とunordered membership順のみを正規化し、membership値と他の出力を保持 |
| TRC-03 | REQ→TS/TSX/SQL source | **PARTIAL**: File relationの存在と範囲を検査。symbol AST coverageと全obligationへの網羅は未証明 |
| TRC-04 | 逆引きroute/tool/DB inventory | **PARTIAL**: verifierが独立して、登録済みソース範囲のliteral route/method dispatch、`server.tool`名、初期migrationの名前付きDDL objectを検出し、分類の欠落・stale entriesを検査する。dynamic route families、他の登録module、追加migrationとinline constraint等は未走査で、完全inventoryはIssue #671に残す |
| TRC-05 | TEST→CI exact source evidence | Node fault-injectionとPlaywright static-page testはローカル実測済み。GitHub run/source SHA/task/artifact identityをreportに記録し、hosted resultは当該PRの実際のVerify runで判定 |
| TRC-06 | 重複UID・切れた参照・inventory欠落・不正MIDへの故障注入 | **LOCAL_PASS**: `verify.test.mjs`の負例を実行。legacy product behaviorの適合試験とは区別 |
| TRC-07 | Repository Audit Pagesに静的サイトを公開 | **PENDING**: HTML/JSONをCI artifact pathへstageし、生成dashboardの絶対checkout pathをREPOSITORY_ROOTへ置換してからcredential/path検査し、Playwrightで要求ページを表示検査。公開経路の変更と公開SHA確認は依存Issue #669が所有 |

StrictDoc導入の範囲は、要求nodeと局所的な自動trace verifier、正直な残件表示まで。部分的なFile relationやsource-scoped inventoryを要求適合と読み替えない。symbol coverageと完全runtime inventoryはIssue #671の残件である。hosted green resultはexact source SHAごとにreportへ記録し、公開証跡はIssue #669のpublisherが確認する。
