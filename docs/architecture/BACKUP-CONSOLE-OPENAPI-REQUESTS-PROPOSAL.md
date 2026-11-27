# Backup Console の OpenAPI リクエスト条件の訂正

**種別は承認済みの API epoch 5 設計。** HTTP ワイヤ契約と Backup Console の所有者を対象とする。
扱う変更は、公開 OpenAPI の JSON 本文と `Idempotency-Key` の訂正である。

## 実際の受付条件

Backup Console の4つの POST は、`Idempotency-Key` で保存済みの操作または実行を識別する。
設定操作は対象 revision と検証済み probe に束縛され、手動バックアップは承認済みの維持管理時間帯と影響確認に束縛される。
認可された所有者は、応答が途絶えても同じキーと入力で操作の受付を再確認できる。 [バックアップ管理契約](BACKUP-CONSOLE-CONTRACT.md) · [受付と検証](../../packages/api/src/backup-console-routes.ts) · [永続化と再実行](../../packages/api/src/backup-console-store.ts)

| POST パス | Operation ID | 実装で必須の JSON 本文 | 現行 OpenAPI のキー必須指定 |
| --- | --- | --- | --- |
| `/api/console/backups/config/probes` | `backup_console_config_probes_post` | `revision` | 任意 |
| `/api/console/backups/config/activate` | `backup_console_config_activate_post` | `revision`、`probeId`、`confirmed: true` | 任意 |
| `/api/console/backups/config/disable` | `backup_console_config_disable_post` | `revision`、`confirmed: true` | 任意 |
| `/api/console/backups/runs` | `backup_console_runs_post` | `maintenanceWindowId`、`confirmed: true` | 必須 |

`revision` は `1` から `2147483647` の整数で、`probeId` は UUID。
`maintenanceWindowId` は英数字、`_`、`-` の1〜64文字。
ランタイムは全4操作で同じ文字集合の16〜128文字を `Idempotency-Key` に要求し、本文に未知フィールドを含むリクエストを `422` で拒否する。
現行の TypeSpec は本文を必須とするが、JSON オブジェクト内のフィールドとキーの文字集合や長さには制約を定義していない。 [TypeSpec 入力定義](../../packages/http-contract/src/routes-backup-console.tsp)

## 互換性の判定

oasdiff の検出対象には、本文の必須プロパティの追加、任意だったキーの必須化、およびキーパターンの追加が含まれる。
実行時の受付条件は維持するが、生成クライアントで必須となるプロパティが増える。
実装前に初回本番導入前であることを確認し、基準 SHA と `ERR` の完全照合を行う。 [API epoch 5 契約是正](API-COMPATIBILITY-TRANSITION-PROPOSAL.md)

## 受入条件

1. TypeSpec に表の 4 操作の本文とキーの条件を記述する。生成 OpenAPI の差分で、操作、本文のプロパティ、未知フィールドの拒否、キーの必須指定とパターンを照合する。
2. 隔離 PostgreSQL を使う実 API で、正常な受付、必須フィールドやキーの欠落、不正形式、未知フィールド、同じキーでの再送と異なる入力での拒否を確認する。owner session、CSRF および再認証は採用済みの認可契約に従う。 [バックアップ管理契約](BACKUP-CONSOLE-CONTRACT.md)
