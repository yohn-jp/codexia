import type { PersistenceAnchorView } from "../api";

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    proposed: "候補",
    confirmed: "確認済み",
    ambiguous: "曖昧",
    candidate: "候補",
    needs_review: "要確認",
    orphaned: "孤立",
    stale: "古い状態",
    rejected: "却下",
    retired: "退役",
  };
  return `${status} · ${labels[status] ?? "状態を確認"}`;
}

function revisionLabel(item: PersistenceAnchorView, documentId?: string, revisionId?: string, clean = false): string {
  if (item.anchor.documentId !== documentId || item.anchor.revisionId !== revisionId) return "過去または別文書の保存済みRevision";
  return clean
    ? "表示中の保存済みRevision"
    : "保存済みRevision · 原稿に未保存の変更あり";
}

export function KnowledgeEvidenceList({
  nodeId,
  items,
  documentLabels,
  documentsLoading,
  documentsError,
  documentId,
  revisionId,
  clean,
  selectedEvidenceId,
  onOpenEvidence,
}: {
  nodeId: string;
  items: PersistenceAnchorView[];
  documentLabels: Readonly<Record<string, string>>;
  documentsLoading: boolean;
  documentsError: string;
  documentId?: string;
  revisionId?: string;
  clean: boolean;
  selectedEvidenceId: string;
  onOpenEvidence: (item: PersistenceAnchorView) => void;
}) {
  return <section className="kci__section" aria-labelledby="kci-evidence-heading">
    <div className="kci__section-heading">
      <div><p className="kci__section-kicker">Text Anchor · 最大500件</p><h4 id="kci-evidence-heading">根拠・引用</h4></div>
      <span className="kci__count">{items.length}件</span>
    </div>
    {documentsLoading && <p className="kci__loading" role="status">文書階層を照合しています。</p>}
    {documentsError && <p className="kci__status-note">文書階層を取得できませんでした。文書IDとRevisionを使って照合できます。</p>}
    {items.length === 0
      ? <p className="kci__empty">このKnowledgeにリンクされた保存済み根拠はありません。</p>
      : <ul className="kci__evidence-list">
        {items.map((item) => {
          const link = item.mentions.find(({ link: mention }) => mention.nodeId === nodeId)?.link;
          const path = documentLabels[item.anchor.documentId];
          const currentRevision = item.anchor.documentId === documentId && item.anchor.revisionId === revisionId;
          const currentReference = currentRevision && clean && item.anchor.status === "confirmed" && link?.status === "confirmed";
          return <li className="kci__evidence" data-selected={item.anchor.id === selectedEvidenceId} key={item.anchor.id}>
            <div className="kci__evidence-source">
              <div>
                <p className="kci__evidence-label">{currentReference ? "現在の確定根拠" : "保存済み根拠"}</p>
                <strong>{path ?? (documentsLoading ? "文書階層を照合中" : "文書名を取得できません")}</strong>
              </div>
              <span className="kci__status">Anchor · {statusLabel(item.anchor.status)}</span>
            </div>
            <blockquote className="kci__quote">{item.quote || "引用本文を取得できません。保存された位置とRevisionを確認してください。"}</blockquote>
            <dl className="kci__evidence-facts">
              <div><dt>位置</dt><dd>{revisionLabel(item, documentId, revisionId, clean)}</dd></div>
              <div><dt>Knowledgeリンク</dt><dd>{link ? statusLabel(link.status) : "状態を確認できません"}</dd></div>
            </dl>
            {item.anchor.id === selectedEvidenceId && <p className="kci__selected-note">原稿の根拠選択で選ばれています。</p>}
            <button className="kci__quote-action" type="button" onClick={() => onOpenEvidence(item)}>
              {currentReference ? "現在の原稿で位置を確認" : "引用と位置を確認"}
            </button>
            <details className="kci__technical">
              <summary>RevisionとAnchorの識別情報</summary>
              <dl className="kci__technical-list">
                <div><dt>Document ID</dt><dd><code>{item.anchor.documentId}</code></dd></div>
                <div><dt>Revision ID</dt><dd><code>{item.anchor.revisionId}</code></dd></div>
                <div><dt>Anchor ID</dt><dd><code>{item.anchor.id}</code></dd></div>
                <div><dt>UTF-16範囲</dt><dd>{item.anchor.fromUtf16}–{item.anchor.toUtf16}</dd></div>
                <div><dt>引用hash</dt><dd><code>{item.anchor.quoteSha256}</code></dd></div>
              </dl>
            </details>
          </li>;
        })}
      </ul>}
  </section>;
}
