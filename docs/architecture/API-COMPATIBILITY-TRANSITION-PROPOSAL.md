# 初回本番導入前の API epoch 5 契約是正

**種別は承認済みの規範的設計。**
この文書は [HTTP API 契約](API-CONTRACT.md#操作の追加変更廃止) に基づき、初回本番導入前に一度だけ行う API epoch 4 → 5 の対象と受入条件を定める。
実装済みのワイヤ契約は TypeSpec と同一ソースから生成した OpenAPI で確認する。

## 是正する操作

| 対象 | 承認範囲 |
| --- | --- |
| Backup Console 11 操作の認証宣言 | `backup_console_config_get`、`backup_console_config_activate_post`、`backup_console_config_disable_post`、`backup_console_config_draft_put`、`backup_console_config_probes_post`、`backup_console_config_probe_get`、`backup_console_recovery_get`、`backup_console_runs_get`、`backup_console_runs_post`、`backup_console_run_get`、`backup_console_status_get` の `security` を既存の owner session cookie に揃える。対応する乖離注記を削除する |
| Backup Console 4 POST の受付条件 | `backup_console_config_probes_post` に `revision`、`backup_console_config_activate_post` に `revision`、`probeId`、`confirmed: true`、`backup_console_config_disable_post` に `revision` と `confirmed: true`、`backup_console_runs_post` に `maintenanceWindowId` と `confirmed: true` を必須とする。4 操作の `Idempotency-Key` を英数字、`_`、`-` の16〜128文字とし、本文の未知フィールドを拒否する |
| MCP 4 操作の HTTP 405 応答 | `mcp_root_get`、`mcp_root_delete`、`project_mcp_stream_get`、`project_mcp_stream_delete` の入場後の 405 を、公式 SDK の JSON-RPC エラー本文と必須の `Allow: POST` に揃える |

POST 本文の `revision` は1〜2147483647の整数、`probeId` は UUID とする。
`maintenanceWindowId` は英数字、`_`、`-` の1〜64文字とする。
HTTP 405 の JSON 本文は `jsonrpc: "2.0"`、`id: null`、`error: { code: -32000, message: string }` を持つ。

実行時の owner session、Origin、CSRF、直近の再認証、作品割当、MCP POST の応答および入場前の拒否は、既存の [認可設計](ROUTE-AUTHORIZATION-CONTRACT.md)、[バックアップ管理契約](BACKUP-CONSOLE-CONTRACT.md) と [MCP v2 移行設計](MCP-V2-MIGRATION.md) に従う。

## 比較基準と照合

1. 実装前に、保護された運用記録または既存 Preflight の読取証拠から、対象が初回本番導入前であることを確認する。本番導入済みまたは確認不能なら epoch を変更しない。OCI 成果物の発行や Access の疎通確認は本番の初回 Backend activation を証明しない。
2. 認定済みの最新 `main` から、epoch 4 の基準 SHA を完全な値で固定する。基準と候補の TypeSpec、依存ロックおよび生成手順から OpenAPI を生成する。OpenAPI、Frontend、Backend の互換マニフェストで、基準は 4、候補は 5 に一致させる。
3. 固定版 oasdiff の `breaking --format json --allow-external-refs=false --fail-on ERR` を実行する。基準と候補の SHA、完全な JSON、終了コード、生成 OpenAPI の差分を実装 PR に残す。暫定候補で確認した34件は認証11件、リクエスト15件、MCP 405応答8件で、実装時の差分を照合する参照とする。
4. `ERR` は、基準と候補の `operationId`、HTTP method、path、oasdiff の検出 ID と fingerprint が対象に完全一致することを照合する。件数が合っていても、対象外、欠落、重複、内容の相違または終了コードの不一致があれば失敗とする。oasdiff が `ERR` に分類しない差分を含め、生成 OpenAPI 全体を確認する。
5. 実装の許容は、採用対象を照合して固定した基準 SHA での 4 → 5 に限る。PR イベントの `pull_request.base.sha` または main push の `before` がその基準 SHA に一致する必要がある。基準 SHA が進んだ場合は再生成と再比較を行い、この承認範囲との一致を確認する。同一 epoch の `ERR` と承認外の遷移は引き続き拒否する。

## 切替と受入

- TypeSpec、Fastify の生成スキーマ、Desktop Web の Orval、Frontend と Backend の互換マニフェスト、配布契約を同じ候補 SHA で揃える。既存 iOS API 生成契約への影響を確認する。Native iOS 開発と IPA CI の凍結を継続する。
- 生成の決定性、Redocly、oasdiff、実 API の認可、受付および 405 応答を同じ候補 SHA で検証する。移行後の比較では、イベントが示す新しい基準に対して同一 epoch の `ERR` を引き続き拒否する。
- 初回導入では認定済みの互換 Frontend と Backend を使用する。既存稼働環境の epoch をまたぐ自動更新を拒否する。配備、復旧と再開は既存の [配備ライフサイクル](../deployment/DEPLOYMENT-LIFECYCLE.md) と [通常更新契約](../deployment/UPDATE-FLOW.md) に従う。
