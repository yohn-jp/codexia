import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeSet, ChangeSetApplicationResult, SaveEvidenceAnchorCommand } from "@codexia/persistence-contracts";
import { ApiError } from "../api-error";
import { api } from "../api";

type Detail = { changeSet: ChangeSet; receipt?: ChangeSetApplicationResult };

function errorText(error: unknown): string {
  if (error instanceof ApiError && (error.status === 409 || error.status === 412)) return `提案の状態または前提条件が更新されています。最新状態を再確認してください。${error.message ? ` ${error.message}` : ""}`;
  if (error instanceof ApiError && error.status === 401) return "認証を確認できません。再ログインしてから状態を再確認してください。";
  return error instanceof Error ? error.message : "ChangeSetの処理結果を確認できませんでした。";
}

function sourceProjectVersion(changeSet: ChangeSet): string {
  const value = changeSet.provenance.details.projectVersion;
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "記録なし";
}

function statusLabel(status: ChangeSet["status"]): string {
  return ({ proposed: "提案", approved: "承認済み・未適用", applied: "適用済み", rejected: "却下" })[status];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergePlanName(plan: Record<string, unknown>, key: "source" | "target"): string {
  const value = plan[key];
  return isRecord(value) && typeof value.name === "string" ? value.name : "Knowledge node";
}

function mergePlanConflicts(plan: Record<string, unknown>): string[] {
  return Array.isArray(plan.conflicts) ? plan.conflicts.filter((item): item is string => typeof item === "string") : [];
}

function mergeWriteCount(changeSet: ChangeSet, resource: ChangeSet["writeSet"][number]["resource"]): number {
  return changeSet.writeSet.filter(entry => entry.resource === resource).length;
}

export function NativeChangeSetReview({ projectId, canWrite = true, onApplied, onOpenSource }: {
  projectId: string;
  canWrite?: boolean;
  onApplied: () => void;
  onOpenSource?: (anchor: SaveEvidenceAnchorCommand, quote: string) => Promise<void>;
}) {
  const [changeSets, setChangeSets] = useState<ChangeSet[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sourceQuote, setSourceQuote] = useState<{ key: string; quote: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const sequence = useRef(0);
  const applyVersions = useRef(new Map<string, number>());
  const selectedIdRef = useRef(selectedId);
  const projectIdRef = useRef(projectId);
  selectedIdRef.current = selectedId;
  projectIdRef.current = projectId;

  const load = useCallback(async (signal?: AbortSignal, requestedId?: string) => {
    const currentSequence = ++sequence.current;
    setLoading(true);
    setMessage("");
    setDetail(null);
    setSourceQuote(null);
    try {
      const result = await api.nativeChangeSets(projectId, 100, signal);
      if (signal?.aborted || sequence.current !== currentSequence) return;
      if (result.changeSets.some((item) => item.projectId !== projectId)) throw new Error("ChangeSetの作品スコープが一致しません。");
      setChangeSets(result.changeSets);
      const nextId = requestedId && result.changeSets.some((item) => item.id === requestedId)
        ? requestedId
        : result.changeSets.some((item) => item.id === selectedIdRef.current) ? selectedIdRef.current : result.changeSets[0]?.id ?? "";
      setSelectedId(nextId);
      if (!nextId) setDetail(null);
      else {
        const nextDetail = await api.nativeChangeSet(projectId, nextId, signal);
        if (signal?.aborted || sequence.current !== currentSequence) return;
        if (nextDetail.changeSet.projectId !== projectId || nextDetail.changeSet.id !== nextId) throw new Error("ChangeSet詳細の識別子が一致しません。");
        setDetail(nextDetail);
      }
    } catch (error) {
      if (!signal?.aborted && sequence.current === currentSequence) setMessage(errorText(error));
    } finally {
      if (!signal?.aborted && sequence.current === currentSequence) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setChangeSets([]);
      setSelectedId("");
      setDetail(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setChangeSets([]);
    setSelectedId("");
    setDetail(null);
    void load(controller.signal);
    return () => { controller.abort(); sequence.current += 1; };
  }, [load]);

  const inspect = useCallback(async (id: string) => {
    const currentSequence = ++sequence.current;
    setSelectedId(id);
    setDetail(null);
    setSourceQuote(null);
    setLoading(true);
    setMessage("");
    try {
      const next = await api.nativeChangeSet(projectId, id);
      if (next.changeSet.projectId !== projectId || next.changeSet.id !== id) throw new Error("ChangeSet詳細の識別子が一致しません。");
      if (sequence.current === currentSequence) setDetail(next);
    } catch (error) {
      if (sequence.current === currentSequence) setMessage(errorText(error));
    } finally {
      if (sequence.current === currentSequence) setLoading(false);
    }
  }, [projectId]);

  const updateAfterAction = useCallback(async (id: string, action: "approve" | "reject" | "apply") => {
    const before = detail?.changeSet;
    if (!before || before.id !== id || busy || loading || !canWrite || before.projectId !== projectId) return;
    if (action === "apply" && before.status !== "approved") return;
    setBusy(true);
    setMessage("");
    const requestVersion = action === "apply" ? (applyVersions.current.get(id) ?? before.version) : before.version;
    if (action === "apply") applyVersions.current.set(id, requestVersion);
    let actionError: unknown;
    let projectionRefreshed = false;
    const refreshProjection = () => {
      if (projectionRefreshed) return;
      projectionRefreshed = true;
      onApplied();
    };
    try {
      if (action === "approve") await api.approveNativeChangeSet(projectId, id, requestVersion);
      else if (action === "reject") await api.rejectNativeChangeSet(projectId, id, requestVersion);
      else {
        const applied = await api.applyNativeChangeSet(projectId, id, requestVersion);
        if (!mounted.current || projectIdRef.current !== projectId) return;
        if (applied.changeSet.id !== id || applied.changeSet.projectId !== projectId) throw new Error("適用receiptの識別子が一致しません。");
        applyVersions.current.delete(id);
        setDetail({ changeSet: applied.changeSet, receipt: applied });
        refreshProjection();
      }
    } catch (error) {
      if (!mounted.current || projectIdRef.current !== projectId) return;
      actionError = error;
      setMessage(`${errorText(error)} 結果をサーバーから照合しています。`);
      // A lost response may follow a committed action. Always re-read authoritative state and receipt.
    }
    try {
      const [list, authoritative] = await Promise.all([
        api.nativeChangeSets(projectId, 100),
        api.nativeChangeSet(projectId, id),
      ]);
      if (!mounted.current || projectIdRef.current !== projectId) return;
      if (projectId !== authoritative.changeSet.projectId || authoritative.changeSet.id !== id || list.changeSets.some(item => item.projectId !== projectId)) throw new Error("ChangeSetの作品または提案識別子が一致しません。");
      setChangeSets(list.changeSets);
      setDetail(authoritative);
      if (authoritative.receipt || authoritative.changeSet.status === "applied") {
        applyVersions.current.delete(id);
        refreshProjection();
        setMessage(authoritative.receipt ? "適用receiptを確認しました。正本の状態を再読み込みしました。" : "適用済みの状態を確認しました。receiptは再確認してください。");
      } else if (authoritative.changeSet.status === "approved" && action === "apply") {
        applyVersions.current.set(id, requestVersion);
        setMessage(actionError instanceof ApiError
          ? `${errorText(actionError)} 提案は承認済みのまま保持されています。`
          : "適用receiptはまだ確認できません。再試行は同じChangeSet versionで行います。");
      } else if (action !== "apply" && authoritative.changeSet.status === (action === "approve" ? "approved" : "rejected")) {
        setMessage(action === "approve" ? "承認を確認しました。適用は別の明示操作です。" : "却下を確認しました。正本への変更はありません。");
      }
    } catch (refreshError) {
      if (mounted.current) setMessage(`${errorText(refreshError)} 最新状態の再確認を押してください。`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, loading, canWrite, detail, onApplied, projectId]);

  async function inspectSource(anchor: SaveEvidenceAnchorCommand, key: string) {
    const sourceSequence = sequence.current;
    setSourceQuote(null);
    try {
      const result = await api.persistenceDocument(projectId, anchor.documentId, undefined, anchor.revisionId);
      if (!mounted.current || sequence.current !== sourceSequence) return;
      const revision = result.revision;
      if (!revision || revision.id !== anchor.revisionId || revision.projectId !== projectId || revision.documentId !== anchor.documentId || anchor.fromUtf16 < 0 || anchor.toUtf16 <= anchor.fromUtf16 || anchor.toUtf16 > revision.markdown.length) throw new Error("提案の引用元Revisionまたは範囲を確認できません。");
      const quote = revision.markdown.slice(anchor.fromUtf16, anchor.toUtf16);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(quote)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (!mounted.current || sequence.current !== sourceSequence) return;
      if (digest !== anchor.quoteSha256) throw new Error("引用元のハッシュが提案と一致しません。");
      setSourceQuote({ key, quote });
    } catch (error) { if (mounted.current && sequence.current === sourceSequence) setMessage(errorText(error)); }
  }

  const current = detail?.changeSet;
  return <section className="proposal-review native-changeset-review" aria-labelledby="native-review-title">
    <h2 id="native-review-title">PostgreSQL ChangeSet</h2>
    <p>ネイティブ提案の正本はPostgreSQLです。承認と適用は別の操作です。</p>
    <div className="native-review-toolbar">
      <button type="button" disabled={loading || busy} onClick={() => void load(undefined, selectedId)}>最新状態を再確認</button>
      {loading && <span role="status">ChangeSetを読み込んでいます。</span>}
    </div>
    {message && <p role="alert">{message}</p>}
    {changeSets.length === 0 && !loading ? <p>この作品にネイティブ提案はありません。</p> : <ul className="proposal-list native-changeset-list">
      {changeSets.map((item) => <li key={item.id}>
        <button type="button" className="native-changeset-select" aria-pressed={selectedId === item.id} onClick={() => void inspect(item.id)} disabled={busy}>
          <strong>{statusLabel(item.status)}</strong><span><code>{item.id}</code></span><small>{item.provenance.source} · v{item.version}</small>
        </button>
      </li>)}
    </ul>}
    {current && <article className="proposal-card native-changeset-card">
      <header><strong>{statusLabel(current.status)}</strong><span>{current.provenance.source}</span></header>
      <p>提案ID: <code>{current.id}</code> · actor: <code>{current.provenance.actorId ?? current.authorId}</code> · origin: {current.provenance.details.origin === "external-agent" ? "external-agent" : "author"}</p>
      <p>提案時の作品version: <code>{sourceProjectVersion(current)}</code> · ChangeSet version: <code>{current.version}</code></p>
      <p>作成: <time dateTime={current.createdAt}>{current.createdAt}</time></p>
      <h3>操作内容（{current.operations.length}）</h3>
      {current.operations.map((operation, index) => <section className="proposal-operation" key={`${operation.type}:${index}`}>
        <h4>{operation.type}</h4>
        {operation.type === "knowledge.merge" ? <section aria-label="Knowledge merge proposal">
          <p><strong>{mergePlanName(operation.command.plan, "source")}</strong> (<code>{operation.command.sourceId}</code>) → <strong>{mergePlanName(operation.command.plan, "target")}</strong> (<code>{operation.command.targetId}</code>)</p>
          <p>Preview snapshot: <code>{operation.command.projectVersion}</code> · Digest: <code>{operation.command.previewDigest}</code></p>
          <p>実際の書き込み対象: 別名 {mergeWriteCount(current, "knowledge_alias")} 件 · 関係 {mergeWriteCount(current, "knowledge_relation")} 件 · 根拠リンク {mergeWriteCount(current, "mention_link")} 件 · 命題 {mergeWriteCount(current, "assertion")} 件</p>
          <p>Audit ID: <code>{operation.command.auditId}</code> · 生成別名 ID: <code>{operation.command.generatedAliasId}</code></p>
          {mergePlanConflicts(operation.command.plan).length > 0
            ? <div role="alert"><strong>競合</strong><ul>{mergePlanConflicts(operation.command.plan).map(conflict => <li key={conflict}>{conflict}</li>)}</ul></div>
            : <p>Preview conflicts: なし</p>}
          <details><summary>統合計画と対象リソースを確認</summary><pre>{JSON.stringify(operation.command.plan, null, 2)}</pre></details>
        </section> : <pre>{JSON.stringify(operation.command, null, 2)}</pre>}
        {operation.type === "evidence.anchor.save" && <>
          <button type="button" disabled={busy || loading} onClick={() => void inspectSource(operation.command, `${current.id}:${index}`)}>引用元Revisionを確認</button>
          {sourceQuote?.key === `${current.id}:${index}` && <div><q>{sourceQuote.quote}</q><p>Revision: <code>{operation.command.revisionId}</code> · {operation.command.status}</p>{onOpenSource && <button type="button" onClick={() => void onOpenSource(operation.command, sourceQuote.quote).catch(error => setMessage(errorText(error)))}>原稿で確認</button>}</div>}
        </>}
      </section>)}
      <h3>読み取り前提</h3><pre>{JSON.stringify(current.readSet, null, 2)}</pre>
      <h3>書き込み対象</h3><pre>{JSON.stringify(current.writeSet, null, 2)}</pre>
      {current.status === "applied" && detail?.receipt && <section aria-label="適用receipt">
        <h3>適用receipt</h3><p>replayed: {detail.receipt.replayed ? "はい" : "いいえ"}</p><pre>{JSON.stringify(detail.receipt, null, 2)}</pre>
      </section>}
      {current.status === "applied" && !detail?.receipt && <p role="status">適用済みです。receiptを取得できませんでした。最新状態を再確認してください。</p>}
      <div className="proposal-actions">
        {current.status === "proposed" && <>
          <button type="button" disabled={!canWrite || busy || loading} onClick={() => void updateAfterAction(current.id, "approve")}>{!canWrite ? "閲覧専用" : busy ? "処理中…" : "承認する"}</button>
          <button type="button" className="quiet-button" disabled={!canWrite || busy || loading} onClick={() => void updateAfterAction(current.id, "reject")}>却下する</button>
        </>}
        {current.status === "approved" && <>
          <p>承認済みです。適用まではPostgreSQLの正本は変更されません。</p>
          <button type="button" disabled={!canWrite || busy || loading} onClick={() => void updateAfterAction(current.id, "apply")}>{!canWrite ? "閲覧専用" : busy ? "適用結果を照合中…" : "承認済み提案を適用"}</button>
        </>}
      </div>
    </article>}
  </section>;
}
