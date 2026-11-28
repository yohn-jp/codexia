---
version: alpha
name: Codexia
description: Owner-confirmed visual design targets for Desktop React Web only; native iOS SwiftUI is specified separately.
colors:
  light:
    accent: "#70452F"
    on-accent: "#FFFEFA"
    secondary-text: "#6D675E"
    interaction-boundary: "#8D8375"
    selected-boundary: "#7F5B3F"
    focus: "#70452F"
  dark:
    accent: "#7DAF9F"
    on-accent: "#08120F"
    secondary-text: "#93A0AE"
    interaction-boundary: "#687583"
    selected-boundary: "#7DAF9F"
    focus: "#7DAF9F"
  paper:
    accent: "#3D3429"
    on-accent: "#FFFFFF"
    secondary-text: "#605B53"
    interaction-boundary: "#817462"
    selected-boundary: "#75644F"
    focus: "#3D3429"
typography:
  manuscript:
    fontSize: 16px
    lineHeight: 1.8
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
---

# Codexia — Design system

The [normative UX contract](../docs/design/UX-CONTRACT.sdoc), [user screen flows](../docs/design/USER-SCREEN-FLOW.sdoc) and [owner security flows](../docs/design/ADMIN-SCREEN-FLOW.sdoc) define behavior and transitions; visual styling does not override them.

<!-- impeccable:design-map -->
Map: PRODUCT.md
Full: .impeccable/design-full.md (expanded rationale and requirements; read sections as needed)

## Overview

**静かで文学的、明晰。** Writingは本文優先。他作業は情報密度と効率を高め、視認性・発見性・accessibilityを保つ。

**対象はWindows Chromium（Chrome/Edge）のDesktop React Webのみ**（Impeccable platform: `web`）。Mobile Web/PWA・Capacitor authoring UIは採用目標から除外。iOSは独立したSwiftUI設計であり、本WebデザイントークンやReact部品の共通化を要求しない。詳細は[iOS SwiftUI設計](../docs/architecture/IOS-SWIFTUI-ARCHITECTURE.sdoc)。

本書の値は目標で実装証拠ではない。[詳細](.impeccable/design-full.md)。UX/a11yは[UX contract](../docs/design/UX-CONTRACT.sdoc)、過去案は[Visual history](../docs/design/VISUAL-SYSTEM.sdoc)、製品目的は[Product](PRODUCT.md)。

## Colors

Desktop WebでYAMLの3テーマを使用する。surface/status等は未決定。色変更時に再計算（文字4.5:1、操作表示3:1以上）。色だけで伝えず、飾り線を操作境界にしない。iOSネイティブ側の値は独立設計で定める。

## Typography

UIは和文sans。原稿は明朝／ゴシック選択可（16px・1.8・最大960px）、狭幅に適応。

## Layout

Desktop WritingはQuiet Page。他作業は必要面だけ（常時3面にしない）。ブラウザーの拡大・リサイズとアクセシビリティを保つが、Mobile React専用レイアウトやモバイルviewportスクリーンショットは本製品の受入対象外。iOSのタッチ目標はネイティブUI契約で検証する。

## Elevation & Depth

階層はトーン・境界・余白で示し、操作境界を飾り線から分ける。影は浮上面だけ。

## Components

選択・状態は色以外でも示す。保存・復旧はUX contract準拠。Focusは**3px solid outline、2px offset**、3:1以上、隠さない。

## CSS implementation

Desktop Reactの静的スタイルは [採用技術契約](../docs/architecture/DEPENDENCY-POLICY.sdoc) のvanilla-extractを正本とする。既存CSSの段階移行中も恒久的な二重定義を増やさない。

- 色・余白・文字・状態など共有される意味は既存の型付きsemantic tokenで管理し、同じ設計知識を部品ごとに再定義しない。意味の異なる偶然同じ値は無理に共通化しない。未決定の見た目をlintの都合で確定しない。
- 局所的な静的スタイルは `style`、意味のある離散的なvariantsは `recipe` を用いる。共有部品のスタイルを再利用する。グローバルなテーマ・基礎スタイル・外部ライブラリの契約等、局所クラスで表現できない境界にのみ `globalStyle` を使う。既存セレクター互換のための移行時の利用は共通化の対象とし、恒久的な拡張先にしない。
- 静的なJSXインラインスタイルは局所スタイルへ移す。作者の組版設定、実測したパネル幅など実行時にしか決まらない値は、型付きCSS変数または必要な動的スタイルで扱う。CSPを緩和しない。
- Modern Web GuidanceのCSS・アクセシビリティ指針を使用する。原稿の縦書きとリサイズを踏まえ、意図に合う論理プロパティ、局所スコープ、低い詳細度、ブラウザー標準のセレクターを優先する。例外は意味・互換性に基づき、ライブラリ提供の内部セレクターやリセットを無条件に禁止しない。
- 静的に強制できる規約は [Biome品質ゲート](https://yohn-jp.github.io/codexia/requirements/html/docs/architecture/DEPENDENCY-POLICY.sdoc.html#DOC-ARCHITECTURE-DEPENDENCY-POLICY-biome品質ゲートの正本) で扱う。型付きスタイルの参照はTypeScript、テーマ・表示・操作・性能は実ブラウザー検証でも確認する。ソース行数の削減そのものを目的にしない。

## Brand icon

The approved Codexia mark represents an **open leather-bound manuscript and a rising writing quill**. It must read as literature and writing even at a 16px favicon size; tiny versions shall retain only strong, aligned book and quill silhouettes instead of shrinking ornamental detail indiscriminately. Use separately optically adjusted masters for 16px, 24px, 32–40px, 41–96px, and 97px-and-above presentations. Small sizes require intentional pixel-grid placement, while larger variants can restore paper, binding and feather details. Maintain light, dark and single-color palettes and usable contrast. The icon does not replace accessible text or convey state by color alone.

The [SVG implementation and regeneration procedure](../docs/design/BRAND-ICON.sdoc) must conform to this visual contract. Native iOS raster asset creation, PWA installation metadata, ICO support and Apple icon packaging require their own build/acceptance work; the accepted visual design is not evidence those formats are shipped.

## Do's and Don'ts

- Do: Quiet Page、作業密度、両shellの意味tokenを保つ。
- Don't: dashboard化・過剰装飾・a11y/原稿保護の弱化・未決定値の補完。CSS・画像は証拠ではない。
