# iOSネイティブ執筆・読書の設計

**種別: 採用済みSwiftUI目標・実装未検証。iOS開発と自動Xcode検証は一時停止中。** このパスは既存リンクのため維持するが、Mobile Web/PWAの継続サポートを意味しない。実装設計の正本は [iOS SwiftUI architecture](../architecture/IOS-SWIFTUI-ARCHITECTURE.md)、作者の体験・遷移・保存は [UX contract](UX-CONTRACT.md) と [User flow](USER-SCREEN-FLOW.md) が所有する。

## 製品境界

- DesktopはReact/CodeMirror、iOSはSwiftUI + UIKit UITextView/TextKit 2の原稿編集面。両者のUIコンポーネント、画面遷移、クライアント状態を共有しない。
- iOSはLibrary、Outline、Writing/Reading、Knowledge、Review、History、Settingsをネイティブ画面とsheetで構成する。Ionic、Capacitor、WebView内CodeMirror、/mobile/?view=... は旧実装であり正式製品の対象ではない。
- 共通化するのはauthor/project/document/revision、サーバーのAPI認可、保存receipt、競合・回復の意味論だけ。iOSに独立Core/DBを置かない。

## 操作と原稿保護

| 操作 | iOSで保証すること |
| --- | --- |
| 日本語入力・再変換 | marked text、選択、caret、undo、scrollをTextKit編集面で維持。SwiftUI再描画で未確定文字を壊さない |
| 参照sheet開閉 | 原稿の編集面・下書き・undoを維持。別文書へ遷移する前にlocal draft保護guardを実行 |
| 保存 | 端末保護draft、要求送信、結果不明、競合、PostgreSQL receipt確定を区別し、後続入力を旧成功に含めない |
| 背景・強制終了 | OS終了前に送信が完了する前提を置かず、native journalから復旧可能にする |
| 読書・組版 | Markdownの表示変更と本文書込を分離。TextKit 2採用のみでは縦書き・ルビ品質を証明しない |

Dynamic Type、VoiceOver、safe area、ソフト/ハードキーボード、native back、IME、長文・長い構成名を実機で検証する。競合・応答喪失・401/403/409/412・force quitを実APIと隔離DBで確認する。

**Mobile Reactの320/375/390/430 CSS px、Ionic sheet、WebKitモバイルエミュレーションは製品受入対象外。** Mobile Webのroute、authoring shell、専用依存と実装テストは撤去済みとする。Desktop、コンソール、公開リーダーの狭幅検証は継続する。native iOSの未完了実装・実機受入を設計だけで完了扱いしない。
