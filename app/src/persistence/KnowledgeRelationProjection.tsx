import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { KnowledgeNode, KnowledgeNodeId, KnowledgeRelation } from "@codexia/persistence-contracts";
import { api, type PersistenceNodeRead } from "../api";

const MAX_VISIBLE_RELATIONS = 40;

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    proposed: "候補",
    confirmed: "確認済み",
    rejected: "却下",
    retired: "退役",
  };
  return `${status} · ${labels[status] ?? "状態を確認"}`;
}

function endpointName(id: KnowledgeNodeId, nodesById: Map<KnowledgeNodeId, KnowledgeNode>): string {
  return nodesById.get(id)?.name ?? "未取得のKnowledge";
}

export function KnowledgeRelationProjection({
  node,
  nodes,
  relations,
  actionsDisabled,
  onStatusChange,
}: {
  node: KnowledgeNode;
  nodes: KnowledgeNode[];
  relations: KnowledgeRelation[];
  actionsDisabled: boolean;
  onStatusChange: (relation: KnowledgeRelation, status: KnowledgeRelation["status"]) => void;
}) {
  const [showInactive, setShowInactive] = useState(false);
  const [openNodeId, setOpenNodeId] = useState<KnowledgeNodeId | "">("");
  const [peek, setPeek] = useState<PersistenceNodeRead | null>(null);
  const [peekError, setPeekError] = useState("");
  const [peekLoading, setPeekLoading] = useState(false);
  const [peekReload, setPeekReload] = useState(0);
  const nodesById = useMemo(() => new Map(nodes.map((candidate) => [candidate.id, candidate])), [nodes]);
  const localRelations = relations.filter((relation) => relation.sourceId === node.id || relation.targetId === node.id);
  const inactiveRelations = localRelations.filter((relation) => relation.status === "retired" || relation.status === "rejected");
  const visibleRelations = localRelations
    .filter((relation) => showInactive || (relation.status !== "retired" && relation.status !== "rejected"))
    .slice(0, MAX_VISIBLE_RELATIONS);
  const remainingCount = Math.max(0, localRelations.filter((relation) => showInactive || (relation.status !== "retired" && relation.status !== "rejected")).length - visibleRelations.length);
  const openNode = openNodeId ? nodesById.get(openNodeId) : undefined;

  useEffect(() => {
    if (!openNodeId || !openNode) {
      setPeek(null);
      setPeekError("");
      setPeekLoading(false);
      return;
    }
    const abort = new AbortController();
    setPeek(null);
    setPeekError("");
    setPeekLoading(true);
    void api.persistenceNode(node.projectId, openNodeId, abort.signal).then((result) => {
      if (!abort.signal.aborted) setPeek(result);
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setPeekError(reason instanceof Error ? reason.message : "関係先の詳細を取得できませんでした。");
    }).finally(() => {
      if (!abort.signal.aborted) setPeekLoading(false);
    });
    return () => abort.abort();
  }, [node.projectId, openNodeId, openNode?.version, peekReload]);

  const renderEndpoint = (id: KnowledgeNodeId): ReactNode => {
    const candidate = nodesById.get(id);
    if (id === node.id) {
      return <span className="kci__endpoint kci__endpoint--selected" aria-current="true">
        <strong>{node.name}</strong><small>{node.type} · 表示中</small>
      </span>;
    }
    if (!candidate) {
      return <span className="kci__endpoint kci__endpoint--missing">
        <strong>{endpointName(id, nodesById)}</strong><small>この作品の取得済み一覧にありません</small><code>{id}</code>
      </span>;
    }
    return <button
      className="kci__endpoint kci__endpoint--link"
      type="button"
      aria-label={`関係先の詳細を表示: ${candidate.name} · ${candidate.type} · ${candidate.id}`}
      aria-expanded={openNodeId === id}
      aria-controls={openNodeId === id ? "kci-neighbor-detail" : undefined}
      onClick={() => setOpenNodeId((current) => current === id ? "" : id)}
    >
      <strong>{candidate.name}</strong><small>{candidate.type} · {candidate.status}</small>
    </button>;
  };

  return <>
    <div className="kci__graph-intro">
      <p>矢印は保存された関係の向きです。確定・候補は状態名と線の形でも区別します。</p>
      {inactiveRelations.length > 0 && <button className="kci__quiet-action" type="button" aria-expanded={showInactive} onClick={() => setShowInactive((current) => !current)}>
        {showInactive ? "退役・却下を隠す" : `退役・却下も表示 · ${inactiveRelations.length}件`}
      </button>}
    </div>

    {visibleRelations.length === 0
      ? <p className="kci__empty">{localRelations.length === 0
        ? "取得済みの直接関係はありません。関係一覧から追加できます。"
        : "表示できる関係はありません。退役・却下済みの関係を確認できます。"}</p>
      : <ul className="kci__graph" aria-label={`${node.name}の直接関係`}>
        {visibleRelations.map((relation) => {
          const source = nodesById.get(relation.sourceId);
          const target = nodesById.get(relation.targetId);
          const relationStatus = statusLabel(relation.status);
          return <li className="kci__graph-row" data-status={relation.status} key={relation.id}>
            <span className="kci__visually-hidden">{endpointName(relation.sourceId, nodesById)}から{relation.type}を通って{endpointName(relation.targetId, nodesById)}へ</span>
            <div className="kci__graph-pair">
              <div className="kci__graph-source">{renderEndpoint(relation.sourceId)}</div>
              <div className="kci__graph-edge" aria-label={`${endpointName(relation.sourceId, nodesById)}から${endpointName(relation.targetId, nodesById)}へ: ${relation.type}`}>
                <span className="kci__graph-edge-label">{relation.type}</span>
                <span className="kci__graph-line" aria-hidden="true"><span>→</span></span>
              </div>
              <div className="kci__graph-target">{renderEndpoint(relation.targetId)}</div>
            </div>
            <div className="kci__relation-meta">
              <span>{relationStatus}</span>
              {relation.validity && Object.keys(relation.validity).length > 0 && <details className="kci__technical">
                <summary>有効範囲</summary><pre>{JSON.stringify(relation.validity, null, 2)}</pre>
              </details>}
              {relation.attributes && Object.keys(relation.attributes).length > 0 && <details className="kci__technical">
                <summary>追加属性</summary><pre>{JSON.stringify(relation.attributes, null, 2)}</pre>
              </details>}
            </div>
            {relation.status === "proposed" && <div className="kci__actions">
              <button type="button" disabled={actionsDisabled} onClick={() => onStatusChange(relation, "confirmed")}>関係を確定</button>
              <button type="button" className="kci__quiet-action" disabled={actionsDisabled} onClick={() => onStatusChange(relation, "rejected")}>関係を却下</button>
            </div>}
            {relation.status === "confirmed" && <div className="kci__actions">
              <button type="button" className="kci__quiet-action" disabled={actionsDisabled} onClick={() => onStatusChange(relation, "retired")}>関係を退役</button>
            </div>}
            {(!source || !target) && <p className="kci__graph-note">相手のKnowledgeは現在の一覧に含まれていません。IDから別のノードを推定していません。</p>}
          </li>;
        })}
      </ul>}
    {remainingCount > 0 && <p className="kci__graph-note">取得済みの直接関係 {remainingCount} 件を省略しています。全作品を追加取得していません。</p>}

    {openNode && <section id="kci-neighbor-detail" className="kci__neighbor" aria-label={`${openNode.name}の読み取り専用詳細`} aria-live="polite">
      <header className="kci__neighbor-heading">
        <div><p className="kci__section-kicker">関係先 · 読み取り専用</p><h5>{openNode.name}</h5></div>
        <button type="button" className="kci__quiet-action" onClick={() => setOpenNodeId("")}>閉じる</button>
      </header>
      <p className="kci__guidance">Knowledge一覧の選択と編集状態は変わっていません。</p>
      {peekLoading && <p className="kci__loading" role="status">関係先の詳細を読み込んでいます。</p>}
      {peekError && <div className="kci__alert" role="alert">
        <p>{peekError}</p>
        <button className="kci__quiet-action" type="button" onClick={() => setPeekReload((current) => current + 1)}>関係先を再読み込み</button>
      </div>}
      {peek && <>
        <dl className="kci__neighbor-facts">
          <div><dt>種類</dt><dd>{peek.node.type}</dd></div>
          <div><dt>状態</dt><dd>{statusLabel(peek.node.status)}</dd></div>
          <div><dt>別名</dt><dd>{peek.aliases.length}件</dd></div>
          <div><dt>関係</dt><dd>{peek.relations.length}件</dd></div>
        </dl>
        {peek.aliases.length > 0 && <ul className="kci__neighbor-aliases">
          {peek.aliases.map((alias) => <li key={alias.id}>{alias.surface} · {statusLabel(alias.status)}</li>)}
        </ul>}
        <details className="kci__technical">
          <summary>保存済み属性</summary><pre>{JSON.stringify(peek.node.attributes, null, 2)}</pre>
        </details>
        <details className="kci__technical">
          <summary>関係一覧</summary>
          <ul>{peek.relations.map((relation) => <li key={relation.id}>{endpointName(relation.sourceId, nodesById)} → {relation.type} → {endpointName(relation.targetId, nodesById)} · {statusLabel(relation.status)}</li>)}</ul>
        </details>
      </>}
    </section>}
  </>;
}
