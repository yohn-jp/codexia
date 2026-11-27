# Backup Console の OpenAPI 認証宣言を訂正する提案

**承認待ちの提案。** 採用済みの互換性ルールは [API 契約](API-CONTRACT.md) を参照する。

## 公開スキーマと認可の差

Backup Console API の11操作は、Better Auth の `OWNER-SESSION` cookie を要求する。
Fastify の登録時に owner の照合を適用し、書き込みでは Origin と CSRF を検査する。
資格情報の設定、有効化、停止、手動実行には直近の再認証も求める。
Bearer token を提示したリクエストは拒否される。
これらの権限は採用済みの設計で定義され、隔離 PostgreSQL の統合試験で各 principal の許可と拒否を確認できる。 [バックアップ管理契約](BACKUP-CONSOLE-CONTRACT.md) · [認可契約](ROUTE-AUTHORIZATION-CONTRACT.md) · [統合試験](../../packages/api/test/backup-console.integration.test.ts)

同じ11操作の OpenAPI `security` は、API 共通の `BearerAuth` を継承している。
OpenAPI を読む利用者やクライアント生成器には、実際には拒否される認証方式が示される。
`x-codexia-security-deviation` は不一致を人間に知らせるための注記で、`security` の効果は上書きしない。 [TypeSpec の定義](../../packages/http-contract/src/routes-backup-console.tsp)

## 互換性の判定

main `0269ae62a74768917dbe7750e0799075021e06bb` の生成 OpenAPI を使い、11操作の `security` だけを既存 Better Auth cookie scheme に置き換えた。
固定版 oasdiff 1.39.0 は `api-security-removed` を11件の `ERR` として報告し、終了コードは `1` だった。
現行ルールでは同一 epoch の `ERR` は不合格となる。
既承認の epoch 3 → 4 の例外は永続化 API と MCP POST の所定の訂正に限られる。 [基準コミット](https://github.com/yohn-jp/codexia/commit/0269ae62a74768917dbe7750e0799075021e06bb) · [API 契約](API-CONTRACT.md) · [比較ポリシー](../../packages/http-contract/scripts/breaking-policy.mjs)

| メソッド | パス | oasdiff fingerprint |
| --- | --- | --- |
| GET | `/api/console/backups/config` | `5edc225a60bd` |
| POST | `/api/console/backups/config/activate` | `777a7d416cc7` |
| POST | `/api/console/backups/config/disable` | `0729b4686ecc` |
| PUT | `/api/console/backups/config/draft` | `42450c7fbfdc` |
| POST | `/api/console/backups/config/probes` | `c5b5c437364b` |
| GET | `/api/console/backups/config/probes/{probeId}` | `462226c9d43b` |
| GET | `/api/console/backups/recovery` | `0bccb6b6f32a` |
| GET | `/api/console/backups/runs` | `b49d47d0e2e8` |
| POST | `/api/console/backups/runs` | `ba4cb05bcde8` |
| GET | `/api/console/backups/runs/{runId}` | `47df5bbd9d56` |
| GET | `/api/console/backups/status` | `2916a4995270` |

## 選択肢

| 案 | 互換性への影響 | 運用への影響 |
| --- | --- | --- |
| epoch 4 のまま比較基準を一度訂正する | 合意した基準 SHA と11件の認証宣言差分に限って `ERR` を承認する。以後の比較は訂正後の OpenAPI が基準となる | 現在許可されるクライアントは同じ cookie とリクエストで利用できる |
| 新しい API epoch を承認する | OpenAPI と Frontend、Backend の互換マニフェストを新しい epoch に揃える | 通常互換更新の対象外になるため、既存配備を扱う手順と承認が別途必要になる |
| 現行の注記を継続する | 公開スキーマと現行の比較基準を維持する | 生成クライアントに `BearerAuth` が示され続ける |

一度限りの基準訂正を提案する。
実際に許可されるリクエスト集合が同じであり、誤った認証方式を公開スキーマから除くために、通常更新の互換条件まで変える根拠がない。 [通常更新契約](../deployment/UPDATE-FLOW.md)

## 承認後の受入条件

1. 承認した基準コミットの TypeSpec を依存ロックから生成し、OpenAPI と oasdiff の完全な出力を実装 PR に記録する。
2. `security` の変更を表の11操作に限定し、既存の `OwnerSessionCookie` を指定する。比較で許容する `ERR` は基準 SHA、epoch 4、各 method と path、検出 ID、fingerprint が全件一致する場合に限る。基準が進んだ場合は対象差分を再計測し、承認対象との一致を確認する。
3. 他の操作に同種の差分を加えたケース、対象操作に追加の非互換差分を加えたケース、基準 SHA を変えたケースが引き続き失敗することを確認する。訂正後の基準を使う通常の同一 epoch 比較では従来どおり `ERR` を拒否する。
4. 採用済み cookie の定義を共有し、Fastify の `OWNER-SESSION`、CSRF、Origin、再認証および他 principal の拒否を隔離 API で再検証する。TypeSpec の決定的な生成、Redocly、Scalar の公開表示、関連するクライアント生成と最新 PR HEAD の認定で確認する。
5. API 契約の変更管理には承認済みの訂正範囲と基準を記録する。実環境での Console 設定と独立復旧の受入は、運用ライフサイクルの手順に従う。 [配備ライフサイクル](../deployment/DEPLOYMENT-LIFECYCLE.md)
