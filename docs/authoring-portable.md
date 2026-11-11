# 作品データのエクスポート・インポート

Codexiaは、現在の作品を持ち出すためのバージョン付き **codexia-work/v1 JSON** を提供します。Desktop / Mobileの「作品」パネルにある「作品のエクスポート・インポート」から利用します。これはPostgreSQLの稼働時バックアップや全Revision履歴の復元機能ではありません。

## 対象と安全性

- **含むもの:** 作品名・機密設定を除く作品設定、文書のID/階層/並び順/最新Markdown（Unicode・改行をそのまま保持）、Knowledgeノード/別名/関係、最新Revisionに結び付くEvidenceアンカー/言及/Assertion、作者が保持するモジュールレコード。
- **含まないもの:** 旧Revision全文・原本のRevision ID/日時/作者、IndexedDBの未保存Draft、承認/適用待ち提案、秘密値、セッション、アクセストークン、公開共有の許可記録、モデルキャッシュ、ホスト履歴、デプロイ設定。
- 現在の文書と一致しないEvidenceアンカーはevidence.unresolvedに原記録と関連リンクを収めます。取り込み時には**根拠がないのに現行Revisionへ紐付け直すことはしません**。取り込み後も専用PostgreSQLモジュールレコードに保持され、再エクスポートで再び出力されます。UIには未解決件数を明示します。
- 除外した秘密/内部モジュールレコードの**名前だけ**をomittedRecordsで報告します。秘密値そのものは含めません。作品原稿や一般のモジュール記録は機密情報を含み得るため、JSONは非公開で扱ってください。
- 各エクスポートは**単一のPostgreSQL読み取りスナップショット**から作成します。8 MiBを超える作品、文書/Knowledge等の検証上限に達する作品は、途中までの偽の成果物を返さずエラーにします。インポートHTTP本文の最大値は12 MiBです。

## 取り込みの挙動

codexia-work/v1は**新しい作品のみ作成**します。既存作品の本文やグラフを上書きするAPIはありません。文書・Knowledge・Evidence・モジュールの作成は1つのPostgreSQLトランザクションで行い、途中で失敗するとすべてロールバックします。

入力のスキーマ、IDの一意性、親子関係・循環、関連するノード/アンカーの存在、Evidence引用のSHA-256を検証します。旧Revision IDは持ち込まず、インポート先のRevisionへ正しく付け直します。完全に同じJSONの再送は同じ作品を返すため、タイムアウト後の再試行で作品が増殖しません。

Standaloneでは認証済み作者のセッションが必要です。読み取りBearerだけで新規作品を作成することはできません。Hosted runtimeは既存の割当プロジェクトに限定されるため、新規作品のインポートを拒否します。エクスポートは割当済み作品のみ許可します。

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

これらのAPIは、既存の認証、同一オリジン/CSRF、Hostedプロジェクト境界を通過します。作品をインポートする前に、未保存のブラウザーDraftを保護してください。

## 一度限りの旧データ取り込み

旧Scriptorium/Git原稿の形式をCodexiaアプリに恒久実装する必要はありません。**保全した旧データを別作業でこのJSON形式へ変換し、通常のインポート機能を利用**します。元データを読み取り専用で保全し、原稿件数・本文ハッシュ・階層・Knowledge・未解決Evidence・機密除外を確認してから、インポートした新作品を読み戻して照合してください。

運用上の全履歴と真正なバックアップには[PostgreSQLバックアップと復元手順](deployment/README.md)を使います。JSON交換だけを唯一のバックアップにしないでください。
