# Codexia — Visual system

## 文書の位置付け

本書は既存の視覚設計案、比較、検討履歴を保存する資料であり、現在のビジュアルデザイン正本ではない。現在の正本は [app design system](../../app/DESIGN.md)。UX・操作・アクセシビリティの正本は [UX contract](UX-CONTRACT.md) であり、その契約は維持する。

以下の方向、CSS値、配置例には過去の提案が含まれる。現在の合意と衝突する具体案は採用仕様として扱わず、app design system を優先する。

## オーナー合意の履歴

| 論点 | 現時点の合意 | 未決定 |
| --- | --- | --- |
| 基調 | 静かで文学的、明晰。Writing は Quiet Page、構成・調査・レビューでは Folio Atlas の考え方を作業別に取り入れる | 各作業の実画面で必要な面の細部 |
| Platform | Desktop Web と native SwiftUI iOS は独立した UI 実装とし、API と意味論を共有する | Android 対応はこの合意に含まない |
| 色 | Desktop Webではココア／ティール／墨を基調とし、Light／Dark／Paper の3テーマで色tokenを管理する。Dark accent は `#7DAF9F` | 背景・surface・状態色を含めた実画面でのコントラスト再計算 |
| 日本語組版 | UI は和文 sans、原稿は作者が明朝／ゴシックを選択。原稿の基準は16px、行間1.8、最大幅960px | 画面幅に応じた実表示は可読性とともに比較する |
| 密度 | Writing はQuiet Page。Research／Structure／Review は作業ごとに必要な面を組み合わせ、常時3面を要求しない | 個々の作業での配置・密度 |
| 面の分離 | 共通余白4／8／12／16／24／32px。背景トーン、境界、ラベル、余白で階層化。影はシート等の浮上面に限定 | 実画面で操作境界が十分に判別できるか確認する |
| Accessibility | 既存UX contractを変更せず、主要タッチ目標44×44 CSS pxを維持 | なし。既存の適用要件を満たす |

色方向を比較した時点の参照値は以下のとおり。アクセント上の文字コントラストは候補比較用の計算値であり、palette全体のアクセシビリティ検証ではない。

| 比較候補 | Light accent / 文字 | Dark accent / 文字 | Paper accent / 文字 | accent 上の文字コントラスト |
| --- | --- | --- | --- | --- |
| Desktop由来：ココア／ティール／墨 | #70452F / #FFFEFA | #4FC3B0 / #08120F | #3D3429 / #FFFFFF | 8.06:1 / 8.85:1 / 12.20:1 |
| Mobile由来：オリーブ／セージ／石色 | #5B6F56 / #FFFEFA | #A8C39E / #08120F | #695D46 / #FFFFFF | 5.40:1 / 9.93:1 / 6.45:1 |

Mobile由来の補助文字 #72766D と #FBFAF6 は4.44:1。過去の候補比較で、既存の薄い境界色は面に対して約1.3–1.6:1、MobileのLight／Paper選択境界は約2.1:1だった。これらは装飾線と操作・選択状態の境界を分けて評価する必要を示す観察値であり、最終色の決定ではない。

## 第4ラウンドで採用した共通色token

下記の色値はオーナー合意済みであり、Desktopの意味tokenとする。計算には現行 Desktop CSS の面色を比較背景として使った。背景色や状態色を変えた場合は、Desktopの実際の隣接色でコントラストを再計算する。

| テーマ | 補助文字 | 操作境界 | 選択境界 | focus | 最小コントラスト |
| --- | --- | --- | --- | --- | --- |
| Light | #6D675E | #8D8375 | #7F5B3F | #70452F | 文字4.84:1、操作境界3.22:1、選択境界4.22:1、focus5.67:1 |
| Dark | #93A0AE | #687583 | #7DAF9F | #7DAF9F | 文字6.81:1、操作境界3.85:1、選択境界4.90:1、focus4.90:1 |
| Paper | #605B53 | #817462 | #75644F | #3D3429 | 文字5.66:1、操作境界3.83:1、選択境界3.88:1、focus8.33:1 |

Light のアクセント／on-accent は #70452F／#FFFEFA（8.06:1）、Dark は #7DAF9F／#08120F（7.71:1）、Paper は #3D3429／#FFFFFF（12.20:1）。Focus の共通形状は3px solid outline、2px offset。装飾的な境界は操作境界と別のtoken役割にする。

## 過去の位置付けと選択肢

[UX contract](UX-CONTRACT.md) を具体化する視覚設計提案。原稿の内容、構成と関連知識が製品の個性を生む。写真、装飾的なグラデーション、ダッシュボード風の均等なカードによる演出を基準にしない。既存テーマと日本語組版を維持する。

この再設計では二つの大きく異なる実画面案を比較した。[Folio Atlas](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/direction-folio.png) は左に章の索引、中央にfolio、右に引用とKnowledgeを並べ、文脈の見比べを優先する。[Quiet Page](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/direction-focus.png) は本文を一続きの面として広く取り、章の索引だけを細く添え、参照は明示操作で呼び出す。構成と引用の同時比較にはFolio Atlasが向く。継続執筆の視覚的な重心、日本語の行長、モバイルへの連続した展開ではQuiet Pageが優れたため、**Quiet Pageを標準Writingとして採用する。**

Quiet Pageでは、DesktopのWriting初期配置を構成20%・原稿80%とし、Knowledge／Evidenceのinspectorは隠してWorkspaceから呼び出す。Researchは原稿と補助panelのsplit、Reviewは原稿と提案レビューを並べる。過去のMobile Web/Ionic画面案は比較履歴であり、撤去済みの製品経路を示さない。iOS UIの正本は[SwiftUI architecture](../architecture/IOS-SWIFTUI-ARCHITECTURE.md)である。ユーザーが保存したWorkspace配置は自動的に置換しない。

選択の基準は色の好みではない。縮小表示で本文が第一に見えるか、日本語の長文を実際に読めるか、構成・Knowledge・差分へ戻れるか、Desktopとnative iOSがそれぞれの操作方法に合うかで比較する。紙の質感や大きなロゴ、装飾的な影を主役にせず、原稿そのものと静かな見出し階層を視覚面にする。

実装した全画面、Before / after、操作・accessibility・persistence・performanceの別評価は[視覚受入記録](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/acceptance.md)にまとめた。以前の画面は[Desktop](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/before-desktop.png)と[Mobile](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/before-mobile.png)、採用後は[Writing](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/after-desktop-writing.png)、[Research](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/after-desktop-research.png)、[Review](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/after-desktop-review.png)、[Mobile Writing](https://github.com/yohn-jp/codexia/blob/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence/ui-redesign-v2/after-mobile-writing.png)を参照する。MobileのBeforeは同じorigin/mainから390×844 CSS pxで撮影した。

## 当時の基礎トークン案（検討資料）

`app/src/theme-tokens.ts` の `themeTokens` から生成する semantic token（`--page-bg`、`--paper`、`--ink`、`--muted`、`--line`、`--accent`、`--focus-ring`、`--surface-selected`、`--error`、`--success`、diff用変数）を第一の基準とする。`editorialShellTokens` と `writingShellTokens` が定義する値から `shell-theme.css.ts` で `--st-canvas`、`--st-folio`、`--st-rail` を生成し、同じ意味の色を各Shellに重複定義しない。`theme.css.ts` と `shell-theme.css.ts` はこのtoken mapから静的CSSを生成し、別のテーマ値を持たない。

| 意味 | 初期の視覚方向 |
| --- | --- |
| canvas | 静かな暖色寄りの中立色。Darkでは冷たすぎない暗色 |
| manuscript surface | canvasと区別できる読みやすい面。過剰な外枠・影を置かない |
| navigation surface | 本文より控えめな面。選択状態は背景・細い境界・ラベルで示す |
| accent | インクに近い低彩度の強調。主操作・現在位置・focusを統一 |
| text primary / secondary | 長時間読める主文字、十分なコントラストを持つ補助文字 |
| warning / error / success | 真の状態を示す。ブランド色と別扱い。色に加えて文字・アイコン |
| difference | 追加・削除・変更が文字と記号で読める。色だけの意味付けは禁止 |

Light／Dark／Paper（既存 `ThemeMode`）を維持し、既存保存keyを変更しない。色値の最終調整は3テーマの実レンダリングとコントラスト測定によって行う。参考paletteの既存値を使っただけでAA適合とは判定しない。

## 幾何・文字の規則

| 役割 | 推奨基準（CSS px） |
| --- | --- |
| 通常UI文字 | 14、line-height 1.5 |
| 密な一覧・補助ラベル | 12–13、line-height 1.5。不可欠な情報を極小にしない |
| 現在の作品／文書名 | 14–16、medium |
| 原稿タイトル | 24–28、本文と区別し過度に太くしない |
| Knowledge / Review 詳細見出し | 20–24、関連情報が主役 |
| 余白 | 4、8、12、16、24、32を基本にしたリズム |
| 通常Desktop操作 | 32–36程度の操作高さ、狭いアイコンにも明示ラベル |
| Mobile主要操作 | 44×44以上の目標 |
| 角丸 | 小部品4–6、メニュー／sheetは8–12程度。原稿面は抑制 |

本文の既存default 16px、行間1.8、最大幅960pxと、文庫風560px／Web小説風720px／原稿用紙風480pxの各プリセットを保持する。ユーザー設定（fontSize 14–24、lineHeight 1.4–2.4等）は既存 `typography.ts` の範囲を使う。Desktopの原稿は現在のWorkspace幅の中で組版幅を保ち、Mobileは幅とsafe areaに合わせて余白を縮める。UIのfont-sizeやletter-spacingを原稿設定へ流用しない。UI書体は既存システム和文sans、本文は明朝／ゴシックの選択。フォント配布・取得を新たな必須条件にしない。日本語見出し、和欧混植、ルビ、禁則、長いタイトルに対応し、過度なletter-spacingや大文字化を用いない。

## 部品の優先順位と挙動

- Button：主操作は一作業面につき意味のある一つ。通常操作はtext／outline、破壊的操作は確認内で識別。disabledには理由を示す。pending中は二重実行を防ぐが無関係な閲覧を止めない。
- Menu／Tabs／Dialog：Desktop Webでは既存Radix、単純な入力はnative。iOSはSwiftUI native controlを使う。ARIA、focus、Esc、戻り先を既存primitiveに委ねる。アイコンの意味はアクセシブルな名前で示す。
- Row：名前が最優先、補助情報・状態は近接配置。選択行とhoverを区別し、行全体の選択と行内の破壊的操作が誤作動しない。
- Field：ラベル、必須条件、エラー、入力保持、決定操作を明確にする。常時開いた作成フォームを一覧の上に積まない。
- State：保存・接続・提案は [操作と復旧](INTERACTION-CONTRACT.md) の語彙に従う。状態の変化をaria-liveで適切に伝え、同じ内容を複数箇所から読み上げない。
- Empty／Error：空、選択なし、未導入、取得失敗、権限拒否、復旧判断を区別する。関連する次の行動を一つか少数示す。機能をまだ持たない場合は実在しない有効ボタンを出さない。

技術用語・UUID・JSONをすべて削除するのではなく、技術詳細へ移す。変更提案の操作型やreceiptは展開可能な形で残す。

## Motion

参照パネル開閉、sheet、選択移動のような空間的な変化にのみ短いtransition（目安120–180ms、platformのreduced motion設定を守る）を使う。保存や取得待ちで擬似progressを作らない。動きが中断されても最終の権威ある状態とfocusが一致し、reduced motionでは同じ操作結果を即時表示する。本文位置やeditorの高さを保存通知で変化させない。大きなhover変形、スクロール連動装飾、連続するカード登場animationを標準にしない。

## 視覚受入

実レンダリングで以下を確認する。代表原稿は公開可能な架空fixture（日本語長文、括弧、ルビ、数字、欧文、長い章名）とし、実際の作品データをスクリーンショットに使わない。原寸、25%程度の縮小、グレースケールで主要対象が判別できること、ライト／ダーク／Paperで本文・状態・focusが読めること、Desktopの1440×900・1024×768で主要操作に到達できることを確認する。ブラウザーの縮小表示やリサイズ時のアクセシビリティは[UX contract](UX-CONTRACT.md)に従って検証する。比較画面は本質的に必要な二次元表示を許容するが、通常本文の無用な横スクロールを避ける。

実際のブラウザでの見た目、操作連続性、製品契約の3ゲートを分け、成功したビルドやデザイン文書から画面品質を推定しない。CSPや認証・保存要件の緩和によって視覚を実現しない。

## 日本語原稿の読み幅を比較する

広いWebでは本文の行幅だけを変え、本文、章の見出し、操作ラベル、補助情報の間隔と優先順位を揃える。
狭いWebとiPhoneでは画面に収まる幅を使い、表示領域が狭くて2案に差が出ない場合はその条件を記録する。
既定はQuiet Pageの組版とし、作者による調整は既存の組版プリセット、文字サイズ14〜24px、閲覧時の横書き・縦書きを使う。

### 組版見本

作品名を「潮待ち」、章名を「第三章　夜明け前に旧港へ向かう連絡船と灯台守が交わした最後の約束」、シーン名を「帰港」とする。
次の原稿を横書きと縦書きの両方で使う。

```text
　港の時計が23時を打つまで、灯台守は「今日の最終便は欠航か」と尋ねた。
　帳簿の端には|潮待《しおまち》とだけ書かれていた（予備の船は第2桟橋にいる）。
「明日の便で帰る。Signal 7を見たら、東の階段で待っていて」
　答えを待つうちに、古い風見鶏が一度きしみ、閉じた窓の隙間から海の匂いがした。
```

1. Webではゴシック、16px、行高1.8、字間0に揃える。広いWebのWorkspaceで「レイアウト」を開き、原稿パネルを最大化し、開発者ツールで `.pg-editor .cm-content` のインラインスタイルに `max-inline-size: 25em !important` を追加し、次に `38em` に変える。実際の本文幅と折返しを記録する。和欧混植や余白のため、一行の字数は変動する。
2. 各案で「潮待」の読みを確認し、その段落の「予備」を「臨時」に直す。見失った箇所、読み違い、所要時間、好みをそれぞれ記録する。比較順による影響を減らすため、二度目は同程度の長さの別の一節を使い、参加者ごとに順を入れ替える。書体を比べる場合は幅を固定する。
3. 縦書きでは右から左へ段をたどり、括弧の配置と「潮待」の親文字とルビを確認する。「編集へ戻る」を押したら閲覧中の語を再発見するまでを記録する。現行の復帰先は閲覧前に保持した編集位置である。読んだ箇所を編集位置に対応付ける案は、その差が課題に影響するか見てから判断する。

### 端末ごとの評価

| 環境 | 操作と記録 |
| --- | --- |
| Windows Chromiumの広いWeb・狭いWeb | キーボードだけで表示設定と編集復帰を操作する。文字200%で長い章名と操作部を確認する。リフローは通常の横書きで幅320 CSS px相当、横スクロールを必要とする縦組みで高さ256 CSS px相当を確認し、文字拡大とは別に記録する |
| iPhone実機 | Nativeアプリを記録する。旧Mobile Safariの記録は移行期または独立した公開面の契約に限り、Nativeの証拠にしない。標準と最大のアクセシビリティ文字サイズで本文と操作へ到達できるか、VoiceOverの読順とルビ、長押しと参照シート開閉後の復帰を確かめる |
| iPhone実機の日本語IME | 「きょう→今日」の候補確定、次の改行、変換取消を個別に試す。候補確定で移動や検索が起きず、確定と改行が各1回だけ反映されるか、取消後に元の語へ到達できるかを記録する |

記録には物理iPhoneのNativeアプリ、Windows実機のChromium、Linux Chromium CIの代理試験、および必要な移行期・公開面のSafari試験の別を残す。
幅の採否は読み違いと正しい編集復帰を確認して決め、好みだけが割れた場合は現行の既定を維持する。
Dynamic Typeへの追従、VoiceOverの読順、IMEと長押しは、実機の観察が揃った条件から判断する。
