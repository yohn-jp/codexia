# 公開 API の訂正に伴う互換性手順

**種別：承認待ちの提案。**
HTTP ワイヤ契約の所有者と、生成クライアントおよび配備の担当者を対象とする。
同一 epoch の `ERR` 拒否と初回本番導入時の epoch 3 → 4 の限定是正は、現行の [API 契約](API-CONTRACT.md#操作の追加変更廃止) に従う。
ルート認可、MCP POST の応答および Backup Console の実行時受付条件は、それぞれの既存契約に従う。

## 訂正範囲と API epoch

| 訂正 | 対象とする差分 |
| --- | --- |
| Backup Console の認証宣言 | 11 操作の `security` を既存の owner session cookie に揃える |
| Backup Console のリクエスト条件 | 4 つの POST の JSON 本文と `Idempotency-Key` を既存の受付条件に揃える |
| MCP のメソッド拒否 | 2 つの入口の GET と DELETE（4 操作）の 405 を SDK の JSON-RPC 本文と `Allow: POST` に揃える |

採用する訂正を一つの epoch 4 → 5 の遷移にまとめることを提案する。
MCP の 405 は生成クライアントが公開済みの応答型を変更するため、採用時にはクライアントの切替を伴う。
各訂正の採否は明示し、承認対象の操作とフィールドだけを遷移に含める。
別の基準 SHA、epoch または範囲を選ぶ場合は、その組み合わせの差分を改めて設計承認に付す。

## 承認する基準と比較結果

1. 承認済みの epoch 4 の `main` コミットを完全な SHA で固定し、そのコミットの TypeSpec、依存ロックおよび生成器から基準 OpenAPI を再生成する。候補も候補コミットの同じ入力から生成する。基準と候補ごとに OpenAPI、Frontend、Backend の互換マニフェストが承認対象の epoch と一致することを確認する。
2. 固定版 oasdiff の `breaking --format json --allow-external-refs=false --fail-on ERR` で、同じ基準から各訂正と採用対象を組み合わせた候補を比較する。基準と候補の SHA、完全な JSON 出力、終了コード、および生成 OpenAPI の差分を設計審査の記録に残す。
3. 各 `ERR` を `operationId`、HTTP method、path、oasdiff の検出 ID と fingerprint で特定する。oasdiff の method と path は基準と候補の `operationId` に照合する。採用対象を組み合わせて測った `ERR` を件数込みで承認し、比較結果の余分な項目、欠落、重複および終了コードの不一致を拒否する。生成 OpenAPI の差分も照合し、oasdiff が `ERR` に分類しない変更を含めて、承認対象のフィールドと epoch 更新の範囲に収まることを確認する。
4. 採用する訂正、基準 SHA、epoch の組、完全な `ERR` の照合条件および配備時の切替を [API 契約](API-CONTRACT.md#操作の追加変更廃止) で明示的に承認してから実装を開始する。現行の比較では、PR イベントの `pull_request.base.sha` と main push の `before` が基準を決める。実装時の許容は、イベントの基準 SHA と承認済み基準 SHA が一致する遷移に限る。`main` が進んで基準 SHA が変わった場合は再生成と再比較を行い、新しい組み合わせを承認に付す。 [ツール受入契約](../verification/SPECIFICATION-TOOLING-ACCEPTANCE.md#openapi-lintdiffruntime検証の分界)

## 承認後の切替と受入

- 同一 epoch の `ERR`、承認外の基準 SHA や epoch、対象内外の未承認差分、期待した差分の欠落と重複で比較が失敗することを検証する。訂正が main に入った後は、後続の通常比較がイベントで指定される訂正後の基準を使い、同一 epoch の `ERR` を拒否することを検証する。
- Web と iOS の生成クライアントを候補から再生成し、対象操作と型を照合する。外部クライアント向けには変更箇所と切替条件を示す。既存稼働環境への epoch をまたぐ自動更新は拒否し、切替、復旧および再開の手順は配備ライフサイクルに従って承認する。 [通常更新契約](../deployment/UPDATE-FLOW.md) · [配備ライフサイクル](../deployment/DEPLOYMENT-LIFECYCLE.md)
- 生成の決定性、Redocly、oasdiff、対象 operation の実 API 検証と CI の認定を同じ実装候補 SHA に結び付ける。
