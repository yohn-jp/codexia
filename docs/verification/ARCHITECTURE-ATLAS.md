# Architecture Atlas — グラフィカルな設計図

**種別: ビューアーの検証・運用手順。** 設計上の正本は [システム設計](../architecture/SYSTEM-DESIGN.md)、[利用画面](../design/USER-SCREEN-FLOW.md)、[管理画面](../design/ADMIN-SCREEN-FLOW.md)、[初期デプロイ](../deployment/INITIAL-DEPLOYMENT-FLOW.md)、[更新](../deployment/UPDATE-FLOW.md) の Mermaid コードブロックと、それらが参照する領域設計書にある。Atlas に別の図の正本は設けない。

[Architecture Atlas（公開版）](https://yohn-jp.github.io/codexia/architecture/) は Repository Audit Pages に同梱する読み取り専用の SVG ビューアーで、14 のシステム・状態・画面遷移図を表示する。左側のカテゴリから図を切替え、拡大・縮小・元の設計書への移動・SVG 単体表示ができる。個別の図は `#user-1`、`#admin-1`、`#first-1`、`#update-1` などの hash で直接開ける。

## 生成・権限

- `scripts/architecture-diagrams/pack.mjs` が承認済みの6設計書から `mermaid` フェンスを抽出する。順序とタイトルは元の見出しに従う。対象文書を増やすときは所有設計書を明示してインベントリを更新する。
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

成功時、`$SITE/architecture/` に `index.html`、`atlas.js`、`atlas.css`、`manifest.json`、SVG 群とブラウザースモーク撮影 `preview.png` を出力する。PR では repository-audit-preview artifact に保存し、main だけを GitHub Pages に公開する。**設計書の Mermaid が GitHub で表示可能なこととは別に、生成済み SVG の実表示と操作を検証する。**

一つでも Mermaid の構文エラー、SVG 生成失敗、未読込、実ブラウザーエラーがあれば、Pages 成果物を成功として公開しない。PR プレビュー成功は main への統合や本番運用を示さない。
