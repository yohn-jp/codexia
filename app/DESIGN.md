---
version: alpha
name: Codexia
description: Owner-confirmed visual design targets for Desktop and Mobile Web/PWA, including the Capacitor iOS wrapper that displays the Mobile Web UI.
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

<!-- impeccable:design-map -->
Map: PRODUCT.md
Full: .impeccable/design-full.md (expanded rationale and requirements; read sections as needed)

## Overview

**静かで文学的、明晰。** Writingは本文優先。他作業は情報密度と効率を高め、視認性・発見性・accessibilityを保つ。

Desktop・Mobile Web/PWAとCapacitor Mobile Web UI（`web`）。shell別、意味token共通。native UI対象外。

本書の値は目標で実装証拠ではない。[詳細](.impeccable/design-full.md)。UX/a11yは[UX contract](../docs/design/UX-CONTRACT.md)、過去案は[Visual history](../docs/design/VISUAL-SYSTEM.md)、製品目的は[Product](PRODUCT.md)。

## Colors

YAMLの3テーマを共有。surface/status等は未決定。色変更時に再計算（文字4.5:1、操作表示3:1以上）。色だけで伝えず、飾り線を操作境界にしない。

## Typography

UIは和文sans。原稿は明朝／ゴシック選択可（16px・1.8・最大960px）、狭幅に適応。

## Layout

WritingはQuiet Page。他作業は必要面だけ（常時3面にしない）。狭幅はタブ等へ適応。余白共通、touch target 44×44 CSS px。幅だけでshellを変えない。

## Elevation & Depth

階層はトーン・境界・余白で示し、操作境界を飾り線から分ける。影は浮上面だけ。

## Components

選択・状態は色以外でも示す。保存・復旧はUX contract準拠。Focusは**3px solid outline、2px offset**、3:1以上、隠さない。

## Do's and Don'ts

- Do: Quiet Page、作業密度、両shellの意味tokenを保つ。
- Don't: dashboard化・過剰装飾・a11y/原稿保護の弱化・未決定値の補完。CSS・画像は証拠ではない。
