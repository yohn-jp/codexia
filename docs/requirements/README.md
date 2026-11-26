# 要求管理・トレーサビリティの正本規則

**種別: 規範的な要求管理契約。** 本書は採用済みの製品要求を、設計・実装・検証・運用証拠まで追跡する仕組みを定義する。アーキテクチャの優先順位は [Documentation authority](../architecture/DOCUMENTATION-AUTHORITY.md)、システム境界は [System design](../architecture/SYSTEM-DESIGN.md) が引き続き所有する。本書は新たな製品機能・認証方式・互換経路を許可しない。

## 最終完了条件

**採用済みの規範的要求とその各検証可能な観点から、正本内の設計箇所、実装を担うシンボル・設定・DBオブジェクト、検出力を持つテスト、実行した検証証拠まで双方向に追跡できること。**

これは要求行数に対する単純なリンク率ではない。正常系、拒否、境界、競合、データ保護、回復、運用を含む**要求のすべての義務（obligation）**が追跡対象である。実装未完了・証拠未取得・対象外を明示して管理し、「リンクがある」ことを「適合している」ことと同一視しない。

## 正本と責務

| 情報 | 一意の所有先 |
| --- | --- |
| 製品要求の登録・採用元・要求ID | [Requirement register](REQUIREMENT-REGISTER.md) |
| システムの構成・責務・不変条件 | [System design](../architecture/SYSTEM-DESIGN.md) と既存領域正本 |
| URL、HTTP method、principal と認可 | [Route authorization](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md) |
| API のrequest/response/error、Operation ID | [API contract](../architecture/API-CONTRACT.md) |
| PostgreSQL の論理設計 | [Data model](../architecture/DATA-MODEL.md) |
| PostgreSQL 物理オブジェクトとschema lifecycle | [Database detail contract](../architecture/DATABASE-DETAIL-CONTRACT.md) |
| 外部依存・接続境界・異常時の契約 | [External interfaces](../architecture/EXTERNAL-INTERFACES.md) |
| 画面ID、CTRL ID、状態遷移 | [Screen control catalog](../design/SCREEN-CONTROL-CATALOG.md) と [Screen State Atlas](../design/SCREEN-STATE-ATLAS.md) |
| 要求/設計/実装/試験/証拠を結ぶ関係と適合状態 | [Traceability register](../verification/TRACEABILITY-REGISTER.md) |
| CI実行と証拠の真正性 | [CI/CD architecture](../verification/CI-CD.md) |

要求登録簿は既存正本の**索引と検証可能な受入条件の要約**である。具体的な振る舞いが矛盾した場合は所有する設計正本に戻して承認する。API・DB・外部IFの物理詳細を要求登録簿に複写しない。

**要求の唯一の編集正本:** [StrictDoc requirement register](REQUIREMENT-REGISTER.md)。StrictDoc Markdownを正本として採用済みREQ-ID（既存33件の移行baselineと以降の採用要件）を保持し、HTML/JSONは検証・レビュー用の派生物とする。実装候補・テスト候補のrelationだけで適合や完全coverageを認定しない。導入範囲と残件は[StrictDoc traceability](STRICTDOC-TRACEABILITY.md)に記録する。

## ID、粒度、参照の規則

- 要求ID: `REQ-<領域>-NNN`（例: `REQ-DATA-001`）。IDは安定・一意・永久欠番。改名・移動・分割でも既存IDを再利用しない。
- 設計ID: 既存の `S-xx`、`SCREEN-xx`、`CTRL-xx`、`IF-xx` などは所有文書が管理する。新規設計IDは、その文書内で一意とする。画面IDは既存台帳の実値に従う。
- API Operation ID: `API-...`、DB object ID: `DB-...`、外部IF ID: `EXT-...`。IDの見かけだけの統一のため、既存の物理名・URL・テーブル名を改名しない。
- テストID: `TEST-...` は検証**シナリオ**のID。実行ファイル・テストケース名・行番号と別に記録する。
- 要求は独立した合否判定が可能な単位まで分割する。失敗・拒否・回復が独立に重要なら別 obligation として分ける。
- パスだけでは不十分。実装参照にはパスと関数・export・ルート・DDLオブジェクトなどの安定識別子を書く。行番号・commit SHAは補助情報であり、唯一の識別子にしない。
- 多対多を許す。複数設計・実装・テストにまたがる要求を、都合よく一つの実装に帰属させない。
- 認証・認可、保存、復旧、owner承認等の横断要求は、共通 admission だけでなく**実際の入口／呼出経路ごとの適用**を追跡する。

## 状態は二軸で管理する

**要求の決定状態:** `PROPOSED`（未採用）、`ACCEPTED`（正本）、`RETIRED`（明示廃止）。提案は実装義務ではない。廃止も理由・置換ID・決定記録を残す。

**適合・証拠の状態:** `UNMAPPED`（担当実装を特定できない）、`MAPPED_UNVERIFIED`（位置を特定、実動作は未証明）、`PARTIAL`（一部義務のみ成立）、`DEVIATION`（正本と実装が矛盾）、`BLOCKED`（検証不能な阻害）、`VERIFIED`（要求範囲・ソース・実行証拠が揃う）、`NOT_APPLICABLE`（根拠つき適用外）。`ACCEPTED` と `VERIFIED` を混同しない。

実装状況を「ある/ない」だけで表さない。**観測した基準commit**と検証された環境を記録し、main更新で失効し得る証拠は再判定する。テストの存在、CI green、画面のスクリーンショット単体は全体 `VERIFIED` の根拠にならない。

## 変更管理とレビュー条件

1. 変更対象の要求ID・obligationと、その仕様を所有する文書を明確にする。新機能なら先に採用判断と受入条件を決める。
2. 影響する画面、API、DB、MCP、外部IF、インフラ、セキュリティ、性能、運用、テストを**追加・変更・削除**ごとに洗い出す。
3. 実装前に要求・詳細契約を更新し、traceability registerに期待される実装対象と検証義務を記録する。
4. 実装差分とschema/route/tool manifestを照合する。旧互換実装は「今ある」という理由で正本化しない。
5. 対象のテストを実行し、exact-source証拠へ結び付ける。未実行項目は未検証のまま残す。
6. PRで要求ID、設計変更、影響範囲、実装参照、テスト証拠、未完了をレビューする。契約の変更と機能完成を混同しない。

**出荷のための完成判定:** 当該リリースの採用済み・適用対象要求で `UNMAPPED`/`PARTIAL`/`DEVIATION`/`BLOCKED` が未処理なら、明示した受入例外なしに「全仕様適合」と宣言しない。未実装の将来目標はリリース対象範囲から明確に区別する。既存 [CI/CD](../verification/CI-CD.md) の現行ゲートを、この文書の追加だけで変更しない。

## 現段階での完了範囲

StrictDoc 0.32.1による要求HTML/JSON生成、REQ-IDとsource relationの検査、独立source scanに基づくboundedなHTTP/MCP/DB/Desktop UI/Native iOS/IaC reverse inventory、Node fault-injection、Playwright static-page checkを既存CIとRepository Audit Pagesへ統合する。source参照、意味的適合、TEST-IDの存在、exact-source実行証拠を分けて表示し、未対応の要求・surface・検証義務を生成された残件として保持する。動的route/tool、全migration/live catalog、実画面/実機挙動、適用済みIaC/host状態の未観測範囲は引き続きPARTIALまたはBLOCKEDとして扱う。
