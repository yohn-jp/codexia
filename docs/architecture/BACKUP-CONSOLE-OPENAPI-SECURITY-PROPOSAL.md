# Backup Console の OpenAPI 認証宣言の訂正

**種別は承認済みの API epoch 5 設計。** HTTP ワイヤ契約と Backup Console の所有者を対象とする。
扱う変更は、公開 OpenAPI の `security` 宣言の訂正である。

## 公開スキーマと認可の差

Backup Console API の11操作は、Better Auth の `OWNER-SESSION` cookie を要求する。
Fastify の登録時に owner の照合を適用し、書き込みでは Origin と CSRF を検査する。
資格情報の設定、有効化、停止、手動実行には直近の再認証も求める。
Bearer token を提示したリクエストは拒否される。
これらの権限は採用済みの設計で定義され、隔離 PostgreSQL の統合試験で各 principal の許可と拒否を確認できる。 [バックアップ管理契約](BACKUP-CONSOLE-CONTRACT.md) · [認可契約](ROUTE-AUTHORIZATION-CONTRACT.md) · [統合試験](../../packages/api/test/backup-console.integration.test.ts)

同じ11操作の OpenAPI `security` は、API 共通の `BearerAuth` を継承している。
OpenAPI を読む利用者やクライアント生成器には、実際には拒否される認証方式が示される。
`x-codexia-security-deviation` は不一致を人間に知らせるための注記で、`security` の効果は上書きしない。 [TypeSpec の定義](../../packages/http-contract/src/routes-backup-console.tsp)

## 訂正対象の操作

| メソッド | パス | Operation ID |
| --- | --- | --- |
| GET | `/api/console/backups/config` | `backup_console_config_get` |
| POST | `/api/console/backups/config/activate` | `backup_console_config_activate_post` |
| POST | `/api/console/backups/config/disable` | `backup_console_config_disable_post` |
| PUT | `/api/console/backups/config/draft` | `backup_console_config_draft_put` |
| POST | `/api/console/backups/config/probes` | `backup_console_config_probes_post` |
| GET | `/api/console/backups/config/probes/{probeId}` | `backup_console_config_probe_get` |
| GET | `/api/console/backups/recovery` | `backup_console_recovery_get` |
| GET | `/api/console/backups/runs` | `backup_console_runs_get` |
| POST | `/api/console/backups/runs` | `backup_console_runs_post` |
| GET | `/api/console/backups/runs/{runId}` | `backup_console_run_get` |
| GET | `/api/console/backups/status` | `backup_console_status_get` |

全 11 操作の `security` に既存の `OwnerSessionCookie` を指定する。
既存の認証方式の削除は oasdiff の `api-security-removed` に該当する。
実装前に初回本番導入前であることを確認し、基準 SHA と `ERR` の完全照合を行う。 [API epoch 5 契約是正](API-COMPATIBILITY-TRANSITION-PROPOSAL.md)

## 受入条件

1. 生成 OpenAPI で表の 11 操作の認証宣言が owner session cookie に揃い、表の対象外では `security` の差分がないことを確認する。削除するのは、訂正した `security` 宣言に対応する `x-codexia-security-deviation` の注記に限る。
2. 隔離 API で owner session の提示、Bearer token と他 principal の拒否、CSRF、Origin および再認証を再検証する。
3. Scalar の公開表示が認証宣言に一致することを確認する。実環境での Console 設定と独立復旧の受入は、配備ライフサイクルに従う。 [配備ライフサイクル](../deployment/DEPLOYMENT-LIFECYCLE.md)
