# MCP HTTP 405 応答の公開契約是正

**種別: 未採用提案。**
HTTP ワイヤ契約と MCP transport の所有者を対象とする。
この提案の対象は MCP HTTP の GET・DELETE の 405 応答である。
既存の principal、作品割当、scope、POST の契約およびプロトコル移行期限は維持する。
[HTTP API 契約](API-CONTRACT.md) と [MCP v2 移行設計](MCP-V2-MIGRATION.md) が現行正本である。

## 公開契約と実応答の差

以下の 4 操作は、認可と作品割当の確認後に HTTP 405 を返す。
実応答は公式 MCP SDK が生成する。
`Allow` ヘッダーの値は `POST` で、`application/json` の本文には `jsonrpc: "2.0"`、`id: null`、`error: { code: -32000, message: string }` が含まれる。
epoch 4 の生成 OpenAPI は、この本文をトップレベルに文字列の `error` と `code` を持つ `ApiError` として定義している。

| Method | Path | Operation ID |
| --- | --- | --- |
| GET | `/mcp` | `mcp_root_get` |
| DELETE | `/mcp` | `mcp_root_delete` |
| GET | `/api/projects/{projectId}/modules/mcp/streamable` | `project_mcp_stream_get` |
| DELETE | `/api/projects/{projectId}/modules/mcp/streamable` | `project_mcp_stream_delete` |

HTTP と PostgreSQL を接続した試験は、割当外の作品への要求が 404 になり、割当済みの作品への要求だけが上記の 405 になることを検査する。
SDK は期間限定の stateless fallback と strict mode の両方で同じ 405 を返す。
[実経路の検証](https://github.com/yohn-jp/codexia/pull/971)

## 提案する変更

4 操作の 405 応答に必須の `Allow: POST` と上記の JSON-RPC 本文を TypeSpec で定義する。
コンシューマーは 405 の型を更新し、認可失敗の HTTP 401・403 や作品割当失敗の HTTP 404 は引き続き `ApiError` として扱う。
Fastify は入場制御を行い、入場後の 405 は引き続き公式 SDK に委譲する。

現行の epoch 4 OpenAPI と上記 405 のみを変更した比較案を、固定版 oasdiff 1.39.0 で比較した。
`error` の型変更とトップレベル `code` の削除は、全 4 操作でエラー級の破壊的差分になった。
採用時は対象 4 操作の 405 応答だけを互換手順に追加し、比較基準となる SHA、承認する API epoch の遷移、生成クライアントの切替および導入保護を [HTTP API 契約](API-CONTRACT.md#操作の追加変更廃止) に確定する。
実装 PR に進む条件は、その正本変更が承認されることである。
既存の oasdiff と正確なソース SHA に対する CI の検証を適用する。

## 受入条件

- 生成 OpenAPI の対象 4 操作に、405 の必須 `Allow: POST` と JSON-RPC エラー本文がある。
- 公式 SDK は、既存の入場制御を通過した実 API リクエストで同じ 405 を返す。
- 作品割当外の API 応答は 404 を維持し、認証なしの応答は 401 と認証チャレンジを維持する。
- oasdiff の結果、承認済み比較元と変更範囲、生成物の決定性、実 API と実 PostgreSQL の結果を同じ候補 SHA に結び付ける。
