# Codexia — Design system (expanded detail)

> Expanded rationale and requirements for the design-system map in [DESIGN.md](../DESIGN.md). The map and this file preserve the owner-confirmed visual design. The map carries normative tokens and core rules; this file retains the full rationale and constraints.

> **Status:** デザインの方向とLight／Dark／Paperの共通アクセント・補助文字・操作境界・選択境界・focus色はオーナー合意済み。背景・surface・状態色の細部と実画面での最終コントラスト確認は継続中。

## 文書の責務

- [DESIGN.md](../DESIGN.md) is the visual design authority and token map; this file retains its expanded detail.
- [UX contract](../../docs/design/UX-CONTRACT.sdoc) は、UX・操作・体験とアクセシビリティ契約の正本である。適用可能な契約を視覚判断で弱めない。
- [Visual system](../../docs/design/VISUAL-SYSTEM.sdoc) は、既存案、比較、検討履歴を保管する。合意済みのデザイン仕様と異なる過去の提案は、現在の採用仕様として扱わない。
- [Product](../PRODUCT.md) は、対象利用者、製品の目的、プラットフォームを定める。

本書は、合意済みの視覚原則と未決定事項を区別する。CSSの現状やスクリーンショットは検討材料であり、それだけで採用判断とはみなさない。デザイン文書は実装状況や実機受入を証明しない。

## Creative North Star

**静かで文学的、明晰なデザインを基調とする。執筆時は本文への集中を最優先し、構成・調査・レビューでは情報密度と操作効率を高める。過剰な装飾やダッシュボード的な視覚表現は避けるが、情報の視認性、操作の発見可能性、アクセシビリティを犠牲にしない。**

Quiet Page を Writing の基本とする。Folio Atlas の考え方は、構成、調査、レビューで必要な情報を組み合わせる時に使う。原稿と作者の作業文脈を第一にし、視覚的な静けさを、操作や状態を隠す理由にしない。

## プラットフォームとシェル

このImpeccable Webデザインシステムの対象はDesktop React Webのみ。iOSは独立SwiftUI Nativeアプリで、Mobile Web/PWAとCapacitor WebViewによる執筆機能は撤去済み。WebとiOSのReact部品・CSS・デザイントークンの共用は要求しない。Native詳細は[SwiftUI設計](../../docs/architecture/IOS-SWIFTUI-ARCHITECTURE.sdoc)。

Desktop WebとNative iOSは独立UIを持つ。原稿・Revision・保護・認可のCore/API契約は同じだが、画面・操作・クライアント状態のコード共有は不要。Desktop Webのズーム・リサイズには配慮し、React Mobile専用viewport受入は行わない。

## 色とテーマ

### 合意済みの方向

Desktop 由来の **ココア／ティール／墨** を共通paletteの方向とする。Desktop Webで同じセマンティック色の役割を共有し、Light/Dark/Paperを維持する。次表はWebの値でありiOS Nativeには強制しない。

| Theme | Accent / On-accent | Secondary text | Interaction boundary | Selected boundary | Focus |
| --- | --- | --- | --- | --- | --- |
| Light | `#70452F` / `#FFFEFA` | `#6D675E` | `#8D8375` | `#7F5B3F` | `#70452F` |
| Dark | `#7DAF9F` / `#08120F` | `#93A0AE` | `#687583` | `#7DAF9F` | `#7DAF9F` |
| Paper | `#3D3429` / `#FFFFFF` | `#605B53` | `#817462` | `#75644F` | `#3D3429` |

Webの同じ意味tokenを二重化しない。Paper の原稿面とLight canvas等、ここに挙げていない背景・surface・状態色の具体値は本表では新たに決めない。コントラスト値は現行Desktopの面色を比較基準に算出しているため、背景または状態色を変える時はDesktop Webの実際の隣接色で再計算する。

### セマンティックな役割

| 役割 | 用途 |
| --- | --- |
| Canvas | シェル全体の背景 |
| Surface / Subtle surface | 原稿、ナビゲーション、補助情報の面 |
| Text / Secondary text | 本文と補助情報の文字 |
| Accent / On-accent | 主操作や限られた強調、およびその上の文字 |
| Decorative boundary | 面を静かに区切る境界。操作可能性や状態認識には使わない。色値は背景・surface決定後に設定 |
| Interaction boundary | 入力欄、操作面など、操作可能性の認識に必要な境界。上表のtokenを使う |
| Selected surface / Selected boundary | 選択中・現在位置の背景と境界。境界は上表のtokenを使い、色以外の状態手掛かりも保つ |
| Focus | keyboard focus の可視表示。上表のtokenを使う |
| Status | error、warning、success とその文字・記号 |
| Difference | 追加・削除・変更の区別。色だけを意味の手掛かりにしない |

Desktop Web内では同じ役割を同じ意味で使う。装飾的な区切り線と操作・選択状態を示す境界は別の役割とし、薄い区切り線を操作状態の唯一の手掛かりにしない。

### 色値の採用条件と保留

新しい色値を採用するときは、通常文字は背景との比4.5:1以上、操作の識別や状態表示に必要な境界・視覚表示は隣接色との比3:1以上を維持する（[WCAG 2.2 SC 1.4.3](https://www.w3.org/TR/WCAG22/#contrast-minimum)、[SC 1.4.11](https://www.w3.org/TR/WCAG22/#non-text-contrast)）。確認対象にはアクセント上の文字、補助文字、入力・操作境界、選択状態、focus 表示を含める。文字色は実際に載る各背景と照合する。細い境界では計算値ぎりぎりを避ける。色だけで状態や操作を伝えない。背景色や状態色を変えた場合は、影響する全ての前景・背景および隣接色の組み合わせを再計算する。

## 日本語組版

- UI は現行構成どおり和文 sans を使う。
- 原稿は作者が明朝またはゴシックを選べる。
- 原稿の基準値は 16px、行間 1.8、最大幅 960px とする。作者が設定できる現在の組版を維持する。
- 960px は全画面に強制する幅ではない。利用可能な画面幅、shell、作者の組版設定に合わせ、狭い画面でも原稿を読みやすく表示する。
- UI の文字設定と原稿の組版設定を混同しない。日本語、和欧混植、ルビ、長い見出し、文字拡大も UX contract に従って扱う。

## 密度と面の構成

### Writing

Writing は Quiet Page を基調とし、本文と現在の執筆文脈へ視線を集める。構成や参照は必要に応じて呼び出せる。常時表示する道具を増やして本文幅を圧迫しない。

### Research / Structure / Review

作業別に必要な面を組み合わせる。常時「構成・原稿・参照」の3面を並べることは要求しない。比較・整理に必要な情報密度と操作効率を高めながら、原稿の可読幅と各情報の関係を保つ。狭い画面では同じ情報をタブ、ドロワー、シート等へ適応させる。

### 共通のレイアウト原則

余白は 4 / 8 / 12 / 16 / 24 / 32px を共通スケールとする。主要なタッチ操作は 44×44 CSS px 以上を設計目標とする。密度の高い画面でも、この共通基準と UX contract のアクセシビリティ要件を弱めない。

背景のトーン、明確な境界、ラベル、余白で面と情報階層を表現する。影は sheet、dialog、popover など浮上する面に限る。平面の情報領域を、装飾目的で常時浮き上がったカードの集合にしない。

## アクセシビリティと体験契約

アクセシビリティ契約は [UX contract](../../docs/design/UX-CONTRACT.sdoc) をそのまま維持する。WCAG 2.2 A/AA、200%文字拡大、320 CSS px の reflow、keyboard と focus、状態通知、色に依存しない情報伝達など、適用される既存要件を変更しない。44×44 CSS px は主要タッチ操作の製品目標として保つ。

### Focus 表示

- keyboard focus は `:focus-visible` で **3px solid outline、2px offset** を基本形とする。色だけ、または影だけの表示にしない。
- Focus token は隣接色に対して3:1以上を確保し、選択中の背景上でも焦点の輪郭を見分けられること。
- outline をclipせず、固定bar、sheet、画面端に隠さない。focus が移動・復帰した後も表示が明瞭であること。
- Desktop Webでfocus tokenと基本形を使う。Native iOSはSwiftUI固有のfocus/VoiceOverで実機検証する。

コントラストの計算だけで画面適合を宣言しない。最終値の評価は、実際の前景・背景の組み合わせと操作状態を確認し、視認性、focus の発見可能性、文字拡大や狭幅での表示も含める。視覚上の受入と操作・原稿保護の受入は別に扱う。

## 未決定事項

現時点で合意が必要な主要原則は記録済み。次に比較してから決める事項は、主に次のとおり。

- 背景・surface・状態色の実レンダリングを反映した最終コントラスト再計算
- Decorative boundary、warning / error / success、difference 等、上表以外の色値
- 実画面の比較で必要になった個別の面構成や表示密度

これらは比較結果とオーナー合意を得てから更新する。既存画面や過去の提案から推測して埋めない。
