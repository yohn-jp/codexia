# 外部ライブラリの選定・更新規約

**種別: 正本・規範的設計（normative）。** 本書はCodexia全体の外部依存の選定、バージョン管理、既存の独自実装の置換、および受入条件を定義する。[システム基本設計](SYSTEM-DESIGN.md)と[設計書の正本](DOCUMENTATION-AUTHORITY.md)に従う。認証・永続化・UI・CIの個別仕様を上書きしない。

## 1. Library-first 原則

1. **安全性が重要な汎用処理は保守された標準API・ライブラリを優先する。** OAuth/OIDC、ZIP・アーカイブ解析、入力スキーマ、GitHub API、暗号プロトコルなどを独自実装しない。独自実装が必要な場合は、既存製品・標準APIで満たせない要件と、その独自部分が守る不変条件を明示する。
2. **既存の正本・責務を再利用する。** PostgreSQL、Better Auth、`jose`、MCP SDK、IndexedDB回復、Core境界を並列実装で置き換えない。複数ライブラリが同種の目的で必要なときは、対象・実行環境・安全性上の違いを明示する。
3. **パッケージ数の最小化は目的ではない。** セキュリティ検証や複雑なプロトコル実装を数十行の独自コードで代替するより、実績のあるライブラリを選ぶ。一方、単純なNode.js標準APIのラッピングや無関係な汎用フレームワークは追加しない。
4. **製品固有のセキュリティ契約は残す。** ライブラリはプロトコル解析・構文検証を担当できるが、本人・project・scope認可、revision precondition、同一トランザクションでの検証、操作の冪等性、回復可能性を代行しない。
5. **不具合の共通原因を除去する。** CodeQL等の警告に対する広域抑制・正当化コメントの追加より、問題の発生源となる独自実装や危険な操作順序の是正を優先する。ライブラリ導入自体を脆弱性の修正証拠とは扱わない。
6. **根拠を比較して選定する。** 公式仕様、保守状況、セキュリティ修正、ライセンス、ランタイム・TypeScript互換性、依存閉包、既存機能との重複、導入前後の検証可能な挙動を評価する。単なる人気やコード行数は決定要因ではない。

## 2. バージョンとサプライチェーン

**既存の直接依存・現在の宣言値・固定根拠・最新版追従の分類は、[既存依存ライブラリ台帳](DEPENDENCY-INVENTORY.md)で管理する。** 新しいパッケージを追加する場合は選定台帳と既存依存台帳の両方に、用途・依存境界・更新責務を明記する。実際のインストール版はマニフェストとlockfileで確認する。

- **新規導入・更新はnpm等の`latest` dist-tagが指す最新の安定版を原則とする。** `next`、`beta`、canary、nightlyは標準採用しない。古いメジャーを習慣的に保持しない。パッケージ選定時と実装PR作成時に再確認する。
- **マニフェストの指定範囲とlockfileの実版を区別する。** `1.2.3`は直接依存の厳密指定、`^1.2.3`・`~1.2.3`はSemVer範囲であり「最新版」の宣言ではない。`pnpm-lock.yaml`・独立npm lockfileで解決版とintegrityを固定する。新しい直接依存は原則**exact**で採用し、範囲指定を使う場合は理由・更新責務を台帳に記録する。`latest`や`*`を実行時に動的解決せず、更新はマニフェスト・lockfile・設計台帳を同じPRで改訂する。
- 最新安定版が現在のNode.js、ブラウザー、TypeScript、peer依存または既存の設計契約に対応しない場合、**古い版を黙って採用しない**。まず保守された代替製品・標準APIを選ぶ。古い版しか使えない例外は、阻害条件、保持する版・範囲、リスク、解消条件と更新時の検証を設計変更として承認する。
- バージョン範囲の上限や固定メジャーを、検証済みという理由だけで永続的な互換性例外にしない。破壊的更新は動作変更を評価して別PRで対応する。Dependabotは検知・更新PRの入口であり、CIの省略や無検証マージを許可しない。**自動PRが作られても、それが最新版・互換性保証・採用承認を意味しない。** レジストリの`latest`・変更履歴・PR baseからの差分・現行mainへの追従・最終CIをそれぞれ確認する。
- 公開元、ライセンス、メンテナンス・セキュリティポリシー、依存関係、インストール時実行、アーカイブ・通信・秘密情報の取扱いを確認する。`pnpm audit`等とCodeQLは相補的であり、依存パッケージのスキャンで実装上の安全性を保証したとみなさない。
- この文書の具体的な採用基準版は**選定時点の最新安定版を示す初期ベースライン**である。実装時にさらに新しい安定版があればそちらを使用し、選定表を更新する。古い版に戻すための固定上限ではない。
- **更新の可否は「連動更新」「再現された阻害による一時保留」「更新待ち」「削除・再評価」「制約根拠未確認」に区別する。** 依存している実行環境・peer API・型・生成物を切り離して更新しない。古い版が必要な場合は、再現できる阻害・保持範囲・解除条件を当該PRへ、継続的な採用条件を[台帳](DEPENDENCY-INVENTORY.md)へ記録する。
- **非JS依存も対象**とする。SwiftPMのexact、Ansibleの`==`、GitHub Actions、OCIイメージdigest、Node/pnpmおよび複数のlockfileの整合を同様に審査する。

### Pythonパッケージ管理

**Python依存管理の標準は [uv](https://github.com/astral-sh/uv) とする。** 既存のPython実行版・仮想環境・依存宣言・lockfileを正本として維持し、実行時の未固定版解決やハッシュ検証の弱体化を認めない。uv自身も検証済み公式releaseの版と配布SHA-256を固定する。Pythonパッケージを導入する有効なCI・配備コントローラ・バックアップ運用経路は、共通の [`scripts/shared/python-env.sh`](../../scripts/shared/python-env.sh) からuvを使用する。OS管理パッケージやホストの既存Python処理は対象外とし、保護された実機を移行検証のために変更しない。既存のroot権限境界・バックアップのハッシュ固定と再インストール契約を維持する。凍結済みの旧StrictDoc OCI実験は例外として履歴を保持するが、再構築・公開・利用を禁止し、廃止予定とする。CIのキャッシュ採否とStrictDocの実行条件は[CI/CD正本](../verification/CI-CD.md)に従う。

### pnpm Catalog と依存の実行区分

- pnpmワークスペースで複数利用される外部ライブラリの**共通バージョン指定**は `pnpm-workspace.yaml` の `catalogs.production`・`catalogs.development` に集約する。ワークスペース内の `package.json` は `catalog:production`／`catalog:development` を参照する。Catalogは版を管理するための仕組みであり、インストール／配布への採否を決める機構ではない。
- **実行時・本番依存は各ワークスペースの `dependencies`、型・ビルド・テスト専用依存は `devDependencies` が正本**とする。Catalog名とフィールドを必ず対応させる。実行時利用のあるライブラリをキャッシュやバンドルサイズだけを理由にdevへ移動しない。型定義は原則devに保ち、Core/Full OCIの実配布閉包を別途検査する。
- **実行時にマニフェストの依存宣言文字列をバージョン識別として利用する実装は、正規のパッケージメタデータ参照へ移行するまでCatalog化しない。** Catalog参照文字列が製品のAPI出力やモデルIDに混入してはならない。
- 互換範囲が異なるpeer依存は、Catalogへの一律統合で契約を広げたり狭めたりしない。共通の候補がなく単一ワークスペースでしか利用されない依存や、`workspace:`・`file:`等のローカル参照は、必要性が認められる限り宣言元に保持する。
- Catalog・manifest・lockfileは同時更新し、`pnpm install --frozen-lockfile`、workspace型検査、Core/Full実ビルド、API認証とDesktop E2E、OCIの本番依存閉包で整合性を検証する。DependabotのCatalog更新検知を維持し、Catalog導入により検証義務やリリース証拠を省略しない。独立したnpm lockfile（Edge／移行完了までの既存Native）はこのpnpm Catalogの対象外とする。

## Desktop Web技術選定（確定・未実装）

Desktop Reactは **TypeScript 7 + Vite 8 + vanilla-extract** を正本とする。TypeScript 7のnative型検査を必須とし、既知のNode型解決障害を修正する。Vite 8を維持し、Rsbuild/StyleX/Tailwind/Panda/Bootstrapは本移行の採用対象としない。CSSは `@vanilla-extract/css` の型付きテーマ／トークン、`@vanilla-extract/recipes` のvariants、`@vanilla-extract/vite-plugin` のビルド統合を採用する。既存CSSは段階的に置換して不要分を削除し、重複した恒久スタイル正本を設けない。SwiftUI Nativeは独立したフロントエンドである。

これは採用契約であって導入完了の宣言ではない。最新版・peer互換・TS7/Vite8の統合、CSS成果物、テーマ、Desktop E2E、CIは実装PRで検証する。

## 3. 選定済みライブラリ台帳

次の選定は**設計上の採用決定**であり、コードへの依存追加・置換・CI実行が完了したという意味ではない。具体的な実装・CI適合の状態はPRと検証証拠で判定し、この設計台帳へ時系列の進捗を記載しない。

| 用途 | 選定済みパッケージ／初期基準版 | 適用対象／責務 | バージョン・互換性制約 |
| --- | --- | --- | --- |
| ブラウザーOAuthプロトコル | [`oauth4webapi`](https://github.com/panva/oauth4webapi) `3.8.9` | `app/src/oauth.ts`の独自PKCE・Discovery・認可／token応答処理を置換する対象 | v3系の実行環境はWeb Crypto／Fetch APIを要し、Node.js用途では20以上。CodexiaのDesktop Webは対応ブラウザーで検証する |
| 信頼境界を越えるZIP読取 | [`@zip.js/zip.js`](https://gildas-lormeau.github.io/zip.js/) `2.25.0` | `scripts/ci/evidence/download-artifacts.mjs`の独自ZIP構文解析を置換する対象 | CIはNode.js 24系。厳格モード、ストリーミング出力・容量上限、パス／リンク検査が必須 |
| API・MCP・外部データの実行時検証 | [`zod`](https://zod.dev/) `4.6.7` | API、MCP、Assistant等の境界検証の正本。手動検査の統一対象 | Zod 4はTypeScript 5.5以上で検証されている。`strict`設定・Core-only依存閉包を維持 |
| Desktop WebのHTTP契約生成 | [`orval`](https://orval.dev/) `8.49.0` | TypeSpec由来のOpenAPI 3.1からfetch clientとZod DTOを生成するappの開発依存 | 生成器をlockfileで固定し、更新時にOpenAPI照合、決定的な再生成、アプリの型検査と応答検証を確認 |
| GitHub RESTの通信層 | [`@octokit/rest`](https://github.com/octokit/rest.js) `22.0.1` | `scripts/`のGitHub REST呼出し・ページ処理を統一する対象 | Node.js 20以上。既存の証拠同一性検査、許可API、認証情報送信制限は別途必須 |
| 厳格JSON構文と重複キーの検出 | [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser) `3.3.1` | `packages/api/src/oauth-mcp.ts`のJSONキー抽出正規表現の置換対象 | JSONCの許容は**禁止**。コメント、末尾カンマ、構文エラー、同一オブジェクト内の重複キーを拒否 |
| JS/TS品質・フォーマット・import管理 | [`@biomejs/biome`](https://biomejs.dev/) `2.6.8` | リポジトリのLint・Formatter正本、Code ScanningへのSARIF送信 | CLIの安定版。CodeQLと型検査を代替しない。SARIFはLintに限定しFormatterはCIの合否で扱う |
| CLI 対話フォーム | [`charm.land/huh/v2`](https://github.com/charmbracelet/huh) `v2.0.3` | `cmd/codexiactl` の非秘密候補選択・通常入力・非保護の確認 | Go 1.25.8 以上。公式 TTY の明示 I/O、Context、既定値による誤承認防止。組込み accessible mode と秘密入力は使わない |
| CLI 表示・レイアウト | [`charm.land/lipgloss/v2`](https://github.com/charmbracelet/lipgloss) `v2.1.1` | `cmd/codexiactl` の共通 semantic style、工程・診断・結果の表示 | Go 1.26.0 以上。Huh と解決される依存の整合、NO_COLOR・端末幅・機械出力分離を検証 |

### ブラウザーOAuth：`oauth4webapi`を採用

[API認証・認可の正本](API-AUTHN-AUTHZ.md)のBetter Authは認証・OAuthプロバイダー、`jose`はAPI JWT検証の責務を維持する。ブラウザーのOAuth public clientが担うプロトコル処理だけを`oauth4webapi`へ移す。選定理由は、PKCE、Discovery、認可レスポンス、トークン応答を標準実装へ任せつつ、Codexia固有の制約を監査可能な形で明示できるため。

- 保持する制約: PKCE S256、予測困難な`state`、タブ単位・有効期限付きトランザクション、callbackでの`state`・`iss`（RFC 9207）・redirect照合、`resource`（RFC 8707）・API audience、認可サーバーとendpointの厳密な同一オリジン、tokenのメモリ保持、誤応答時のfail-closed。
- 比較対象の[`openid-client`](https://github.com/panva/openid-client) `6.9.1`はプロトコル処理を高レベルに抽象化するが、この用途では既存の個別制約を明示して監査することを優先し、**採用しない**。セキュリティ品質が劣るという判断ではない。
- 現行SwiftUI iOS appは`ASWebAuthenticationSession`とnative transportを使う。Retired AppAuth-iOS/Capacitor auth bridge is removed. iOSのSwift typed clientはWeb Orvalとは別に同じOpenAPIから生成する。Better Authのclient helperはAPIアクセストークン取得契約の置換対象として選ばない。
- 受入: 正常なAuthorization Code + PKCEに加え、state不一致・リプレイ・期限切れ・iss不一致・endpoint変更・不正token type・redirect逸脱・token漏えいが拒否されることをブラウザーで確認する。

### ZIP：`@zip.js/zip.js`を採用

GitHub ArtifactのSHA-256・run ID・source SHA・artifact IDを先に照合する。ZIP解釈はライブラリに移す一方、**アプリケーション側の資源上限とファイル書込み境界は残す**。

- `strictness: "strict"`、`checkOverlappingEntry`、`checkCrc32`、標準のファイル名検証を利用する。エントリ数、圧縮サイズ、各エントリ・全体の展開後実サイズに上限を設け、宣言値を信頼せずストリームで実測する。
- 絶対パス・`..`・特殊ファイル・symlink・ハードリンク・大文字小文字／Unicode正規化で衝突する名前・不正な親ディレクトリを拒否する。出力パスの書込み権限と既存ファイル非上書きを維持し、攻撃者が変更できるディレクトリを使わない。
- ライブラリが対応する形式でも、現在拒否しているZIP64、暗号化ZIP等は**明示的な設計変更がない限り受け入れない**。既存の負ケース・サイズ上限を下げずに保つ。
- EPUB **生成**には既存の`jszip`を維持する。用途・信頼境界が違うため、ZIPパッケージの二重化はこの範囲に限って認める。

### Zod：既存4系を標準として再利用

HTTP body、query、外部API応答、MCP DTO、インポート等の**不信頼データとの境界**では、型アサーションや繰り返しの`typeof`検査よりZodスキーマを優先する。ただし、DB内の整合性、認可、revisionの同時検査、性能上の不変条件をスキーマだけで済ませない。

- スキーマ所有者は対象のAPI・MCP・module境界とする。単一の共有DTOが複数境界で必要なら再利用するが、`packages/contracts`にZodを無条件で入れずCore-only依存閉包を維持する。
- Zodの検証失敗は既定のAPIエラー契約に投影し、不信頼の入力全文やsecretをログ・レスポンスに出さない。

### Octokit：GitHub RESTの通信に限定採用

`@octokit/rest`はエンドポイント呼出し、型、ページネーションの共通実装として使う。ただし、`scripts/ci/evidence/proof-reuse.mjs`等の**許可されたAPIパス、正確なrun／attempt／SHA、証明書、artifact digestの検証はCodexiaの責務**である。

GitHub APIのbearer tokenを署名付きArtifactのリダイレクト先へ転送しない。認証付きの制御プレーンRESTと、検証済みURLからの無認証バイナリ取得は明確に分離する。SDK導入で任意URLへの通信、緩いリトライ、証拠省略を追加しない。

### 厳格JSON：`jsonc-parser` + Zodを採用

`JSON.parse`とZodは入力オブジェクトの**元テキスト中の重複メンバー名**を検出できない。`jsonc-parser`のvisitorで各オブジェクトのキーを構文レベルで走査し、エスケープを含む同名キーを同一スコープ内で拒否する。これはライブラリが自動で重複キーを拒否するという意味ではなく、visitorと検証ロジックの組合せを選ぶ決定である。

`disallowComments: true`、`allowTrailingComma: false`、パーサーのエラー件数ゼロを要求し、受理した値をZodで厳格に検証する。JSONCを設定形式として新設しない。クライアントIDとproject配列の一意性・完全性を維持する。

### Biome：品質ゲートの正本

`@biomejs/biome`をJS/TS系のLint・Formatter・import整理の正本とし、同じ責務のESLint／Prettierや独自フォーマット検査を並行運用しない。`biome ci`を非破壊の必須検査とし、LintのみのSARIFをGitHub Code ScanningへCodeQLと**独立したcategory**で送信する。Formatter違反はCIの合否で扱う。CodeQL、TypeScript、契約テスト、アーキテクチャ検査の責務は変更しない。

**JS/TS/JSXおよび対象となるCSSの静的品質検査はBiomeに一本化する。** 公式の安定ルール・技術ドメイン・設定overrideを優先し、標準機能で表現できない必須の設計制約に限って公式GritQL例または最小限のGritQL pluginを用いる。同じ責務のStylelint、ESLint、独自TypeScript ASTリンターを別基盤として追加しない。SwiftUI、TypeScript型検査、CodeQL、実行時検証、アーキテクチャ検査の責務は独立する。

- ルール選定では正確性、セキュリティ、アクセシビリティ、責務境界、型安全性、保守性を優先する。単なる記述の短縮や個人の好みを強制しない。公式の全安定ルールを試験対象とし、採用技術と一般的なベストプラクティスに合致する標準ルールは原則として全て導入する。既存違反の有無だけで恒久的な不採用にしない。非採用技術の専用ルール、主観的な記法の好み、既存契約と相反する制約は対象外とし、正当な適用範囲を選ぶ。nurseryは既定で採用しない。カスタムルールの導入は標準ルールの選定と分離する。意図的な相反ルールを同時に強制しない。
- 採用する必須ルールはエラーとして非破壊CIで強制する。既存違反の機械的な一括抑制や無関係な全ファイルの整形を避け、修正または適用範囲・理由・解除条件を明示する。必要な例外は最小のルールとスコープに限定する。
- Desktop Webの実装は [Design System](../../app/DESIGN.md) とプロジェクトに固定した [Modern Web Guidance](../../.agents/skills/modern-web-guidance/SKILL.md) を参照する。ガイドの要求のうち静的に判定できるものをBiomeに投影し、実画面・ブラウザー互換性・性能・操作結果は既存検証で確認する。製品のWindows Chromium対象契約を超える互換性要求や新規UI基盤を導入しない。

[CI/CD正本](../verification/CI-CD.md)の必須タスク・証拠・release gateを守り、Lintの成功が欠落・スキップしたセキュリティ検査の代替証拠にならないようにする。

### 今回の確定済み追加採用ターゲット

- **XState v5**：Desktopの保存・復旧、Native ChangeSet review、本人認証管理の一部で `xstate` 5.33.4 と公式React adapter 6.1.0を使用する。React 19の単純なlocal UI stateを全置換しない。状態の意味と適用範囲は [XState状態機械設計](../design/XSTATE-STATE-MACHINE-CONTRACT.md) に従う。追加導入時はv5 stableとReact adapterの整合を確認し、バージョンを変更する場合は宣言・lockfile・[依存台帳](DEPENDENCY-INVENTORY.md)を更新する。
- **S3互換API client**：既存のage暗号化バックアップをoff-VMへ送る**バックアップ専用executor**で維持管理される公式SDK/成熟ライブラリを選ぶ。S3署名/リトライ/TLS/redirectを独自実装しない。AWS S3と互換providerの両方で検査し、具体的パッケージとバージョンを導入PRで確定。詳細は [バックアップ管理契約](BACKUP-CONSOLE-CONTRACT.md)。

### CodexiaCTL terminal UX

Huh v2 + Lip Gloss v2 を採用する。[CLI の対話・表示契約](../deployment/CODEXIACTL.md#22-ターミナル-ux-と対話の責務正本) が UX、TTY、承認・秘密保護の正本である。Huh は型付きの選択・フォーム、明示的な input/output と `RunWithContext` を提供する。Lip Gloss は端末 capability に応じた描画と共通 style を担う。Huh の組込み accessible mode は入力 error/context の伝播を別途検証するまで採用せず、既存の安全な line mode を使う。配備の権限判断、状態遷移、保護承認、秘密の byte-oriented な扱いはライブラリに委譲しない。

比較対象の PTerm は一体型表示に優れるが、対話で `keyboard.Listen` を直接使うため既存の明示 TTY/Context 境界への統合を優先し採用しない。PromptKit は Bubble Tea/Lip Gloss 系の依存を共有する一方、統一フォームと明示 I/O/Context の契約を直接満たす Huh を選ぶ。Bubble Tea 単独の独自 TUI はフォーム・画面状態の再実装を増やすため採用しない。Huh の内部依存として利用する。Cobra、urfave/cli はコマンド数・構文が少ない現行 CLI に対して重複する parser を置換するほどの利益がなく採用しない。

採用対象は `cmd/codexiactl` に限定する。実装 PR では Huh/Lip Gloss の最新安定版、互換性と license/security を再照合し、Go module path と直接依存の版を `go.mod`、module checksum を `go.sum` で管理し、解決された依存閉包を `go list -m all` で確認する。Huh が宣言する Bubble Tea/Bubbles/Lip Gloss の最小版と Go の解決版を区別し、組合せの API・race・vet・CGO 無効 Linux amd64 build、依存スキャン、PTY/SSH の操作を検証する。推移依存を無意味に直接依存へ昇格させず、必要な明示 API import があれば採用根拠を同じ PR に記載する。実装と同時に既存の重複描画を削除し、[依存台帳](DEPENDENCY-INVENTORY.md#codexiactl-の-go-直接依存) に実宣言を反映する。独立した GUI/VM runtime・新しい terminal framework を追加しない。

## 4. 追加採用しないもの

- **追加のOAuthフレームワーク／認証基盤**: 現行のBetter Auth、`jose`、MCP SDKの役割を維持し、ブラウザーのプロトコル処理だけを選定対象にする。AppAuth-iOSはretired Capacitor bridgeとともに削除済みで、SwiftUI appの依存ではない。
- **`fs-extra`、`write-file-atomic`の一括導入**: ライブラリ名だけではTOCTOUは消えない。openした同一ディスクリプタによる検査・利用、ディレクトリの信頼性、権限、fsync・原子的置換の契約を評価する。
- **ORM／第二のDBアクセス正本**: 既存PostgreSQLのトランザクション、マイグレーション台帳、モデル境界を置き換えない。新しいルーティングフレームワークや状態管理基盤も導入しない。
- **一括リトライライブラリ**: OAuthやCI証拠の操作に無条件リトライ・リダイレクト・副作用再実行を追加しない。必要な処理だけ、冪等性を証明して選定する。

## 5. ライブラリ導入時の受入契約

- **機能同等性**: 正常系だけでなく不正入力、競合、障害、期限切れ、キャンセル、タイムアウト、再試行で既存の正本契約を満たす。既存の安全性チェックをライブラリへの期待だけで削除しない。
- **依存境界**: Core-only、サーバー専用、ブラウザー、iOS、CI専用の依存閉包とバンドルを検証する。実装先パッケージにだけ依存を追加し、不要になった独自コードと旧依存を削除する。
- **セキュリティ**: 認証情報の送信先、パスの安全性、展開量、入力サイズ、構造検証、権限、監査ログ秘匿を検証する。既存のCodeQL警告を単に抑制しない。
- **検証と更新**: 正本設計・影響範囲に沿って型検査、ユニット／統合／ブラウザー、実際のGitHub Actions、依存スキャン、CodeQLを実行する。バージョン変更の結果をPRで明示し、未実行項目は未検証と記録する。設計書の採用決定と実装完了を混同しない。

## 参照元

- OAuth protocol: [oauth4webapi](https://github.com/panva/oauth4webapi/blob/main/docs/README.md)、比較対象の[openid-client](https://github.com/panva/openid-client)、[API認証契約](API-AUTHN-AUTHZ.md)
- ZIP: [zip.js untrusted ZIP guidance](https://gildas-lormeau.github.io/zip.js/)、[既存のCI証拠取得](../../scripts/ci/evidence/download-artifacts.mjs)
- Schema: [Zod requirements](https://zod.dev/)、[jsonc-parser visitor/parse options](https://github.com/microsoft/node-jsonc-parser)
- GitHub: [Octokit REST](https://github.com/octokit/rest.js)、[SARIF upload](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file)
- Quality: [Biome CI](https://biomejs.dev/recipes/continuous-integration/)、[Biome SARIF reporter](https://biomejs.dev/reference/reporters/)
