# Backup Console の OpenAPI リクエスト条件を訂正する提案

**承認待ちの提案。** 現行の互換性ルールは [API 契約](API-CONTRACT.md) を参照する。

## 実際の受付条件

Backup Console の4つの POST は、`Idempotency-Key` で保存済みの操作または実行を識別する。
設定操作は対象 revision と検証済み probe に束縛され、手動バックアップは承認済みの維持管理時間帯と影響確認に束縛される。
認可された所有者は、応答が途絶えても同じキーと入力で操作の受付を再確認できる。 [バックアップ管理契約](BACKUP-CONSOLE-CONTRACT.md) · [受付と検証](../../packages/api/src/backup-console-routes.ts) · [永続化と再実行](../../packages/api/src/backup-console-store.ts)

| POST パス | 実装で必須の JSON 本文 | OpenAPI のキー必須指定 |
| --- | --- | --- |
| `/api/console/backups/config/probes` | `revision` | 任意 |
| `/api/console/backups/config/activate` | `revision`、`probeId`、`confirmed: true` | 任意 |
| `/api/console/backups/config/disable` | `revision`、`confirmed: true` | 任意 |
| `/api/console/backups/runs` | `maintenanceWindowId`、`confirmed: true` | 必須 |

`revision` は `1` から `2147483647` の整数で、`probeId` は UUID。
`maintenanceWindowId` は英数字、`_`、`-` の1〜64文字。
ランタイムは全4操作で同じ文字集合の16〜128文字を `Idempotency-Key` に要求し、本文に未知フィールドを含むリクエストを `422` で拒否する。
現行の TypeSpec は本文を任意の JSON オブジェクトとして定義し、キーの文字集合と長さを定義していない。 [TypeSpec 入力定義](../../packages/http-contract/src/routes-backup-console.tsp)

## 固定版 oasdiff の結果

main `0269ae62a74768917dbe7750e0799075021e06bb` の TypeSpec を依存ロックから生成し、一時ファイル上で4操作の本文とキーを上記条件に置き換えた。
oasdiff 1.39.0 は `ERR` 15件を報告し、終了コードは `1` だった。
本文の必須項目が8件、キーの必須化が3件、キーパターンの追加が4件だった。 [基準コミット](https://github.com/yohn-jp/codexia/commit/0269ae62a74768917dbe7750e0799075021e06bb) · [比較ポリシー](../../packages/http-contract/scripts/breaking-policy.mjs)

| POST の末尾 | `new-required-request-property` | `request-parameter-became-required` | `request-parameter-pattern-added` |
| --- | --- | --- | --- |
| `config/probes` | `d58122c2ea93` | `3842362e25e4` | `fe625b65d593` |
| `config/activate` | `89e693975f8d` `3c443339be5d` `3cb6149f7a7e` | `311652991f89` | `5c437f462c0d` |
| `config/disable` | `ccbad916e237` `b3d0f006cfb0` | `1d8dc614cb98` | `eec09e87df8c` |
| `runs` | `011c44996fca` `f37ad79bdc81` | 該当なし | `f9299c26630d` |

## 互換性基準の選択

| 案 | 承認する変更 | 影響 |
| --- | --- | --- |
| epoch 4 の比較基準を一度訂正する | 合意した基準 SHA から、表の4操作の指定フィールド差分だけを承認する | 既存の適格なクライアントは同じリクエストを使える。生成クライアントでは新たに必須項目が表示される |
| 新しい API epoch を承認する | OpenAPI と Frontend、Backend の互換マニフェストを新しい epoch に揃える | 既存配備では通常の互換更新条件を満たさなくなり、配備手順の別承認が必要になる |

同一 epoch の一度限りの訂正を提案する。
実際に受付可能な入力集合は変わらず、公開契約を既存の受付条件に揃えるための変更である。 [通常更新契約](../deployment/UPDATE-FLOW.md)

## 承認後の検証

1. TypeSpec に4操作の本文とキーの必須条件を記述する。生成された OpenAPI の差分を比較し、操作、本文のプロパティ、追加プロパティの拒否、キーの必須指定とパターンが承認範囲に一致することを確認する。
2. 基準 SHA、epoch、method、path、検出 ID、fingerprint を照合し、固定版 oasdiff の全出力を保存する。別の基準 SHA、対象外の操作、対象内の承認外変更を加えた試験で失敗を確認する。通常の比較は訂正後のスキーマを基準に従来の方針を適用する。
3. 隔離 PostgreSQL の実 HTTP で、正常な受付、必須フィールドやキーの欠落、不正形式、未知フィールド、同じキーでの再送と異なる入力での拒否を確認する。owner session、CSRF、再認証、暗号文と独立復旧の証拠区分を既存の検証で確認する。
4. TypeSpec の決定的生成と Redocly、利用クライアントの型検査および最新 PR HEAD の認定を記録する。運用上の受入は採用済みの配備ライフサイクルに従う。 [配備ライフサイクル](../deployment/DEPLOYMENT-LIFECYCLE.md)
