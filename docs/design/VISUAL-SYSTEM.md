# Codexia — Visual system

## 位置付けと選択した方向

[UX contract](UX-CONTRACT.md) を具体化する視覚設計提案。原稿の内容、構成と関連知識が製品の個性を生む。写真、装飾的なグラデーション、ダッシュボード風の均等なカードによる演出を基準にしない。既存テーマと日本語組版を維持する。

この再設計では二つの大きく異なる実画面案を比較した。[Folio Atlas](../../evidence/ui-redesign-v2/direction-folio.png) は左に章の索引、中央にfolio、右に引用とKnowledgeを並べ、文脈の見比べを優先する。[Quiet Page](../../evidence/ui-redesign-v2/direction-focus.png) は本文を一続きの面として広く取り、章の索引だけを細く添え、参照は明示操作で呼び出す。構成と引用の同時比較にはFolio Atlasが向く。継続執筆の視覚的な重心、日本語の行長、モバイルへの連続した展開ではQuiet Pageが優れたため、**Quiet Pageを標準Writingとして採用する。**

Quiet Pageでは、DesktopのWriting初期配置を構成20%・原稿80%とし、Knowledge／Evidenceのinspectorは隠してWorkspaceから呼び出す。Researchは原稿と補助panelのsplit、Reviewは原稿と提案レビューを並べる。Mobileは別のIonic画面とし、文書名・簡潔な保存表示・原稿・参照dock・4項目のbottom navigationで構成する。settingsへはtitle barから進む。ユーザーが保存したWorkspace配置は自動的に置換しない。

選択の基準は色の好みではない。縮小表示で本文が第一に見えるか、日本語の長文を実際に読めるか、構成・Knowledge・差分へ戻れるか、DesktopとMobileがそれぞれの操作方法に合うかで比較する。紙の質感や大きなロゴ、装飾的な影を主役にせず、原稿そのものと静かな見出し階層を視覚面にする。

実装した全画面、Before / after、操作・accessibility・persistence・performanceの別評価は[視覚受入記録](../../evidence/ui-redesign-v2/acceptance.md)にまとめた。以前の画面は[Desktop](../../evidence/ui-redesign-v2/before-desktop.png)と[Mobile](../../evidence/ui-redesign-v2/before-mobile.png)、採用後は[Writing](../../evidence/ui-redesign-v2/after-desktop-writing.png)、[Research](../../evidence/ui-redesign-v2/after-desktop-research.png)、[Review](../../evidence/ui-redesign-v2/after-desktop-review.png)、[Mobile Writing](../../evidence/ui-redesign-v2/after-mobile-writing.png)を参照する。MobileのBeforeは同じorigin/mainから390×844 CSS pxで撮影した。

## 基礎トークンの責務

既存 `app/styles.css` の `--page-bg`、`--paper`、`--ink`、`--muted`、`--line`、`--accent`、`--focus-ring`、`--surface-selected`、`--error`、`--success`、diff用変数を第一の基準とする。既存のeditorial.css等にある `--st-canvas`、`--st-folio`、`--st-rail` は必要な見た目の役割に対応付け、同じ意味の色を各Shellに重複定義しない。新しいUIライブラリや独立テーマパッケージは要件ではない。

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
- Menu／Tabs／Dialog：既存Radix、MobileではIonic、単純な入力はnative。ARIA、focus、Esc、戻り先を既存primitiveに委ねる。アイコンの意味はアクセシブルな名前で示す。
- Row：名前が最優先、補助情報・状態は近接配置。選択行とhoverを区別し、行全体の選択と行内の破壊的操作が誤作動しない。
- Field：ラベル、必須条件、エラー、入力保持、決定操作を明確にする。常時開いた作成フォームを一覧の上に積まない。
- State：保存・接続・提案は [操作と復旧](INTERACTION-CONTRACT.md) の語彙に従う。状態の変化をaria-liveで適切に伝え、同じ内容を複数箇所から読み上げない。
- Empty／Error：空、選択なし、未導入、取得失敗、権限拒否、復旧判断を区別する。関連する次の行動を一つか少数示す。機能をまだ持たない場合は実在しない有効ボタンを出さない。

技術用語・UUID・JSONをすべて削除するのではなく、技術詳細へ移す。変更提案の操作型やreceiptは展開可能な形で残す。

## Motion

参照パネル開閉、sheet、選択移動のような空間的な変化にのみ短いtransition（目安120–180ms、既存Ionicのsheet animationはnative設定を使用）を使う。保存や取得待ちで擬似progressを作らない。動きが中断されても最終の権威ある状態とfocusが一致し、reduced motionでは同じ操作結果を即時表示する。本文位置やeditorの高さを保存通知で変化させない。大きなhover変形、スクロール連動装飾、連続するカード登場animationを標準にしない。

## 視覚受入

実レンダリングで以下を確認する。代表原稿は公開可能な架空fixture（日本語長文、括弧、ルビ、数字、欧文、長い章名）とし、実際の作品データをスクリーンショットに使わない。原寸、25%程度の縮小、グレースケールで主要対象が判別できること、ライト／ダーク／Paperで本文・状態・focusが読めること、1440×900・1024×768 Desktopおよび390×844・320px Mobileで主要操作に到達できることを観測する。比較画面は本質的に必要な二次元表示を許容するが、通常本文の無用な横スクロールを避ける。

実際のブラウザでの見た目、操作連続性、製品契約の3ゲートを分け、成功したビルドやデザイン文書から画面品質を推定しない。CSPや認証・保存要件の緩和によって視覚を実現しない。
