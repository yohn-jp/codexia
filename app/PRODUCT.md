# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is an individual author writing Japanese-language novels. They manage works, volumes, chapters, and scenes while writing, revising, reading, consulting references, and reviewing changes.

## Product Purpose

日本語の小説を書く作者が、作品・章・シーンを体系的に管理しながら、執筆・推敲・資料参照・レビューを一つの環境で行い、創作の文脈を途切れさせずに作品を完成へ導けること。

## Positioning

Codexia is a manuscript-centered writing environment whose documented mechanism is PostgreSQL as the sole manuscript authority. Its core value is helping authors keep creative context while moving among writing, revision, reference, reading, and review. It is not a Git client or a generic project-management dashboard.

## Operating Context

- The product covers Desktop and Mobile Web/PWA, plus a Capacitor iOS client that reuses the Mobile shell.
- The owner wants one design system to cover Desktop/Mobile Web/PWA and a Capacitor iOS wrapper that displays the Mobile Web UI. Impeccable platform is `web`; a website or web UI in a native wrapper remains web, and this does not claim native iOS UI or Android support.
- Writing, reading, reference, and review are ways to work with the same manuscript context, not separate manuscript authorities.

## Capabilities and Constraints

- Manuscripts are organized as works with volume, chapter, and scene structure.
- PostgreSQL is the sole manuscript authority. Git persistence, synchronization, history, and compatibility fallbacks are retired.
- Desktop and Mobile have distinct presentation and interaction shells. Authoring, durability, recovery, and authorization responsibilities remain shared at their established boundaries.
- Search, analysis, and assistant tools are optional; local writing must not depend on their availability. Sending manuscript content to an external assistant requires explicit consent.
- Preserve Japanese text entry and composition, reading position, manuscript formatting, and safe recovery across navigation and platform surfaces.

## Brand Commitments

The product name is Codexia. The accepted brand icon is an **open leather-bound manuscript with a rising quill**. Its design must remain recognizable at browser-favicon sizes, use deliberately simplified optical masters at small sizes, and remain available in light/dark and single-color variants. The [visual design system](DESIGN.md) owns the icon's intended appearance and accessibility constraints; the [icon generator](../scripts/branding/README.md) is an implementation, not a competing design authority. Unapproved brand voice, native icons and other identity assets are not implied by this decision.

## Evidence on Hand

- [Canonical system design](../docs/architecture/SYSTEM-DESIGN.md) and [documentation authority](../docs/architecture/DOCUMENTATION-AUTHORITY.md) define the system's design-first source of truth, distinct from implementation.
- [User screen transitions](../docs/design/USER-SCREEN-FLOW.md) and [owner security transitions](../docs/design/ADMIN-SCREEN-FLOW.md) define screen flow contracts.
- [Design and UX contract](../docs/design/UX-CONTRACT.md) defines the author experience and acceptance targets; it is not a report that every target is implemented or accepted in production.
- [Codexia design system](DESIGN.md) records owner-confirmed visual direction and separates unresolved details from adopted decisions.
- [Visual system history](../docs/design/VISUAL-SYSTEM.md) preserves existing proposals and comparisons; its earlier choices are not automatically current specifications.
- [UI redesign acceptance record](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/acceptance.md) documents synthetic manuscript fixtures and the initial redesign capture. It notes that screenshots predate later review fixes, so they are not current rendered-state proof. No real user manuscript was used for those captures.

## Product Principles

- Keep the author's current manuscript and creative context at the center of work.
- Show manuscript protection and recovery truthfully; never imply a save or recovery that has not been confirmed.
- Let authors move among writing, reading, references, and review without losing their place or editing context.
- Keep Desktop and Mobile suited to their distinct interaction contexts while preserving the same manuscript and authorization boundaries.
- Keep optional analysis and external assistance from becoming prerequisites for writing.

## Accessibility & Inclusion

Use WCAG 2.2 A/AA as the applicable baseline. Support Japanese composition and ruby text, 200% text enlargement, and 320 CSS-pixel reflow where applicable. A 44×44 CSS-pixel target is the product goal for primary touch actions, above the WCAG AA minimum.
