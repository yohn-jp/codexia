# 設計書の正本と保守規則

**種別: 正本・規範的設計。** Codexia は **Design-first / Design-as-authority** を採用する。リポジトリのコードを「現行動作の観測」には利用するが、コードの存在を理由に製品設計を追認しない。本書は [SYSTEM-DESIGN](SYSTEM-DESIGN.md) と併せて、文書間の優先順位と設計変更の手続きを定める。

## 文書の種別

| 種別 | 役割 | 例 |
| --- | --- | --- |
| 規範的設計（normative） | 製品が従うべき構成・仕様・受入条件を確定する | `SYSTEM-DESIGN.md`、`CORE.md`、`API-AUTHN-AUTHZ.md`、`UX-CONTRACT.md`、`CI-CD.md` |
| 運用手順（runbook） | 既存の承認済み仕組みで行う操作と前提条件を定義する | `deployment/PUSH-DEPLOYMENT.md`、`deploy/ansible/README.md`、`verification/README.md` |
| 設計詳細・提案（proposal） | 正本を細分化した候補・未決事項を扱う。明示採用されるまで正本を上書きしない | `INFORMATION-ARCHITECTURE.md`、`PLUGIN-PLATFORM.md`、`NEXT-DEVELOPMENT-PLAN.md` |
| 受入証拠（evidence） | 実行したテスト・CI・実機・VM の結果。仕様の正本ではない | CI artifact、PR、保護された運用記録 |
| 履歴・外部資料 | 移行の記録、設計比較、ベンダーの同梱資料 | `evidence/migration`、`.agents/skills`、`CODEXIA-REBOOT-RFC.md` |

文書の名称、分量、作成順序によって優先順位を決めない。所有対象ごとの正本を決め、別の文書から参照する。ドメインを横断する新しい決定は `SYSTEM-DESIGN.md` を更新する。サブシステム内の決定は所有文書を更新し、必要に応じて相互リンクを追加する。

## 仕様の所有先

| 対象 | 設計上の所有先 |
| --- | --- |
| 採用済み仕様ツールチェーンと移行の比較・合格条件 | [Specification toolchain](SPECIFICATION-TOOLCHAIN.md)（設計正本は本書と各領域に従う） |
| XState採用対象・machineとAPI/DB副作用の境界 | [XState状態機械設計](../design/XSTATE-STATE-MACHINE-CONTRACT.md)（Webクライアントの対象。ネイティブSwiftUIにはReact/XState runtimeを要求しない） |
| Windows Chromiumの作者用Web対応境界・Desktop ReactとネイティブiOS SwiftUI・モバイルWeb廃止 | [System design](SYSTEM-DESIGN.md)（製品境界）・[iOS SwiftUI architecture](IOS-SWIFTUI-ARCHITECTURE.md)（ネイティブ実装正本） |
| 仕様駆動移行の実装分割/依存関係/検証引渡し | [実装契約と統合計画](SPECIFICATION-IMPLEMENTATION-CONTRACT.md)（製品要求の第二正本ではない） |
| ファイル命名・ソース配置の規範 | [Source layout and naming](SOURCE-LAYOUT-CONVENTIONS.md)（全リポジトリの新規・移動ファイルの配置と例外） |
| scripts移行の作業分割・完全対応表 | [Issue #690](https://github.com/yohn-jp/codexia/issues/690)（移行作業の計画と対応表。設計正本ではない） |
| 外部ライブラリの選定・最新版方針・依存境界 | [外部ライブラリ選定規約](DEPENDENCY-POLICY.md)・[既存依存と固定根拠の台帳](DEPENDENCY-INVENTORY.md) |
| 要求管理/StrictDoc移行 | [StrictDoc traceability](../requirements/STRICTDOC-TRACEABILITY.md)（REQ-ID内容の正本は要求登録簿） |
| HTTP実行基盤/生成器の移行目標 | [HTTP platform migration](HTTP-PLATFORM-MIGRATION.md)（認可の意味は Route authorization） |
| DB契約検証ツールと対象 | [PostgreSQL contract verification](POSTGRES-CONTRACT-VERIFICATION.md)（Data modelとDB detailが正本） |
| MCP v2 SDK・プロトコル移行 | [MCP v2 migration](MCP-V2-MIGRATION.md)（MCP OAuth/Coreの権限が正本） |
| 新規CI検証と成果公開の受入 | [Tooling acceptance](../verification/SPECIFICATION-TOOLING-ACCEPTANCE.md)（CI/CDが実行の正本） |
| 要求ID・採用済み要件登録 | [Requirements governance](../requirements/README.md)・[Requirement register](../requirements/REQUIREMENT-REGISTER.md) |
| 要件から実装・テスト・証拠への双方向追跡 | [Traceability](../verification/TRACEABILITY-REGISTER.md) |
| HTTP APIのrequest/response/error・operation | [API contract](API-CONTRACT.md)（認可は Route authorization が正本） |
| DBの表・列・制約・索引・schema lifecycle | [DB detail contract](DATABASE-DETAIL-CONTRACT.md)（概念データは Data model が正本） |
| 外部IF・trust/障害/復旧 | [External interfaces](EXTERNAL-INTERFACES.md)（OAuth/MCP/配備の詳細は既存所有文書が正本） |
| システム構成と責務 | [システム基本設計](SYSTEM-DESIGN.md)・[Internal boundaries](INTERNAL-BOUNDARIES.md) |
| PostgreSQL とドメイン ID | [データモデル](DATA-MODEL.md)・[Core](CORE.md) |
| URL/HTTP method・principal別のアクセス境界 | [Route authorization contract](ROUTE-AUTHORIZATION-CONTRACT.md)・[API authentication](API-AUTHN-AUTHZ.md) |
| 画面ID・操作ボタン・状態遷移の全体台帳 | [Screen control catalog](../design/SCREEN-CONTROL-CATALOG.md)・[Screen State Atlas](../design/SCREEN-STATE-ATLAS.md) |
| API admission / Better Auth / OAuth / project 認可 | [API authentication](API-AUTHN-AUTHZ.md)・[MCP OAuth](MCP-OAUTH.md) |
| Module と外部 AI | [Modules](MODULES.md)・[MCP-first](MCP-FIRST.md)・[Modular workspace](MODULAR-WORKSPACE.md) |
| UI/UX と利用者操作 | [UX contract](../design/UX-CONTRACT.md)・[利用画面遷移](../design/USER-SCREEN-FLOW.md) |
| 所有者の管理 UI | [管理画面遷移](../design/ADMIN-SCREEN-FLOW.md)・[API authentication](API-AUTHN-AUTHZ.md)・[バックアップ管理・S3制御](BACKUP-CONSOLE-CONTRACT.md)（運用設定/ワイヤ/責務。具体画面遷移はScreen State Atlas） |
| 本番運用サイクル・実行者/実行面・入力/秘密の正本・経路選択・初回配備・更新・復旧・排他/再開 | [Deployment lifecycle](../deployment/DEPLOYMENT-LIFECYCLE.md)（横断契約。個別stage・認証・CI・backupの正本を置換しない） |
| 初回配備 CLI・外部認証・入力準備・Workflow 起動と再開 | [codexiactl](../deployment/CODEXIACTL.md)（規範的設計。既存 R 経路・IaC・認定・本人認証の正本を置換しない） |
| 初期導入・VM の収束 | [初期導入遷移](../deployment/INITIAL-DEPLOYMENT-FLOW.md)・[IaC](../deployment/IAC.md) |
| 自動更新・復旧 | [更新遷移](../deployment/UPDATE-FLOW.md)・[Push deployment](../deployment/PUSH-DEPLOYMENT.md) |
| 設計と正規コードから派生する画面・操作・遷移の抽象表示・探索・差分 | [UX Simulator契約](../design/UX-SIMULATOR-CONTRACT.md)（二重実装禁止。製品の設計正本と実装観測を区別し、実製品受入を置換しない） |
| GitHub Pages の画面設計、機能、公開 | [Pages サイトマップと UX](../design/DEVELOPMENT-PAGES-UX.md)（設計詳細）／ [Pages 機能台帳](../verification/PAGES-FUNCTION-INVENTORY.md)（観測）／ [CI/CD](../verification/CI-CD.md)（公開と証拠の契約） |
| CI・証明・実測 | [CI/CD](../verification/CI-CD.md)（実行・認定）・[Test architecture](../verification/TEST-ARCHITECTURE-OPTIMIZATION.md)（証明配置）・[E2E execution](../verification/E2E-EXECUTION.md)（Browser実行最適化の詳細。上位契約を置換しない） |

## 設計変更の順序

1. **仕様を確定:** 受入済みの決定を確認し、対象の正本文書にユーザー体験、依存関係、状態遷移、正常・異常系、セキュリティ不変条件を記載する。
2. **差分を評価:** 現行実装、データ schema、API、CI、運用と仕様を照合し、適合/逸脱/未実装/未確認を区別する。既存コードを仕様の根拠として正当化しない。
3. **実装:** 正本に従う最小の変更を行う。新しい互換層、独立 writer、環境変数、代替認証経路は受入済み要件なしに追加しない。
4. **受入:** unit/integration/E2E、API schema、DB 一貫性、アクセシビリティ、実機/実 VM、CI を変更の影響範囲で実測する。実行していないものを PASS にしない。
5. **更新:** 実装に伴い正本の曖昧さが判明した場合は先に設計上の意思決定を記録する。PR に観測証拠を残し、仕様書に CI 結果や作業日誌を埋め込まない。

設計書だけに存在する機能は**設計目標**であり、稼働・公開・セキュリティ受入を主張しない。逆にコードだけに存在する古い互換機能も、新規実装の仕様上の制約にはならない。

## 文書を追加・改訂する際の必須項目

- 文書種別、owner、対象読者と非目標を明記する。承認済み仕様か未採用提案かを分ける。
- UI/操作には入口、状態と遷移条件、戻り先、保護対象、エラーと回復、権限、Desktop Web と iOS SwiftUI の差異を書く。
- API/データには principal、scope、ID、整合性、冪等性、失敗時の扱いを定める。
- 運用には入力の出典、承認ゲート、成功の観測点、失敗時の停止・復旧、バックアップ責務を書く。
- 新しい画面/API/DB テーブル/ジョブ/route は既存の唯一の責務を確認し、設計対象が存在することと実装済みであることを区別する。
- 相対リンク・図の構文・実際の操作コマンドをレビューし、既存文書の重複定義を増やさない。

**文書分類の範囲:** このガバナンスが管理するのは Codexia 自身の README、`docs`、`deploy`、`app`、`packages`、`modules`、`scripts` 配下の製品・運用文書である。同梱スキルのライセンスや配布された技術資料、閉じた移行証跡を製品設計の更新対象に含めない。外部資料は upstream の著作物として扱い、必要な場合にリンクする。
