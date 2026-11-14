import { useEffect, useMemo, useState } from "react";
import type { Assertion, KnowledgeAlias, KnowledgeAliasId, KnowledgeNode, KnowledgeRelation, KnowledgeRelationId } from "@codexia/persistence-contracts";
import { api, type PersistenceAnchorView, type PersistenceNodeRead } from "../api";
import { KnowledgeEvidenceList } from "./KnowledgeEvidenceList";
import { KnowledgeRelationProjection } from "./KnowledgeRelationProjection";
import "./KnowledgeContextInspector.css";

type Modality = "fact" | "belief" | "disclosure" | "hypothesis";
type PersistenceDocuments = Awaited<ReturnType<typeof api.persistenceDocuments>>["documents"];

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

function documentPaths(documents: PersistenceDocuments): Record<string, string> {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const paths: Record<string, string> = {};
  for (const document of documents) {
    const segments: string[] = [];
    const visited = new Set<string>();
    let current = document;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      segments.unshift(current.title);
      if (!current.parentId) break;
      const parent = byId.get(current.parentId);
      if (!parent) {
        segments.unshift("親文書未取得");
        break;
      }
      current = parent;
    }
    paths[document.id] = segments.join(" / ");
  }
  return paths;
}

export function KnowledgeContextInspector({
  node,
  nodes,
  documentId,
  revisionId,
  clean,
  selectedEvidenceId,
  evidenceLoadKey,
  onOpenEvidence,
  onMerge,
  onNodeUpdate,
}: {
  node: KnowledgeNode;
  nodes: KnowledgeNode[];
  documentId?: string;
  revisionId?: string;
  clean: boolean;
  selectedEvidenceId: string;
  evidenceLoadKey: number;
  onOpenEvidence: (item: PersistenceAnchorView) => void;
  onMerge: (target: KnowledgeNode, source: KnowledgeNode) => void;
  onNodeUpdate: (node: KnowledgeNode) => void;
}) {
  const projectId = node.projectId;
  const [detail, setDetail] = useState<PersistenceNodeRead | null>(null);
  const [anchors, setAnchors] = useState<PersistenceAnchorView[]>([]);
  const [linked, setLinked] = useState<PersistenceAnchorView[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergePreview, setMergePreview] = useState<Awaited<ReturnType<typeof api.previewPersistenceMerge>> | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const [storyEntityId, setStoryEntityId] = useState(String(node.attributes.storyEntityId ?? ""));
  const [surface, setSurface] = useState("");
  const [target, setTarget] = useState("");
  const [relationType, setRelationType] = useState("");
  const [statement, setStatement] = useState("");
  const [modality, setModality] = useState<Modality>("fact");
  const [perspective, setPerspective] = useState("author");
  const [documentLabels, setDocumentLabels] = useState<Record<string, string>>({});
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    setDetail(null);
    setAnchors([]);
    setLinked([]);
    setError("");
    void Promise.all([
      api.persistenceNode(projectId, node.id, abort.signal),
      api.persistenceNodeEvidence(projectId, node.id, 500, abort.signal),
      documentId && revisionId
        ? api.persistenceDocumentAnchors(projectId, documentId, revisionId, abort.signal)
        : Promise.resolve(null),
    ]).then(([data, evidence, doc]) => {
      if (!abort.signal.aborted) {
        setDetail(data);
        setLinked(evidence.evidence);
        setAnchors(doc?.anchors ?? []);
      }
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Knowledgeを取得できませんでした。");
    });
    return () => abort.abort();
  }, [projectId, node.id, node.version, documentId, revisionId, evidenceLoadKey, reload]);

  useEffect(() => {
    const abort = new AbortController();
    setDocumentsLoading(true);
    setDocumentsError("");
    void api.persistenceDocuments(projectId, undefined, abort.signal).then((result) => {
      if (!abort.signal.aborted) setDocumentLabels(documentPaths(result.documents));
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setDocumentsError(reason instanceof Error ? reason.message : "文書階層を取得できませんでした。");
    }).finally(() => {
      if (!abort.signal.aborted) setDocumentsLoading(false);
    });
    return () => abort.abort();
  }, [projectId]);

  const mutate = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      setReload((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const aliasSave = (alias: KnowledgeAlias, status: KnowledgeAlias["status"]): Promise<void> =>
    mutate(() => api.savePersistenceAlias(projectId, node.id, {
      id: alias.id,
      surface: alias.surface,
      normalized: alias.normalized,
      scope: alias.scope,
      status,
    }));

  const relationSave = (relation: KnowledgeRelation, status: KnowledgeRelation["status"]): Promise<void> =>
    mutate(() => api.savePersistenceRelation(projectId, relation.sourceId, {
      id: relation.id,
      targetId: relation.targetId,
      type: relation.type,
      attributes: relation.attributes,
      validity: relation.validity,
      status,
      expectedVersion: relation.version,
    }));

  const assertionSave = (assertion: Assertion, status: Assertion["status"]): Promise<void> =>
    mutate(() => api.savePersistenceAssertion(projectId, assertion.id, {
      proposition: assertion.proposition,
      modality: assertion.modality,
      perspective: assertion.perspective,
      narrativeTime: assertion.narrativeTime,
      confidence: assertion.confidence,
      status,
      expectedVersion: assertion.version,
    }));

  const current = anchors.find((item) =>
    item.anchor.id === selectedEvidenceId &&
    item.anchor.documentId === documentId &&
    item.anchor.revisionId === revisionId &&
    item.anchor.status === "confirmed" &&
    item.mentions.some(({ link }) => link.nodeId === node.id && link.status === "confirmed"),
  );
  const evidence = useMemo(() => {
    const byId = new Map<string, PersistenceAnchorView>();
    for (const item of [...linked, ...anchors]) byId.set(item.anchor.id, item);
    return [...byId.values()];
  }, [linked, anchors]);
  const assertions = useMemo(() => {
    const byId = new Map<string, { assertion: Assertion; item: PersistenceAnchorView }>();
    for (const item of evidence) {
      for (const linkedAssertion of item.assertions) {
        if (linkedAssertion.assertion?.proposition.nodeId === node.id) {
          byId.set(linkedAssertion.assertion.id, { assertion: linkedAssertion.assertion, item });
        }
      }
    }
    return [...byId.values()];
  }, [evidence, node.id]);
  const canEdit = node.status !== "retired" && !node.deletedAt;

  return (
    <section className="kci" aria-label="Knowledge詳細">
      <header className="kci__header">
        <p className="kci__eyebrow">{node.type} · {statusLabel(node.status)}</p>
        <h3 className="kci__title">{node.name}</h3>
        <p className="kci__lead">作品内のKnowledge。別名・関係・保存済み根拠・命題を、確定状態と一緒に確認できます。</p>
        <details className="kci__technical">
          <summary>識別情報と保存済み属性</summary>
          <dl className="kci__technical-list">
            <div><dt>Knowledge ID</dt><dd><code>{node.id}</code></dd></div>
            <div><dt>状態</dt><dd>{node.status} · version {node.version}</dd></div>
          </dl>
          <pre>{JSON.stringify(node.attributes, null, 2)}</pre>
        </details>
      </header>

      {error && <div className="kci__alert" role="alert">
        <p>{error}</p>
        <button className="kci__quiet-action" type="button" onClick={() => setReload((current) => current + 1)}>Knowledge詳細を再読み込み</button>
      </div>}
      {!detail && !error && <p className="kci__loading" role="status">Knowledge詳細を読み込んでいます。</p>}

      {detail && <div className="kci__body">
        <section className="kci__section" aria-labelledby="kci-aliases-heading">
          <div className="kci__section-heading">
            <div><p className="kci__section-kicker">表記</p><h4 id="kci-aliases-heading">別名</h4></div>
            <span className="kci__count">{detail.aliases.length}件</span>
          </div>
          {detail.aliases.length === 0
            ? <p className="kci__empty">このKnowledgeに登録された別名はありません。</p>
            : <ul className="kci__alias-list">
              {detail.aliases.map((alias) => <li className="kci__alias" key={alias.id}>
                <div className="kci__alias-copy">
                  <strong>{alias.surface} · {alias.status}</strong>
                  <span>{statusLabel(alias.status)}</span>
                  {alias.scope && <small>範囲: {alias.scope}</small>}
                </div>
                <div className="kci__actions">
                  {alias.status !== "confirmed" && alias.status !== "retired" && <button type="button" disabled={busy || !canEdit} onClick={() => void aliasSave(alias, "confirmed")}>別名を確定</button>}
                  {alias.status !== "retired" && <>
                    <button type="button" className="kci__quiet-action" disabled={busy || !canEdit} onClick={() => void aliasSave(alias, "ambiguous")}>曖昧にする</button>
                    <button type="button" className="kci__quiet-action" disabled={busy || !canEdit} onClick={() => void aliasSave(alias, "retired")}>別名を退役</button>
                  </>}
                </div>
                <details className="kci__technical">
                  <summary>別名の照合情報</summary>
                  <dl className="kci__technical-list">
                    <div><dt>正規化表記</dt><dd>{alias.normalized}</dd></div>
                    <div><dt>scope</dt><dd>{alias.scope ?? "作品内"}</dd></div>
                    <div><dt>別名ID</dt><dd><code>{alias.id}</code></dd></div>
                  </dl>
                </details>
              </li>)}
            </ul>}
          <form className="kci__form" onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              const value = surface.trim();
              await api.savePersistenceAlias(projectId, node.id, {
                id: crypto.randomUUID() as KnowledgeAliasId,
                surface: value,
                normalized: value.normalize("NFKC").toLocaleLowerCase("ja"),
                scope: null,
                status: "proposed",
              });
              setSurface("");
            });
          }}>
            <label className="kci__field">別名候補
              <input value={surface} onChange={(event) => setSurface(event.target.value)} maxLength={512} required />
            </label>
            <button type="submit" disabled={busy || !canEdit || !surface.trim()}>別名候補を追加</button>
          </form>
        </section>

        <section className="kci__section" aria-labelledby="kci-relation-heading">
          <div className="kci__section-heading">
            <div><p className="kci__section-kicker">1 hop · 取得済みデータ</p><h4 id="kci-relation-heading">関係</h4></div>
          </div>
          <KnowledgeRelationProjection
            node={node}
            nodes={nodes}
            relations={detail.relations}
            actionsDisabled={busy || !canEdit}
            onStatusChange={(relation, status) => void relationSave(relation, status)}
          />
          <form className="kci__form kci__form--relation" onSubmit={(event) => {
            event.preventDefault();
            const other = nodes.find((candidate) => candidate.id === target && candidate.projectId === projectId && candidate.status !== "retired");
            if (!other) return;
            void mutate(async () => {
              await api.savePersistenceRelation(projectId, node.id, {
                id: crypto.randomUUID() as KnowledgeRelationId,
                targetId: other.id,
                type: relationType.trim(),
                attributes: {},
                validity: {},
                status: "proposed",
                expectedVersion: null,
              });
              setRelationType("");
              setTarget("");
            });
          }}>
            <p className="kci__form-title">関係候補を登録</p>
            <label className="kci__field">関係の種類
              <input value={relationType} onChange={(event) => setRelationType(event.target.value)} maxLength={128} required />
            </label>
            <label className="kci__field">関係先
              <select value={target} onChange={(event) => setTarget(event.target.value)} required>
                <option value="">Knowledgeを選択</option>
                {nodes.filter((candidate) => candidate.id !== node.id && candidate.projectId === projectId && candidate.status !== "retired").map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name} · {candidate.type} · {candidate.status}</option>)}
              </select>
            </label>
            <button type="submit" disabled={busy || !canEdit || !target || !relationType.trim()}>関係候補を追加</button>
          </form>
        </section>

        <KnowledgeEvidenceList
          nodeId={node.id}
          items={linked}
          documentLabels={documentLabels}
          documentsLoading={documentsLoading}
          documentsError={documentsError}
          documentId={documentId}
          revisionId={revisionId}
          clean={clean}
          selectedEvidenceId={selectedEvidenceId}
          onOpenEvidence={onOpenEvidence}
        />

        <section className="kci__section" aria-labelledby="kci-assertions-heading">
          <div className="kci__section-heading">
            <div><p className="kci__section-kicker">根拠と視点</p><h4 id="kci-assertions-heading">保存済み命題</h4></div>
            <span className="kci__count">{assertions.length}件</span>
          </div>
          {assertions.length === 0
            ? <p className="kci__empty">このKnowledgeに結び付いた命題はありません。</p>
            : <ul className="kci__assertion-list">
              {assertions.map(({ assertion, item }) => {
                const statementText = String(assertion.proposition.statement ?? "");
                return <li className="kci__assertion" key={assertion.id}>
                  <p className="kci__assertion-summary">{statementText} · {assertion.modality} · {assertion.perspective} · {assertion.status}</p>
                  <div className="kci__assertion-meta">
                    <span>{statusLabel(assertion.status)}</span>
                    <span>視点: {assertion.perspective}</span>
                    <span>種別: {assertion.modality}</span>
                  </div>
                  <button className="kci__quote-action" type="button" onClick={() => onOpenEvidence(item)}>
                    根拠を原稿で確認{item.quote ? ` · ${item.quote}` : ""}
                  </button>
                  <details className="kci__technical">
                    <summary>命題の保存内容と根拠</summary>
                    <p>Revision <code>{item.anchor.revisionId}</code> · Anchor <code>{item.anchor.id}</code></p>
                    <pre>{JSON.stringify(assertion.proposition, null, 2)}</pre>
                  </details>
                  {assertion.status === "proposed" && <div className="kci__actions">
                    <button type="button" disabled={busy || !canEdit || node.status !== "confirmed" || item.anchor.status !== "confirmed"} onClick={() => void assertionSave(assertion, "confirmed")}>命題を確定</button>
                    <button type="button" className="kci__quiet-action" disabled={busy || !canEdit} onClick={() => void assertionSave(assertion, "rejected")}>命題を却下</button>
                  </div>}
                  {assertion.status === "confirmed" && <div className="kci__actions">
                    <button type="button" className="kci__quiet-action" disabled={busy || !canEdit} onClick={() => void assertionSave(assertion, "retired")}>命題を退役</button>
                  </div>}
                </li>;
              })}
            </ul>}

          <p className="kci__guidance">{current
            ? "選択中の保存済みText Anchorを根拠に命題候補を作成します。"
            : "現在の保存済みRevisionで、このKnowledgeへのリンクが確定したText Anchorを選択してください。"}</p>
          <form className="kci__form" onSubmit={(event) => {
            event.preventDefault();
            if (!current || !documentId || !revisionId || !clean || !statement.trim() || !perspective.trim()) return;
            void mutate(async () => {
              await api.createPersistenceAnchorAssertion(projectId, documentId, current.anchor.id, {
                id: crypto.randomUUID(),
                nodeId: node.id,
                statement: statement.trim(),
                modality,
                perspective: perspective.trim(),
                revisionId,
                expectedAnchorVersion: current.anchor.version,
              });
              setStatement("");
            });
          }}>
            <label className="kci__field">命題
              <textarea value={statement} onChange={(event) => setStatement(event.target.value)} maxLength={4000} required />
            </label>
            <div className="kci__form-pair">
              <label className="kci__field">種別
                <select value={modality} onChange={(event) => setModality(event.target.value as Modality)}>
                  <option value="fact">世界の事実</option>
                  <option value="belief">人物の認識</option>
                  <option value="disclosure">読者への開示</option>
                  <option value="hypothesis">仮説</option>
                </select>
              </label>
              <label className="kci__field">視点
                <input value={perspective} onChange={(event) => setPerspective(event.target.value)} maxLength={128} required />
              </label>
            </div>
            <button type="submit" disabled={busy || !canEdit || !clean || !current || !statement.trim() || !perspective.trim()}>命題候補を保存</button>
          </form>
        </section>

        <section className="kci__section" aria-labelledby="kci-merge-heading">
          <div className="kci__section-heading">
            <div><p className="kci__section-kicker">正本の統合</p><h4 id="kci-merge-heading">Knowledge統合</h4></div>
          </div>
          <p className="kci__guidance">同じ型の確定済みKnowledgeを選び、統合先・影響・競合を確認してから適用します。</p>
          <label className="kci__field">統合先
            <select value={mergeTarget} onChange={(event) => {
              setMergeTarget(event.target.value);
              setMergePreview(null);
              setMergeConfirm(false);
            }}>
              <option value="">選択</option>
              {nodes.filter((candidate) => candidate.id !== node.id && candidate.type === node.type && candidate.status === "confirmed" && !candidate.deletedAt).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.type} · {candidate.id}</option>)}
            </select>
          </label>
          <button className="kci__merge-preview-button" type="button" disabled={busy || !canEdit || !mergeTarget} onClick={() => void mutate(async () => {
            setMergeConfirm(false);
            setMergePreview(await api.previewPersistenceMerge(projectId, node.id, mergeTarget));
          })}>統合内容を確認</button>
          {mergePreview && <div className="kci__merge-preview">
            <p className="kci__merge-direction">{mergePreview.source.name} <span aria-hidden="true">→</span> {mergePreview.target.name}</p>
            <p>{mergePreview.sourceAliases.length} 別名 · {mergePreview.sourceRelations.length} 関係 · {mergePreview.sourceMentions.length} 根拠 · {mergePreview.assertions.length} 命題</p>
            {mergePreview.conflicts.length > 0
              ? <ul className="kci__conflicts">{mergePreview.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}</ul>
              : <p className="kci__status-note">現在確認できる競合はありません。適用前に以下の影響を確認してください。</p>}
            <details className="kci__technical">
              <summary>統合対象とAPIプレビュー</summary>
              <pre>{JSON.stringify(mergePreview, null, 2)}</pre>
            </details>
            <label className="kci__confirm">
              <input type="checkbox" checked={mergeConfirm} onChange={(event) => setMergeConfirm(event.target.checked)} />
              統合元を退役し、参照を統合先に移すことを確認しました。
            </label>
            <button type="button" disabled={busy || !mergeConfirm || mergePreview.conflicts.length > 0} onClick={() => void mutate(async () => {
              const result = await api.applyPersistenceMerge(projectId, node.id, mergeTarget, mergePreview.projectVersion, mergePreview.previewDigest);
              onMerge(result.target, result.source);
              setMergePreview(null);
            })}>作者承認で統合</button>
          </div>}
        </section>

        <details className="kci__section kci__technical-association">
          <summary>Storyとの明示的な関連付け（詳細）</summary>
          <p className="kci__guidance">IDを手入力する詳細操作です。同名のKnowledgeからStory実体を推定しません。</p>
          <label className="kci__field">Story entity ID
            <input value={storyEntityId} onChange={(event) => setStoryEntityId(event.target.value)} />
          </label>
          <button type="button" disabled={busy || !canEdit} onClick={() => void mutate(async () => {
            const result = await api.savePersistenceNode(projectId, node.id, {
              type: node.type,
              name: node.name,
              attributes: { ...node.attributes, storyEntityId: storyEntityId.trim() || null },
              status: node.status,
              expectedVersion: node.version,
            });
            onNodeUpdate(result.node);
          })}>関連付けを保存</button>
        </details>
      </div>}
    </section>
  );
}
