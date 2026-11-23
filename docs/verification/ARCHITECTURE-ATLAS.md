# Architecture Atlas — グラフィカルな設計図

**種別: ビューアーの検証・運用手順。** 設計上の正本は [画面状態遷移図](../design/SCREEN-STATE-ATLAS.md)、[全画面操作台帳](../design/SCREEN-CONTROL-CATALOG.md)、[URL/API認可](../architecture/ROUTE-AUTHORIZATION-CONTRACT.md)、[システム設計](../architecture/SYSTEM-DESIGN.md)、[利用画面](../design/USER-SCREEN-FLOW.md)、[管理画面](../design/ADMIN-SCREEN-FLOW.md)、[初期デプロイ](../deployment/INITIAL-DEPLOYMENT-FLOW.md)、[更新](../deployment/UPDATE-FLOW.md) の Mermaid コードブロックと、それらが参照する領域設計書にある。Atlas に別の図の正本は設けない。

[Architecture Atlas（公開版）](https://yohn-jp.github.io/codexia/architecture/) は Repository Audit Pages に同梱する読み取り専用の SVG ビューアーで、原本に登録されたシステム・状態・画面遷移図すべてを表示する。詳細画面の全図を含む表示件数はビルド時のmanifestから取得し、文書更新に伴う追加にも対応する。左側のカテゴリから図を切替え、拡大・縮小・元の設計書への移動・SVG 単体表示ができる。初回所有者のウィザードとコンソールの遷移は`#admin-4`・`#admin-5`、VM再構築は`#first-3`で直接参照できる。個別の図は `#user-1`、`#admin-1`、`#first-1`、`#update-1` などの hash で直接開ける。

図はカテゴリと検索語で絞り込める。
画面 ID に対応する操作台帳がある場合は、実装と設計目標の記載を SHA 固定の表の行と共に表示する。
関連実装ファイルへの Code Map リンクは、同じ SHA の索引に対象パスがある場合に表示する。
版不一致、索引外、確認できない状態はビューアー上で確認できる。

## 生成・権限

- `scripts/architecture-diagrams/pack.mjs` が承認済みの7設計書から `mermaid` フェンスを抽出する。順序とタイトルは元の見出しに従う。対象文書を増やすときは所有設計書を明示してインベントリを更新する。
- `Repository Audit Pages` の PR プレビュー／main 公開の既存一経路だけを使用する。別の Pages publisher、アカウント、Secret、アプリのデプロイ経路を増やさない。
- `@mermaid-js/mermaid-cli` の固定バージョンが、CI の Chrome 上で全図を描画し、SVG でない・空・過大な結果を拒否する。ブラウザーの描画/ナビゲーション/ズームを Playwright で実測する。ブラウザーは Mermaid ライブラリを CDN から読み込まず、公開済み SVG を画像として表示する。
- `manifest.json` は exact source SHA、元 Markdown の path/line、出力 SVG の path を束縛し、GitHub ソースへのリンクをその SHA に固定する。ビルド済み SVG と、原文 Markdown が衝突した場合は**原文 Markdown と設計の決定が優先**する。図だけを手編集しない。
- 公開ビューアーには API credential、認証 Cookie、MCP や管理 VM への操作権限は不要。Viewer の CSP は自己ホストの script/style/image/manifest のみを許す。

## 検証

ローカルの静的契約:
```sh
node --test scripts/architecture-diagrams/pack.test.mjs
```

GitHub Actions は固定 Mermaid CLI と Chrome を一時領域へ準備して、次を実行する:
```sh
node scripts/architecture-diagrams/pack.mjs "$SITE" "$COMMIT_SHA" "$MMDC_PATH"
node scripts/architecture-diagrams/smoke.mjs "$SITE/architecture" "$PLAYWRIGHT_CORE_PACKAGE_DIR"
```

生成物は `$SITE/architecture/` の `index.html`、`atlas.js`、`atlas.css`、`manifest.json` と SVG 群。
ブラウザースモークは公開物の外に画像を保存し、生成済み SVG の描画、検索、キーボード操作、拡大、再読込、Graphify データ欠損時の表示を確認する。
PR では統合サイトを `repository-audit-preview` に保存する。

一つでも Mermaid の構文エラー、SVG 生成失敗、未読込、実ブラウザーエラーがあれば、Pages 成果物を成功として公開しない。PR プレビュー成功は main への統合や本番運用を示さない。
