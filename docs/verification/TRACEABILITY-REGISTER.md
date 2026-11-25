# 要求→設計→実装→検証→証拠の双方向トレーサビリティ

**種別: 追跡方式と生成結果の説明。** 要求の採否とIDは [Requirements](../requirements/README.md)、要求内容は [Requirement register](../requirements/REQUIREMENT-REGISTER.md) が唯一の編集正本である。この文書は別の要求台帳ではなく、生成レポートの読み方と観測範囲を記録する。適合状態はRequirement Registerの値を使い、実装コード、issue、過去の棚卸しから変更しない。

## レコードの完全形

| フィールド | 必須内容 |
| --- | --- |
| Requirement / obligation | REQ-ID と個々の義務 O01/O02...。正常、拒否、競合、障害、回復、性能を独立に追跡 |
| Decision / target | ACCEPTED/PROPOSED/RETIRED と現行リリース対象/将来目標 |
| Design owner | 一意の設計正本＋節/anchor＋API Operation/DB object/UI CTRL/外部IF |
| Implementation path | リポジトリパス＋symbol/route/SQLオブジェクト/設定key。処理が別層へ渡る場合は中間adapterも記録 |
| Verification | TEST-ID、再現条件、入力、期待する許可/拒否/回復、実DB/API/画面/VM等の観測点 |
| Evidence | exact SHA、run/job/attempt、artifact ID/digest、環境・profile・ブラウザー・DB、実際の結果 |
| State | UNMAPPED / MAPPED_UNVERIFIED / PARTIAL / DEVIATION / BLOCKED / VERIFIED / NOT_APPLICABLE と理由 |

多対多を許可するが、単なるファイル参照で完結としない。ブラウザー操作→admission→Core→PostgreSQL→receipt→UI復帰、HTTP/stdio MCP→OAuth→effect→提案→作者承認→DBのように**中間境界を通過する処理**も追跡する。運用要求の終点はAction、ホスト上の設定と実行証拠まで含む。

**明示された未実装範囲:** S3互換バックアップの転送・隔離復元、XState v5 actor/state machine、owner backup console/executorの設計目標はRequirement Registerの実装記述で未実装と明記されている。これらの記述は現在の状態を利用者へ示す根拠であり、周辺の既存ファイルやテスト候補から実装済み・適合済みを推定しない。

## 作業開始時baselineと再生成値

baselineは作業開始時のmain `af9a7115383e16f45299695af59645ad44af4998` から採取した。表の作業値も同main基点のPR変更をrebaseする前にStrictDoc reportから採取した。その後mainは `3f2129291316151c91f3b1a57c4bb4bcbe2da08e` まで進み、PRはそのHEADへrebaseした。ユーザーの指示でrebase後の追加テスト・report生成を行わないため、表の作業値をrebase後の現在値として読まない。PR CIが正確な新source SHAでHTML/JSONとtrace reportを再生成する。

| 指標 | 作業開始時main | rebase前worktree | 読み方 |
| --- | ---: | ---: | --- |
| Requirement / obligation | 33 / 43 | 33 / 44 | 要求数は不変。REQ-TRACE-001にdashboard義務を1件追加 |
| Obligation conformance: MAPPED_UNVERIFIED | 24 | 24 | 対応情報あり。適合認定ではない |
| Obligation conformance: PARTIAL | 15 | 16 | 追跡段階の欠落または部分状態 |
| Obligation conformance: UNMAPPED | 4 | 4 | accepted obligation mappingの不足。実装不存在の断定ではない |
| Obligation conformance: VERIFIED | 0 | 0 | exact-source認定へ昇格していない |
| obligationTrace rows: PARTIAL / MAPPED_UNVERIFIED | 36 / 7 | 36 / 8 | projection上のリンク・テスト状態 |
| TEST-ID付き義務 / unique TEST-ID | 7 / 10 | 8 / 11 | TEST-TRC-08-001を追加 |
| scoped local case result | 10/10 PASSED | 11/11 PASSED | caseExecutionsの観測。製品適合の証明範囲とは別 |
| exact-source GitHub run | 0 | 0 (`NOT_RUN`) | skipやlocal runはhosted evidenceに数えない |
| reverse rows / unique surface identities | 622 / 614 | 646 / 638 | raw rowsは重複relationを含む。surface identityで集約した値も併記 |
| linked reverse rows / unique linked surfaces | 56 / 52 | 58 / 54 | OBLへ明示リンクされた行・surface |
| unique surfaces without obligation link | 562 | 584 | candidate REQだけではlinked扱いにしない |
| reverse inventory classification exposed | 0 | 423 unique surfaces | 正規inventory classificationをreverse outputへ射影 |
| candidate REQ surfaced (not accepted links) | 0 | 66 unique surfaces | candidateとaccepted relationを分離 |
| GitHub Actions workflow definitions discovered / explicitly linked | 0 / 0 | 30 / 2 | workflow YAMLの列挙。実行済みrun数ではない |
| Registerにある明示的な未実装宣言 | page projectionなし | 4 requirements | conformance statusとは別の注記。明示的な登録記述だけを抽出 |
| obligation gaps / reverse gaps | 59 / 644 | 60 / 668 | gapは状態別に表示。根拠のない解消はしない |
| explicit NOT_APPLICABLE surface | 0 | 0 | 適用外と明示されたsource surfaceはない |
| broken repository source/design/test references | 既存page projectionなし | 0 | checkoutで解決できるファイル参照を検査 |

rebase前に観測した4件のrequirement conformance `UNMAPPED` は `REQ-UI-006`、`REQ-OPS-004`、`REQ-OPS-005`、`REQ-QUAL-003`。加えて `REQ-OPS-003` のS3拡張もRequirement Registerのobligation statementに未実装と明記されている。rebase前のtrace projectionは `REQ-UI-006`、`REQ-OPS-003`、`REQ-OPS-004`、`REQ-OPS-005` の明示句を別欄・別filterで提示する。`UNMAPPED`と「明示的未実装宣言」は異なる属性である。`REQ-QUAL-003`は対応source参照が未接続だが、ここから製品コード不存在は断定しない。

作業開始時のreverse outputが `DEVIATION` と数えた2件は、`PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}` のinventory記述 `UNMAPPED: detailed obligation mapping remains unassigned` を仕様逸脱として誤分類したものだった。修正後はこれを `UNMAPPED` gapとして表し、`DEVIATION`はsource inventoryまたはruntime contract scanが明示した場合に限る。未接続のobligation mappingを逸脱と数えず、同時に仕様逸脱が存在しないことを広範な証明として扱わない。

## MCP v2 migration verification crosswalk

This plan-level crosswalk retains its recorded source/test associations as a migration reference. Its source snapshot and rows are not a current implementation inventory; use the generated traceability page and exact-source report for the current main state. `NOT_RUN` is not a pass. The accepted MCP requirements remain the conformance authorities; `MCPV-001..008` are verification-plan IDs from [MCP-V2-MIGRATION](../architecture/MCP-V2-MIGRATION.md), not product conformance statuses. Source locations and test case names below are trace candidates. `NOT_RUN` means no exact-source run/artifact was verified for this change. No MCPV item is marked PASS or VERIFIED here.

MCP-specific source mapping was refreshed against integrated source `f4e574ec` (including the restored HTTP tests, worker cancellation and drain integration, and formatted API admission test). The repository requirement-trace gate checks deterministic UIDs/MIDs, source-path and line-range validity, each declared TEST-ID against its case name/source file, explicit requirement parents, and reverse-surface mappings; these checks do not replace protocol, Inspector, OAuth-client, PostgreSQL, or hosted exact-source evidence.

| Plan ID | Requirement link | Source/test candidate | Trace state and remaining evidence |
| --- | --- | --- | --- |
| MCPV-001 | REQ-MCP-001, REQ-MCP-002 | `modules/mcp/src/tools.test.ts`: “native MCP schemas bound UUID reads and accept only the seven ordinary native ChangeSet operations” (`TEST-MCPV-001-001`); `modules/mcp/src/tool-catalog.test.ts`: “MCP tools/list publishes the compatible tool names and object input schemas” (`TEST-MCPV-001-002`) | MAPPED_UNVERIFIED; the catalog test asserts the 53 public names and schema shape; runtime suite exact-source evidence remains NOT_RUN |
| MCPV-002 | REQ-MCP-001 | `npx @modelcontextprotocol/conformance server --url <isolated-url>/mcp --requirements 2026-07-28` per migration design | UNMAPPED; no isolated protocol-conformance run or required-scenario report is attached; exact run NOT_RUN |
| MCPV-003 | REQ-MCP-001 | MCP Inspector CLI/Web per migration design | UNMAPPED; no interop/reconnect/version-negotiation record is attached; exact run NOT_RUN |
| MCPV-004 | REQ-MCP-001, REQ-MCP-002 | `tests/integration/mcp-acceptance.test.mjs`: “native Knowledge MCP tools preserve PostgreSQL scope, proposal, replay, review and receipt over both transports” (`TEST-MCPV-004-001`); `packages/api/src/server.test.ts`: “admits registered MCP OAuth clients by exact operation scope without owner rights” (`TEST-MCPV-004-002`); `packages/api/test/better-auth.integration.test.ts` registers a real public MCP client and verifies PKCE, refresh, revocation, and project scope (`TEST-MCPV-004-003`) | MAPPED_UNVERIFIED; exact run NOT_RUN |
| MCPV-005 | REQ-MCP-001 | same native Knowledge PostgreSQL scenario (`TEST-MCPV-004-001`) | PARTIAL; source includes project scope, replay, author review/application, and receipt checks. A PostgreSQL restart was exercised locally, but no exact-source run evidence is attached here; ledger remains NOT_RUN |
| MCPV-006 | REQ-MCP-001 | `tests/integration/mcp-acceptance.test.mjs`: “MCP cancellation stops real NLP worker jobs through stdio and Streamable HTTP” (`TEST-MCPV-006-001`; also calls `verifyHttpDrain`); `modules/mcp/src/http.test.ts`: “aborting the host Web Request closes the modern SDK exchange” (`TEST-MCPV-006-002`), “modern Mcp-Method and Mcp-Name mismatches are rejected before tool dispatch” (`TEST-MCPV-006-003`), and “oversized MCP request body is refused before creating the SDK action context” (`TEST-MCPV-006-004`) | PARTIAL; the integration case cancels real worker jobs over both transports and verifies HTTP host shutdown drains the in-flight request and leaves no active jobs. SDK-level host Request abort is separately mapped; cross-request/client isolation still requires evidence; exact run NOT_RUN |
| MCPV-007 | REQ-MCP-001 | `modules/mcp/src/http.test.ts`: modern official v2 client (`TEST-MCPV-007-001`), temporary stateless 2025 fallback (`TEST-MCPV-007-002`), strict legacy rejection/method delegation (`TEST-MCPV-007-003`); `modules/mcp/src/protocol-version.test.ts`: six-month cutoff (`TEST-MCPV-007-004`); `modules/mcp/src/http.test.ts`: production cutoff mode transition | MAPPED_UNVERIFIED; source tests cover modern protocol, bounded fallback, strict mode, and the cutoff predicate; no exact-source run result is recorded; exact run NOT_RUN |
| MCPV-008 | REQ-MCP-001, REQ-MCP-002 | registered MCP client over Better Auth and PostgreSQL (`TEST-MCPV-004-003`); external client interop per migration design | PARTIAL; the integration case uses the official SDK as the MCP client. Hosted client registration and real OAuth tool interactions require external client evidence; exact run NOT_RUN |

`TEST-MCP-CORE-001-001` links the existing external Assistant admission/no-provider-call case to REQ-MCP-002; it is not a substitute for MCPV-002 protocol conformance. The case names are declared in StrictDoc nodes, and their source file relations use line coordinates. The Better Auth integration case ties OAuth PKCE issuance and refresh to a real 2026 HTTP tool invocation through PostgreSQL. External client interoperability requires evidence from the selected products. Keep these mappings at MAPPED_UNVERIFIED/PARTIAL until the named cases are reviewed and exact-source evidence is captured.

## E2E追跡例 — 保存・競合・復旧

1. REQ-DATA-002:O01（Revision不変）→ DATA-MODEL → 0001-initial.sql の document_revision と document_revision_immutable → Postgres実装 → UPDATE/DELETE拒否の実DBテスト → exact-sourceの結果。
2. REQ-API-002:O01（競合時に偽成功を返さない）→ INTERACTION-CONTRACT / API-CONTRACT → PATCH /api/v1/persistence/projects/:p/documents/:d → persistence-routes.ts → postgres-store.ts → 409/元の原稿保全/receiptのAPI・ブラウザーE2E → 実行結果。
3. REQ-UI-002:O01（保存範囲の正しい表示）→ SCREEN-CONTROL-CATALOG / INTERACTION-CONTRACT → journalとUI保存controller → API → DB receipt → 応答損失・追加編集・再読込・容量不足のブラウザー受入結果。

**上記は必要な追跡経路の例であり、実行確認済みの証明ではない。** 途中で接続先が欠ければPARTIALである。

## 実装からの逆走査を必須にする

| 走査元 | 仕様との対応付け対象 |
| --- | --- |
| packages/api/src/server.ts、persistence-routes.ts、Better Auth、各module HTTP contribution | 全 method+route、入力・出力DTO、拒否、エラー |
| modules/mcp/src/tools/、module action manifest | 全tool名、effect、scope、input/output Schema |
| packages/persistence-postgres/migrations/、認証スキーマ | 全table/column/index/FK/trigger/roleとmigration |
| app/src/ | 全画面・CTRL/CTA・状態・遷移・認可 |
| ios/**/Sources/ | Native iOS SwiftUI view型とtransport入口。source declarationは実機・挙動の受入証拠ではない |
| deploy/cloudflare/terraform/、deploy/ansible/ | IaC resource、playbook、inventory設定。宣言と実環境適用・収束の証拠を区別 |
| deploy/、.github/workflows/ | Edge、IaC、更新、秘密管理、バックアップ、CI gate |
| 全test、tests/e2e、tests/integration | どのobligationを何の期待値で証明するか |

「対応要求なし」は正本への自動編入を意味しない。仕様外/旧設計残骸/内部補助/新規提案を区別し、ownerと理由を記録する。

## 自動検証の範囲と残件

- StrictDoc verifierはUID/MID、typed relation、File/Test参照、登録済みTEST-IDを検査する。dashboard publisherはcheckout内のdesign/source/test path欠落、StrictDoc output digest、source SHA一致を検査する。
- reverse scanはAPI runtime route、MCP登録、DB宣言object、Desktop UI control、Native iOS view、Terraform resource、Ansible source、CI workflow definitionを採取する。bounded scan外の要素は未検出を不存在と見なさず、limitation gapとして提示する。
- API Operation IDは生成Fastify contractから、CI workflow一覧は`.github/workflows`から抽出する。MCP effect、DB live catalog、Desktop runtime state、iOS device behavior、applied IaC、host convergenceとの一致はこの静的scan単独では検証しない。
- `VERIFIED`は既存certifierが対象義務のexact-source evidenceを記録した場合のみ。ローカル成功、workflow定義、追加Markdown、source pathの存在では昇格しない。

## 生成された追跡結果

義務を追加・修正するときは [Requirement register](../requirements/REQUIREMENT-REGISTER.md) の StrictDoc node を編集する。
既存の `requirements-trace` はnodeの義務ID、設計・実装参照、surface identifier、TEST-IDを`trace-report.json`の`obligationTrace`に出力し、実装側から見つかった要素と義務の対応を`reverseTrace`に記録する。`caseExecutions`はテスト名と宣言source/rangeを保ち、未実行・skip・TODO・曖昧な対応をPASSに集約しない。両方向の表は同じ義務IDで照合でき、識別子が分からない要素や観測限界は生成結果のgapに残る。

`caseExecutions` の結果は、そのテストケースが実際に実行されたことを示す。
GitHub Actions 上の実行では同じレポートの `execution` が source SHA、run、attempt、job、task を保持し、既存の Verify が選択した証拠 ZIP の ID・ダイジェストと照合する。
製品側の各義務は、実装の識別子、必要な試験とその証明力、対応する環境と証拠が揃うまで、既存の適合状態を保つ。
`/requirements/traceability/`は既存三projectionから同じsource SHAの静的HTML/JSONを作り、StrictDoc Matrix/Deep Trace/Coverage/HTML/JSONを直接開ける。Pages publisherの既存browser suiteは、検索、area/status/surface filter、双方向anchor、詳細開閉、mobile table scroll、LikeC4 provenanceをChromiumで確認する。
公開PagesはStrictDocとtraceabilityのHTML/JSONを既存publisherから配布する。`NOT_RUN`のPRローカルreportをGitHub run証拠として扱わない。
