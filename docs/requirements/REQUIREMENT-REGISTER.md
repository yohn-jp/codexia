# Codexia 要求登録簿（初期ベースライン）

**種別: 採用済み要求の追跡用索引。** 登録の規則は [requirements governance](README.md)。本簿の要求は、それぞれのリンク先の既存規範的設計を抽出して識別したものであり、未合意の追加製品機能を新設しない。詳細動作は常にリンク先の所有正本が優先する。

**観測基準:** `main@e02933aead466b14cbcd336905b9c2a2a2b39f06`（2026-11-23 の索引構築）。この表は **主要要求の初期集合**であって、未収載の要求が存在しないという宣言ではない。全設計節・禁止事項・受入シナリオのobligationへの分解と、実装・試験照合は [Traceability register](../verification/TRACEABILITY-REGISTER.md) で継続する。

各行の「合否の観点」は検証観点の要約である。具体的な検証パラメータ、principal、操作、正常/異常の期待値を持つテスト仕様と連結して初めて完全な受入条件になる。設計だけがある項目は実装済みとみなさない。

| 要求ID | 検証可能な要求・合否の観点 | 詳細正本 | 決定/実装上の区分 |
| --- | --- | --- | --- |
| REQ-CORE-001 | Optional module停止・未導入でも作品作成、執筆、保存、履歴、復元を継続する | [System design](../architecture/SYSTEM-DESIGN.md)、[Core](../architecture/CORE.md) | ACCEPTED／適合未認定 |
| REQ-CORE-002 | module/MCPの変更は提案を経由し、作者承認・再検査前に原稿を直接変更しない | [Core](../architecture/CORE.md)、[Modules](../architecture/MODULES.md) | ACCEPTED／適合未認定 |
| REQ-CORE-003 | Snapshotをproject/versionへ固定し、古い参照や別projectの結果を現行状態として使わない | [Core](../architecture/CORE.md) | ACCEPTED／適合未認定 |
| REQ-DATA-001 | 原稿・構成・Revision・Knowledge・Evidence・ChangeSet・module recordの正本はPostgreSQLのみ | [Data model](../architecture/DATA-MODEL.md) | ACCEPTED／適合未認定 |
| REQ-DATA-002 | 原稿revisionは不変で、保存・復元は整合性を守る新RevisionとDB receiptで表す | [Data model](../architecture/DATA-MODEL.md)、[Core](../architecture/CORE.md) | ACCEPTED／適合未認定 |
| REQ-DATA-003 | project境界をすべての関連オブジェクト・階層・根拠・提案の参照と書込で保持する | [Data model](../architecture/DATA-MODEL.md) | ACCEPTED／適合未認定 |
| REQ-DATA-004 | 既存migrationのchecksum/fingerprintを検証し、未承認のDB schema変更をアプリ更新で行わない | [Data model](../architecture/DATA-MODEL.md)、[Update flow](../deployment/UPDATE-FLOW.md) | ACCEPTED／適合未認定 |
| REQ-AUTH-001 | owner APIはCodexia発行OAuth bearerを署名・audience・scope・ownerとして検証する | [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md) | ACCEPTED／適合未認定 |
| REQ-AUTH-002 | HTTP methodとpathだけでなくprincipal・project・object・revision・effectでfail-closed認可する | [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md) | ACCEPTED／適合未認定 |
| REQ-AUTH-003 | MCP clientは割当projectとread/compute/proposeまで。承認/applyやowner私有操作を行えない | [MCP OAuth](../architecture/MCP-OAUTH.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md) | ACCEPTED／適合未認定 |
| REQ-AUTH-004 | Passkey-firstの初回owner登録は一回限りsetup資格、owner不在、認証ceremonyを満たす | [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md)、[Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md) | ACCEPTED／**目標・未実装** |
| REQ-AUTH-005 | `/console`管理、Passkey/session、OIDC設定はowner権限と再認証に拘束する | [Admin screen flow](../design/ADMIN-SCREEN-FLOW.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md) | ACCEPTED／**目標・未実装** |
| REQ-API-001 | APIの入口、body/query、レスポンス、エラー、認可、競合、冪等性をmethod/path/Operationで特定する | [API contract](../architecture/API-CONTRACT.md)、[Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md) | ACCEPTED／設計台帳の全面検証待ち |
| REQ-API-002 | 作者向けMutationでrequest identity・precondition・receiptを確認し、競合/応答不明を偽成功にしない | [Core](../architecture/CORE.md)、[Interaction contract](../design/INTERACTION-CONTRACT.md) | ACCEPTED／適合未認定 |
| REQ-MCP-001 | stdioとHTTPのMCPは同じCore action/effect境界に到達し、独立writerを持たない | [MCP-first](../architecture/MCP-FIRST.md)、[Modules](../architecture/MODULES.md) | ACCEPTED／適合未認定 |
| REQ-MCP-002 | 外部AIによる推論とCodexia内のCore編集を分離し、内部LLM API拡張を再開しない | [MCP-first](../architecture/MCP-FIRST.md) | ACCEPTED／適合未認定 |
| REQ-UI-001 | Desktop/Mobileは同じ原稿とCore契約を使い、表示shellを自動的に勝手に変更しない | [UX contract](../design/UX-CONTRACT.md)、[User flows](../design/USER-SCREEN-FLOW.md) | ACCEPTED／適合未認定 |
| REQ-UI-002 | 未送信/保存中/DB確定/応答不明を区別し、下書きを黙って捨てない | [Interaction contract](../design/INTERACTION-CONTRACT.md)、[UX contract](../design/UX-CONTRACT.md) | ACCEPTED／適合未認定 |
| REQ-UI-003 | 画面、操作、遷移、戻り先、エラー、principalを画面ID/CTRL IDで特定する | [Screen catalog](../design/SCREEN-CONTROL-CATALOG.md)、[State Atlas](../design/SCREEN-STATE-ATLAS.md) | ACCEPTED／設計済み・適合未認定 |
| REQ-UI-004 | IME、選択、focus、編集中の遅延・画面移動でも原稿と復旧可能性を保持する | [UX contract](../design/UX-CONTRACT.md) | ACCEPTED／適合未認定 |
| REQ-UI-005 | 適用可能なWCAG 2.2 A/AA、keyboard、reflow等の受入義務を満たす | [UX contract](../design/UX-CONTRACT.md) | ACCEPTED／適合未認定 |
| REQ-EXT-001 | Edgeの静的UI配信とAPI/Tunnelのルーティングを分け、AccessをCore認可の代わりにしない | [Deployment](../deployment/README.md)、[System design](../architecture/SYSTEM-DESIGN.md) | ACCEPTED／適合未認定 |
| REQ-EXT-002 | OAuth/OIDC、MCP、公開readerの外部境界はscope/audience/公開範囲を個別に検証する | [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)、[External interfaces](../architecture/EXTERNAL-INTERFACES.md) | ACCEPTED／適合未認定 |
| REQ-OPS-001 | 新規VMのbootstrap、owner登録、公開、復旧を明示した別状態として扱う | [Initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md) | ACCEPTED／一部目標・適合未認定 |
| REQ-OPS-002 | 更新はexact-source検証、互換性、snapshot保全、失敗時停止/rollback規則を守る | [Update flow](../deployment/UPDATE-FLOW.md)、[CI/CD](../verification/CI-CD.md) | ACCEPTED／適合未認定 |
| REQ-OPS-003 | バックアップと隔離復元でPostgreSQL正本と運用状態の復旧を検証する | [Backup](../deployment/BACKUP.md) | ACCEPTED／適合未認定 |
| REQ-QUAL-001 | テストは契約の正常/異常/境界と実DB/API/UI/hostを分け、モックでは境界統合を証明しない | [Test architecture](../verification/TEST-ARCHITECTURE-OPTIMIZATION.md) | ACCEPTED／適合未認定 |
| REQ-QUAL-002 | CIは選択タスク、exact-source、成果物IDと必須gateを証明し、未実行/欠落をPASSとしない | [CI/CD](../verification/CI-CD.md) | ACCEPTED／適合未認定 |
| REQ-QUAL-003 | INP p75、CLS p75の品質目安に加え、原稿入力・保存・復旧の別々の実測で評価する | [UX contract](../design/UX-CONTRACT.md)、[Performance](../performance/README.md) | ACCEPTED／計測状態未認定 |
| REQ-TRACE-001 | すべての採用済み要求のobligationを正本→実装→検証→証拠まで双方向に追跡する | [Requirements governance](README.md)、[Traceability register](../verification/TRACEABILITY-REGISTER.md) | ACCEPTED／**構築中** |

## 網羅監査の作業単位

この表にIDを振っただけでは網羅完了ではない。以下を独立に照合する。

1. 各規範的設計書の **MUST、禁止事項、不変条件、状態遷移、受入シナリオ、負の認可条件**を抽出し、すべて既存要求または新要求IDのobligationへ対応付ける。
2. 全画面ID/CTRL IDと全URL+method、MCP tool、DB表・列・制約・索引、外部IF、CI/deploy遷移について、対応要求IDまたは「仕様外/未採用/補助実装」の区分を付ける。
3. 全実装入口/DB migration/外部設定と主要テストから要求へ**逆引き**し、意図のない互換処理・孤立テスト・未承認設定を発見する。
4. 欠落があれば設計変更を先に確定し、ここを追加・分割する。コードの存在だけで新要求を採用しない。

将来の未採用提案（例: Knowledge局所グラフ）は本登録簿に採用済み要求として入れず、所有文書で `PROPOSED` として扱う。
