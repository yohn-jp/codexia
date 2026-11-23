# StrictDocによる要求・実装・検証追跡の詳細設計

**種別: 選定済み目標・未導入。** [Requirements governance](README.md) と [Requirement register](REQUIREMENT-REGISTER.md) の既存REQ-IDを保持し、[Traceability](../verification/TRACEABILITY-REGISTER.md) を機械的に扱える関係管理へ移行する。ツール選定は [Toolchain](../architecture/SPECIFICATION-TOOLCHAIN.md)。この設計は、要求が正しいこと・テストに合格したことをStrictDocだけで証明すると宣言しない。

## 二択の結論と適用範囲

- **採用:** StrictDoc。要求の関係・source file/range trace、双方向coverage matrix、静的HTML、JSON/ReqIF exportが中核。
- **不採用:** Sphinx-Needs。強力なDocs-as-Codeだが、Sphinx/MyST、各種need import/link拡張を組み合わせて今回の追跡を構築する設計となる。Codexiaは要求とソース追跡を専門ツールに一元化したい。
- **未保証:** StrictDocのMarkdown機能は公式にexperimental。TypeScript/TSXのAST関数同定は公式な実装済み保証がなく、Node `node:test` / PlaywrightのJUnit形式は、StrictDocが公式に挙げる自動取り込み形式に含まれていない。ファイル/範囲relationとテストID参照が基礎であり、自動symbol coverageやJUnit ingestの完全対応を前提にしない。

公式: [StrictDoc formats](https://strictdoc-project.github.io/formats/)、[Markdown specification](https://strictdoc.readthedocs.io/en/latest/latest/spec/Markdown.md.html)、[Source-code traceability](https://strictdoc.readthedocs.io/en/latest/latest/docs/strictdoc_01_user_guide.html)。

## 仕様のownershipと1回だけの変換

現行 `docs/requirements/REQUIREMENT-REGISTER.md` は**Markdown表の要約台帳**であり、表の各行はそのままStrictDocの個別requirement nodeにならない。導入後は次の形へ**一回だけ、ID欠落/意図変更なしで移行**する。

1. 原要求の本文・合否観点・決定状態・将来目標区分を読み、`REQ-*`ごとに**個別のMarkdown見出しとStrictDoc metadata**を作る。既存の設計 ownerと要求の正確な意味をレビューする。正本の誤認があれば、実装へ合わせず変更承認する。
2. `REQ-*` の既存IDは変更・再利用しない。`O01/O02` 等の個々の検証義務もrelation可能なnodeまたは検証IDとして管理する。
3. 同一要求を「Markdown表」と「StrictDoc要求ノード」で**並行編集しない**。変換後は旧表を削除または生成専用の索引へ置換し、唯一の編集正本を明記する。
4. 既存の自由文・Mermaid・API/DB/External設計のMarkdown全文を機械的にStrictDoc固有dialectへ変換しない。必要な領域正本をURL/UIDで参照する。
5. 生成されたHTML、matrix、JSON、ReqIFは派生物。公開済み表に誤りがあれば要求源と関連付けを直し、生成物を手編集しない。

**採用するauthoring言語:** まずは**StrictDoc拡張Markdownを試験**する。公式Markdown構造はH1を1つ、飛ばさない見出し階層、metadata `**UID**:` とstatement等の指定を要求し、連続する空行や一部Markdown拡張の扱いにも制限がある。PoCでこの書式がCodexiaの要件・関係・差分レビューに十分に安定していることを実証する。未充足なら当該**要求ファイルだけ**をStrictDocネイティブ `.sdoc` とする（一般設計書はMarkdownを維持）。「すべてMarkdown」より追跡の正確性を優先する場合は、設計上の媒体変更をPRで明示する。

推奨ノード例（**概念構造。実際にStrictDocでparseできるかはPoCで検証**）:

~~~markdown
# Codexia requirements

## PostgreSQL is authoritative

**UID**: REQ-DATA-001
**Status**: ACCEPTED

全ての作品本文・Revision等の永続正本はPostgreSQLとする。
~~~

`Status` の許容値と追加要素の文法は公式grammarでの設定検証に従う。生のMarkdown表からUIDを拾えると仮定しない。上例は仕様記述の例であり、現行REQ-DATA-001の詳細受入条件を置き換えるものではない。

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

## 導入ゲート（実測が必要）

| ID | 試験 | 完了条件 |
| --- | --- | --- |
| TRC-01 | 既存30 REQ-IDの変換 | 元のID・意味・設計参照がすべて維持。重複/欠落・勝手な採用なし |
| TRC-02 | Markdown parse→HTML/JSON→再parse | Unicode/日本語、Markdownリンク、要件metadata、relation、差分の決定性を確認 |
| TRC-03 | REQ→TS/TSX/SQL source | file/range relationで実装へ到達し、ファイル変更・削除・参照切れを検知 |
| TRC-04 | 逆引き | 既知の余分なroute、DB object、MCP toolを列挙し、未リンクを誤ってVERIFIEDにしない |
| TRC-05 | TEST→CI | Node unit + Playwrightのテスト名/IDとGitHub Actions run証拠が手戻りなく結合できる |
| TRC-06 | 意図的な破壊 | REQ-ID重複、参照先削除、検証欠落、旧compatibilityを作り、対応する失敗が検出される |
| TRC-07 | 静的サイト | 既存のRepository Audit Pagesの唯一の公開経路へ組み込み、SHA/権限/URLが一致 |

PoCに不合格の論点があれば、StrictDoc導入が成功したと宣言しない。必要なら**要求ファイルのSDoc化**や、実装のtrace marker追加を別の決定として扱う。未検証事項のためにオリジナルの独自traceability engineを先行実装しない。
