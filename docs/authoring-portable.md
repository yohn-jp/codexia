# 作品データのエクスポート・インポート

Codexiaは、現在の作品を持ち出すためのバージョン付き **codexia-work/v1 JSON** を提供します。Desktopの「作品」パネルにある「作品のエクスポート・インポート」から利用します。これはPostgreSQLの稼働時バックアップや全Revision履歴の復元機能ではありません。

## 対象と安全性

- **含むもの:** 作品名・機密設定を除く作品設定、文書のID/階層/並び順/最新Markdown（Unicode・改行をそのまま保持）、Knowledgeノード/別名/関係、最新Revisionに結び付くEvidenceアンカー/言及/Assertion、作者が保持するモジュールレコード。
- **含まないもの:** 旧Revision全文・原本のRevision日時/作者（ソース側Revision IDはEvidence照合用の参照として含むが、インポート先のRevision IDとして復元しない）、IndexedDBの未保存Draft、承認/適用待ち提案、秘密値、セッション、アクセストークン、公開共有の許可記録、モデルキャッシュ、ホスト履歴、デプロイ設定。
- 現在の文書と一致しないEvidenceアンカーはevidence.unresolvedに原記録と関連リンクを収めます。取り込み時には**根拠がないのに現行Revisionへ紐付け直すことはしません**。取り込み後も専用PostgreSQLモジュールレコードに保持され、再エクスポートで再び出力されます。UIには未解決件数を明示します。
- 除外した秘密/内部モジュールレコードの**名前だけ**をomittedRecordsで報告します。内部authorityの履歴は本文を読み出さず、名前空間ごとに `<moduleId>:*` の1項目へ集約します。秘密値そのものは含めません。作品原稿や一般のモジュール記録は機密情報を含み得るため、JSONは非公開で扱ってください。
- 各エクスポートは**単一のPostgreSQL読み取りスナップショット**から作成します。8 MiBを超える作品、文書/Knowledge等の検証上限に達する作品は、途中までの偽の成果物を返さずエラーにします。インポートHTTP本文の最大値は12 MiBです。

## 取り込みの挙動

codexia-work/v1は**新しい作品のみ作成**します。既存作品の本文やグラフを上書きするAPIはありません。文書・Knowledge・Evidence・モジュールの作成は1つのPostgreSQLトランザクションで行い、途中で失敗するとすべてロールバックします。

入力のスキーマ、IDの一意性、親子関係・循環、関連するノード/アンカーの存在、Evidence引用のSHA-256を検証します。機密キーを含む設定やモジュールレコードは拒否します。旧Revision IDは持ち込まず、インポート先のRevisionへ正しく付け直します。正規化方式で新規インポートした作品は、JSONオブジェクトのキー順だけが異なる同一内容の再送でも同じ作品を返します。旧方式のreceiptはキー順に依存するダイジェストのみを保持し、元のpayloadを保持しません。旧方式で作成された作品の再送を保証するのは、同じ解析後のオブジェクトキー順で元のダイジェストを再現できる場合です。旧方式のファイルをキー順変更後に再送すると、新規作品が作られる場合があります。その後、旧ダイジェストと正規化ダイジェストの双方に一致する作品が存在すると証明できた場合は、どちらかを自動選択せず409 WORK_IMPORT_CONFLICTを返します。既存の作品を自動統合・削除しません。

インポートにはBetter Authで認証された作者の権限が必要です。エクスポートはAPIが作者に許可した作品を対象とします。MCPクライアントはこれらのAPIを利用できません。

## JSON形式

内容を手動で生成する場合にも、通常のエクスポートと同じ形式を使用してください。IDは**小文字UUID**、文書IDは作品内で一意、revisionIdは各文書に固有のソース側識別子とします。本文はmarkdownへそのまま格納します。fromUtf16とtoUtf16は本文のUTF-16単位の位置です。

最小の空作品の例:

    {
      "format": "codexia-work/v1",
      "project": { "title": "作品名", "settings": {} },
      "documents": [],
      "knowledge": { "nodes": [], "aliases": [], "relations": [] },
      "evidence": {
        "anchors": [],
        "mentions": [],
        "assertions": [],
        "assertionEvidence": [],
        "unresolved": { "anchors": [], "mentions": [], "assertionEvidence": [] }
      },
      "moduleRecords": [],
      "omittedRecords": []
    }

文書要素の例:

    {
      "id": "3d3c6a8c-40b5-4fb2-82e5-d798a0ed2d18",
      "parentId": null,
      "kind": "scene",
      "title": "第一場",
      "orderKey": "0001",
      "markdown": "朝の光。\n",
      "revisionId": "64146384-98e9-47d9-aa39-15ba6f6fc7ee"
    }

Knowledgeの各要素は、nodesにid/type/name/attributes/status、aliasesにid/nodeId/surface/normalized/scope/status、relationsにid/sourceId/targetId/type/attributes/validity/statusを指定します。Evidenceはanchorsにid/documentId/revisionId/fromUtf16/toUtf16/quoteSha256/status、mentionsにevidenceId/nodeId/status/source/confidence/extractorVersion、assertionsにid/proposition/modality/perspective/narrativeTime/confidence/status、assertionEvidenceにassertionId/evidenceId/roleを指定します。moduleRecordsはmoduleId/key/valueの配列です。機密・内部authorityレコードは含めないでください。

## HTTP API

- GET /api/v1/persistence/projects/{projectId}/archive: 作品JSONを取得。
- POST /api/v1/persistence/import: JSONを送って新規作品を作成。結果はproject/replayed/unresolvedAnchors/omittedRecords。

APIは認証と作品へのアクセス権限を確認します。ブラウザーのオリジン制限と、Cookieを使う変更操作のCSRF保護が適用されます。作品をインポートする前に、未保存のブラウザーDraftを保護してください。

## 一度限りの旧データ取り込み

旧Scriptorium/Git原稿の形式をCodexiaアプリに恒久実装する必要はありません。**保全した旧データを別作業でこのJSON形式へ変換し、通常のインポート機能を利用**します。元データを読み取り専用で保全し、原稿件数・本文ハッシュ・階層・Knowledge・未解決Evidence・機密除外を確認してから、インポートした新作品を読み戻して照合してください。

運用上の全履歴と真正なバックアップには[PostgreSQLバックアップと復元手順](deployment/README.md)を使います。JSON交換だけを唯一のバックアップにしないでください。

## 離脱用オープンエクスポート契約（REQ-DATA-006）

**種別: 採用済みの規範的設計。実装と実測は未完了。** 本節は作者がCodexiaから離脱する場合の作品データ取得を所有する。対象読者は作者・開発者。上記 `codexia-work/v1` は現行のバージョン付きJSON交換（新規作品へのimportを含む）として区別する。運用DR、SQL/DB dump、ZIP import、専用viewer、EPUB/DOCX出版形式の拡張はこの決定の対象外。運用DRは [Backup](deployment/BACKUP.md)、永続データ境界は [Data model](architecture/DATA-MODEL.md) が所有する。

[離脱用 ZIP の実装契約](architecture/OPEN-WORK-EXPORT-CONTRACT.md) に HTTP、認可、画面および資源管理の詳細を定める。

### 形式と内容

- 作品単位で標準ZIPを一つ取得する。テキストはUTF-8 Markdown（[CommonMark](https://spec.commonmark.org/) を参照し、原文の文字・改行・構文を変換しない）、構造化データは [RFC 8259 JSON](https://www.rfc-editor.org/rfc/rfc8259) と公開 [JSON Schema](https://json-schema.org/) を使用する。Codexia独自の実行環境・プラグイン・DB・ネット接続なしで閲覧、解析、編集できること。
- manifestはバージョン付きの公開パッケージ仕様とし、作品ID、snapshot/version、文書UUID・親子関係・種別・順序・最新Revision・各ファイルパス、収録/除外区分、ファイルごとのbyte size・SHA-256を記述する。manifest自身を循環ハッシュに含めない。Schemaと説明書を同梱し公開する。独自暗号・圧縮フォーマット、必須の専用viewerは採用しない。
- 以下の構成を採用する。順序と階層の厳密な復元はmanifestを使用し、人間には自然な名前と順序で利用できるファイルを提示する。Knowledgeの閲覧用Markdownは構造化JSONの派生表示であり、別の編集正本ではない。

```text
work.zip
  README.md
  manifest.json
  schema.json
  manuscript/              # 現行の文書階層・順序とUTF-8 Markdown本文
  knowledge/
    graph.json              # ノード・別名・関係・属性・状態
    evidence.json           # Evidence・言及・Assertion・対応Revisionと未解決情報
    ... .md                 # 人物・場所・設定等を直接読める派生表示
  history/
    revisions.json          # 文書/Revision ID・親Revision・日時・本文参照
    documents/              # 保持された過去本文・論理削除文書を区別したMarkdown
  metadata/
    project.json            # 非機密の作品設定・文書メタデータ
    module-records.json      # 作者所有の許可されたmodule records
```

- 現行の保存済み本文だけでなく、永続正本に保持されている全過去Revision（本文、ID、親Revision、日時、許可された作者帰属情報）を収録する。論理削除されたが回復可能な文書・Revisionは現行文書と明確に分ける。既に破棄されたデータの復元は要求しない。EvidenceのUTF-16位置、quote hash、参照先Revisionを保持し、不整合や未解決の参照を捏造して解消しない。
- Knowledge、alias、relation、Assertion、Evidence、作者が保持するmodule recordと非機密設定を収録し、作者に許可されたデータと内部authorityを区別する。認証情報、秘密値、session/token、共有許可、運用記録、未承認・適用待ち提案、未保存draft、cache、デプロイ設定を含めない。既存のportable projectionと除外規約を再利用し、新しいデータ種別も明示的な許可・除外を通す。除外理由と対象の安全な識別・件数は記載し、秘密の値や識別子自体を漏らさない。原稿本文等の作者所有データは機密になり得るため、ダウンロード物を非公開として扱う。

### 生成、認可、異常時

- 既存作品パネルのエクスポートから作品を選択し、離脱用ZIPを取得できる。現行JSON交換は用途を明示して区別する。作者の認証と対象作品の認可をAPIで強制し、MCP・公開reader・非認可クライアントに包括的エクスポートを付与しない。HTTP契約、画面操作、Native対応は実装前に所有するTypeSpec/API/route authorization/画面契約で定義し、既存対応クライアントの責務を維持する。
- 全ファイルは単一のPostgreSQL読み取りsnapshotから生成する。作品・履歴・知識等のページングは同一snapshotを保持し、編集中の別Revisionを混在させない。既存 `exportWorkArchive` の認可済み読み取り・データ投影・機密除外と永続化層のページングを再利用し、第二のドメインwriterやSQL接続境界を作らない。現行v1の8 MiB／件数上限を新形式へそのまま流用せず、streaming等でメモリ・接続時間・同時実行・一時領域の上限を管理する。
- 作品名・文書名をそのまま安全なパスとみなさない。絶対path、親directory traversal、特殊ファイル・リンク、Windows予約名、大小文字・Unicode・同名衝突を回避し、manifestのID/path対応が一意であること。ZIP生成は既存の [library-first規約](architecture/DEPENDENCY-POLICY.md) に従い、保守されたライブラリを用いる。初期実装は [実装契約](architecture/OPEN-WORK-EXPORT-CONTRACT.md#スナップショットと資源上限) の暫定値で検証し、同契約の計測条件で上限を確定する。
- 生成失敗、DB停止、snapshot不成立、容量上限超過、キャンセル、通信切断を完了と表示しない。全件が入った成果物だけを成功とし、部分ZIPや黙った省略を許さない。生成途中の一時資源は確実に解放し、未承認の永続ファイルストアを作らない。

### 受入条件

1. 複数階層、同名／Windows予約名、日本語・Unicode・混合改行の原稿、過去Revision、論理削除文書を含む作品を出力する。一般的なZIP展開機能とテキストエディタだけで利用し、本文bytes・件数・順序・ID・hashをDB snapshotと照合する。
2. Knowledge/Evidence/Assertion・未解決参照・作者所有module recordの構造化JSONを公開schemaで検査し、参照と本文が一致するか確認する。作者許可外データ・秘密情報・内部権限を含むfixtureで漏えいがないことを検査する。
3. 8 MiBを超える作品および複数ページにわたる履歴を実DBから取得し、完全性、bounded resource、同時編集下のsnapshot一貫性、キャンセル／容量超過／DB障害時の失敗表示と一時資源解放を検証する。
4. 現行JSON交換・import・認可に回帰がなく、他作品・非認可principalから取得できないことをAPI/対象クライアントで検証する。ZIPを展開できることだけを全件の証拠とはしない。
