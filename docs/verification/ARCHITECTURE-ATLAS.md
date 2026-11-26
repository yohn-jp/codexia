# Architecture Atlas — グラフィカルな設計図

**種別: ビューアーの検証・運用手順。** 設計上の正本は [画面状態遷移図](../design/SCREEN-STATE-ATLAS.md)、[全画面操作台帳](../design/SCREEN-CONTROL-CATALOG.md)、[URL/API認可](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)、[システム設計](../architecture/SYSTEM-DESIGN.md)、[LikeC4 system model](../architecture/likec4/model.likec4)、[利用画面](../design/USER-SCREEN-FLOW.md)、[管理画面](../design/ADMIN-SCREEN-FLOW.md)、[初期デプロイ](../deployment/INITIAL-DEPLOYMENT-FLOW.md)、[更新](../deployment/UPDATE-FLOW.md)、[本番Deploymentライフサイクル](../deployment/DEPLOYMENT-LIFECYCLE.md) と、それらが参照する領域設計書にある。LikeC4 モデルが `system-1` のシステム構造・信頼境界と `system-3` の運用トポロジーを定義する。Mermaid 図は各設計書の原文に従う。

[Architecture Atlas（公開版）](https://yohn-jp.github.io/codexia/architecture/) は Repository Audit Pages に同梱する開発者向けの設計ビューアーで、システム構造、信頼境界、状態・画面遷移、データモデル、デプロイ手順を閲覧できる。詳細画面の全図を含む表示件数はビルド時のmanifestから取得し、文書更新に伴う追加にも対応する。カテゴリから図を選び、拡大・縮小し、元の設計書を開ける。LikeC4 ビューでノードと関係を探索し、Mermaid ビューでは SVG 単体を開ける。初回所有者のウィザードとコンソールの遷移は`#admin-4`・`#admin-5`、VM再構築は`#first-3`、統合Deployment経路は`#lifecycle-1`で直接参照できる。個別の図は `#user-1`、`#admin-1`、`#first-1`、`#update-1` などの hash で直接開ける。

図はカテゴリと検索語で絞り込める。
画面 ID に対応する操作台帳がある場合は、実装と設計目標の記載を SHA 固定の表の行と共に表示する。
関連実装ファイルへの Code Map リンクは、同じ SHA の索引に対象パスがある場合に表示する。
版不一致、索引外、確認できない状態はビューアー上で確認できる。

## 生成・権限

- システム構造・信頼境界と運用トポロジーは、固定版 LikeC4 CLI の `gen webcomponent` で一つの自己ホストモジュールに生成する。Web Component は `system-1` と `system-3` を描画し、G5 はモデルと構造境界を検証する。
- `system-2` の運用順序・承認、画面や操作の状態遷移、導入・更新手順、データモデルの ER 図は、承認済み設計書を正本とする。Mermaid で分岐・時系列・キーと多重度を表し、固定版 Mermaid CLI で SVG を生成する。
- Atlas の manifest は各図の正本の path/line、描画方式と出力を、同一 source SHA に結び付ける。サイト全体の manifest は LikeC4 モデル、生成器 lock、公開 bundle とライセンスの SHA-256 を記録する。
- PR プレビューと main 公開は既存の Repository Audit Pages が担当する。ビューアーは同一オリジンの静的資産を使い、製品データや運用機能に接続しない。

## 検証

ローカルの静的契約:
```sh
node --test scripts/architecture-diagrams/pack.test.mjs
```

GitHub Actions は lockfile の LikeC4 CLI、固定版 Mermaid CLI と Chromium を用意し、次を実行する。
```sh
npm ci --prefix scripts/architecture --ignore-scripts --no-audit --no-fund
node scripts/architecture-diagrams/pack.mjs "$SITE" "$COMMIT_SHA" "$MMDC_PATH"
node scripts/architecture-diagrams/smoke.mjs "$SITE/architecture" "$PLAYWRIGHT_CORE_PACKAGE_DIR"
```

生成物は `$SITE/architecture/` の `index.html`、`atlas.js`、`atlas.css`、`manifest.json`、`likec4/` の bundle とライセンス、`svg/` の Mermaid 出力。
ブラウザースモークは公開物の外に画像を保存し、LikeC4 と Mermaid の描画、検索、キーボード操作、拡大、再読込、Graphify データ欠損時の表示を確認する。
PR では統合サイトを `repository-audit-preview` に保存する。

一つでも Mermaid の構文エラー、SVG 生成失敗、未読込、実ブラウザーエラーがあれば、Pages 成果物を成功として公開しない。PR プレビュー成功は main への統合や本番運用を示さない。
