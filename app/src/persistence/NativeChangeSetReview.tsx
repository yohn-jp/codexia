import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeSet, ChangeSetApplicationResult, ChangeSetOperation, SaveEvidenceAnchorCommand } from "@codexia/persistence-contracts";
import { ApiError } from "../api-error";
import { api } from "../api";
import "./NativeChangeSetReview.css";

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

type ReviewField = { label: string; value: unknown };

function operationLabel(operation: ChangeSetOperation): string {
  switch (operation.type) {
    case "document.update": return "文書の情報を更新";
    case "document.delete": return "文書を削除";
    case "module.record.save": return "モジュール記録を更新";
    case "document.create": return "文書を作成";
    case "document.save": return "原稿を変更";
    case "document.restore": return "原稿Revisionを復元";
    case "knowledge.node.save": return "知識を更新";
    case "knowledge.alias.save": return "別名を登録";
    case "knowledge.relation.save": return "関係を登録";
    case "evidence.anchor.save": return "引用根拠を登録";
    case "evidence.mention.save": return "根拠と知識を結ぶ";
    case "evidence.assertion.save": return "命題を更新";
    case "evidence.assertion.link": return "命題と根拠を結ぶ";
    case "knowledge.merge": return "知識を統合";
    default: return "未対応の操作";
  }
}

function operationTarget(operation: ChangeSetOperation): string {
  switch (operation.type) {
    case "document.update":
    case "document.delete":
    case "document.save":
    case "document.restore":
      return operation.command.documentId;
    case "document.create":
      return operation.command.title;
    case "module.record.save":
      return operation.command.moduleId + " · " + operation.command.key;
    case "knowledge.node.save":
      return operation.command.name || operation.command.id;
    case "knowledge.alias.save":
      return operation.command.surface || operation.command.nodeId;
    case "knowledge.relation.save":
      return operation.command.sourceId + " → " + operation.command.targetId;
    case "evidence.anchor.save":
      return "原稿 " + operation.command.documentId;
    case "evidence.mention.save":
      return "知識 " + operation.command.nodeId;
    case "evidence.assertion.save":
      return operation.command.id;
    case "evidence.assertion.link":
      return operation.command.assertionId;
    case "knowledge.merge":
      return mergePlanName(operation.command.plan, "source") + " → " + mergePlanName(operation.command.plan, "target");
    default:
      return "対象を確認できません";
  }
}

function operationFields(operation: ChangeSetOperation): ReviewField[] {
  switch (operation.type) {
    case "document.update":
      return [
        ...(operation.command.title !== undefined ? [{ label: "文書名", value: operation.command.title }] : []),
        ...(operation.command.parentId !== undefined ? [{ label: "親文書", value: operation.command.parentId ?? "なし" }] : []),
        ...(operation.command.orderKey !== undefined ? [{ label: "並び順", value: operation.command.orderKey }] : []),
      ];
    case "document.delete":
      return [{ label: "文書ID", value: operation.command.documentId }];
    case "module.record.save":
      return [
        { label: "モジュール", value: operation.command.moduleId },
        { label: "記録キー", value: operation.command.key },
        { label: "変更後の値", value: operation.command.value },
      ];
    case "document.create":
      return [
        { label: "文書名", value: operation.command.title },
        { label: "文書種別", value: operation.command.kind },
        { label: "親文書", value: operation.command.parentId ?? "なし" },
      ];
    case "document.save":
      return [
        { label: "変更箇所", value: operation.command.changes.length + "件" },
        { label: "基準Revision", value: operation.command.baseRevisionId },
      ];
    case "document.restore":
      return [
        { label: "現在の基準Revision", value: operation.command.baseRevisionId },
        { label: "復元元Revision", value: operation.command.sourceRevisionId },
      ];
    case "knowledge.node.save":
      return [
        { label: "名前", value: operation.command.name },
        { label: "種類", value: operation.command.type },
        { label: "状態", value: operation.command.status },
        { label: "属性", value: operation.command.attributes },
      ];
    case "knowledge.alias.save":
      return [
        { label: "別名", value: operation.command.surface },
        { label: "対象の知識ID", value: operation.command.nodeId },
        { label: "適用範囲", value: operation.command.scope ?? "指定なし" },
        { label: "状態", value: operation.command.status },
      ];
    case "knowledge.relation.save":
      return [
        { label: "関係元", value: operation.command.sourceId },
        { label: "関係先", value: operation.command.targetId },
        { label: "関係の種類", value: operation.command.type },
        { label: "状態", value: operation.command.status },
        { label: "有効範囲", value: operation.command.validity },
      ];
    case "evidence.anchor.save":
      return [
        { label: "文書ID", value: operation.command.documentId },
        { label: "Revision", value: operation.command.revisionId },
        { label: "引用範囲", value: operation.command.fromUtf16 + "–" + operation.command.toUtf16 },
        { label: "状態", value: operation.command.status },
      ];
    case "evidence.mention.save":
      return [
        { label: "根拠ID", value: operation.command.evidenceId },
        { label: "知識ID", value: operation.command.nodeId },
        { label: "抽出元", value: operation.command.source },
        { label: "確度", value: operation.command.confidence },
        { label: "状態", value: operation.command.status },
      ];
    case "evidence.assertion.save":
      return [
        { label: "命題", value: operation.command.proposition },
        { label: "種別", value: ({ fact: "世界の事実", belief: "人物の認識", disclosure: "読者への開示", hypothesis: "仮説" } as Record<string, string>)[operation.command.modality] ?? operation.command.modality },
        { label: "確度", value: operation.command.confidence },
        { label: "視点", value: operation.command.perspective },
        { label: "物語上の時間", value: operation.command.narrativeTime },
        { label: "状態", value: operation.command.status },
      ];
    case "evidence.assertion.link":
      return [
        { label: "命題ID", value: operation.command.assertionId },
        { label: "根拠ID", value: operation.command.evidenceId },
        { label: "根拠の役割", value: operation.command.role },
      ];
    case "knowledge.merge":
      return [
        { label: "統合元", value: mergePlanName(operation.command.plan, "source") },
        { label: "統合先", value: mergePlanName(operation.command.plan, "target") },
        { label: "Preview snapshot", value: operation.command.projectVersion },
        { label: "Preview digest", value: operation.command.previewDigest },
      ];
    default:
      return [];
  }
}

function versionValue(operation: ChangeSetOperation): number | null | undefined {
  const command = operation.command as unknown as { expectedVersion?: unknown };
  return command.expectedVersion === null || typeof command.expectedVersion === "number"
    ? command.expectedVersion
    : undefined;
}

function beforeSummary(operation: ChangeSetOperation): string {
  if (operation.type === "document.create") return "新規文書";
  const version = versionValue(operation);
  if (version === null) return "新規登録";
  if (typeof version === "number") return "変更前の値は提案に含まれていません（version " + version + "）";
  if (operation.type === "document.save") return "基準Revisionの本文を取得して照合します";
  if (operation.type === "document.restore") return "基準Revisionの本文を取得して照合します";
  return "変更前を確認できません";
}

function readableValue(value: unknown): string {
  if (value === null) return "未設定";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value, null, 2); } catch { return "値を表示できません"; }
}

function dateLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString("ja-JP");
}

function applyTextChanges(markdown: string, changes: readonly { fromUtf16: number; toUtf16: number; insert: string }[]): string | null {
  let next = markdown;
  let previousStart = markdown.length + 1;
  for (const change of [...changes].reverse()) {
    if (!Number.isSafeInteger(change.fromUtf16) || !Number.isSafeInteger(change.toUtf16) ||
      change.fromUtf16 < 0 || change.toUtf16 < change.fromUtf16 || change.toUtf16 > markdown.length ||
      change.toUtf16 > previousStart) return null;
    next = next.slice(0, change.fromUtf16) + change.insert + next.slice(change.toUtf16);
    previousStart = change.fromUtf16;
  }
  return next;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function DocumentBodyReview({ projectId, operation }: { projectId: string; operation: ChangeSetOperation }) {
  const [result, setResult] = useState<{ before: string; after: string } | { error: string } | null>(null);
  useEffect(() => {
    if (operation.type !== "document.save" && operation.type !== "document.restore") return;
    const controller = new AbortController();
    setResult(null);
    const load = async () => {
      try {
        if (operation.type === "document.save") {
          const command = operation.command;
          const base = await api.persistenceDocument(projectId, command.documentId, controller.signal, command.baseRevisionId);
          const revision = base.revision;
          if (!revision || revision.id !== command.baseRevisionId || revision.projectId !== projectId || revision.documentId !== command.documentId) {
            throw new Error("基準Revisionの識別子を照合できません。");
          }
          const after = applyTextChanges(revision.markdown, command.changes);
          if (after === null) throw new Error("変更範囲を基準Revisionに照合できません。");
          if (await sha256(after) !== command.resultingSha256) throw new Error("変更後本文のハッシュが提案と一致しません。");
          if (!controller.signal.aborted) setResult({ before: revision.markdown, after });
        } else {
          const command = operation.command;
          const [base, source] = await Promise.all([
            api.persistenceDocument(projectId, command.documentId, controller.signal, command.baseRevisionId),
            api.persistenceDocument(projectId, command.documentId, controller.signal, command.sourceRevisionId),
          ]);
          if (base.revision?.id !== command.baseRevisionId || base.revision.projectId !== projectId || base.revision.documentId !== command.documentId ||
            source.revision?.id !== command.sourceRevisionId || source.revision.projectId !== projectId || source.revision.documentId !== command.documentId) {
            throw new Error("復元元または基準Revisionの識別子を照合できません。");
          }
          if (!controller.signal.aborted) setResult({ before: base.revision.markdown, after: source.revision.markdown });
        }
      } catch (cause) {
        if (!controller.signal.aborted) setResult({ error: cause instanceof Error ? cause.message : "Revisionを確認できません。" });
      }
    };
    void load();
    return () => controller.abort();
  }, [projectId, operation]);

  if (operation.type === "document.create") {
    return <details className="native-review-body-copy">
      <summary>作成される本文を確認</summary>
      <pre>{operation.command.markdown}</pre>
    </details>;
  }
  if (operation.type === "document.save") {
    if (result && "error" in result) return <p className="native-review-unknown">変更前を確認できません。{result.error}</p>;
    if (!result) return <p className="native-review-pending">基準Revisionを照合しています。</p>;
    return <div className="native-review-diff-list" aria-label="検証済み原稿差分">
      {operation.command.changes.map((change, index) => (
        <div className="native-review-diff-row" key={index}>
          <div><h5>変更前</h5><pre>{result.before.slice(change.fromUtf16, change.toUtf16) || "（この位置に本文はありません）"}</pre></div>
          <div><h5>変更後</h5><pre>{change.insert || "（この範囲を削除）"}</pre></div>
        </div>
      ))}
    </div>;
  }
  if (operation.type === "document.restore") {
    if (result && "error" in result) return <p className="native-review-unknown">復元する本文を確認できません。{result.error}</p>;
    if (!result) return <p className="native-review-pending">基準と復元元のRevisionを照合しています。</p>;
    return <div className="native-review-diff-row native-review-revision-bodies">
      <details><summary>変更前の本文</summary><pre>{result.before}</pre></details>
      <details><summary>復元後の本文</summary><pre>{result.after}</pre></details>
    </div>;
  }
  return null;
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
  const firstOperation = current?.operations[0];
  return <section className="proposal-review native-changeset-review" aria-labelledby="native-review-title">
    <header className="native-review-masthead">
      <div>
        <p className="native-review-kicker">CHANGE REVIEW / POSTGRESQL</p>
        <h2 id="native-review-title">PostgreSQL ChangeSet</h2>
        <p className="native-review-intro">提案内容と対象を確認します。承認しても正本には反映されず、適用は別の操作です。</p>
      </div>
      <div className="native-review-total" aria-label={"この作品の取得済み提案 " + changeSets.length + " 件"}>
        <strong>{changeSets.length.toString().padStart(2, "0")}</strong>
        <span>取得済み提案</span>
      </div>
    </header>
    <div className="native-review-toolbar">
      <span>この作品の変更記録</span>
      <button type="button" className="native-review-refresh" disabled={loading || busy} onClick={() => void load(undefined, selectedId)}>最新状態を再確認</button>
      {loading && <span role="status">ChangeSetを読み込んでいます。</span>}
    </div>
    {message && <p className="native-review-message" role="alert">{message}</p>}
    {changeSets.length === 0 && !loading
      ? <div className="native-review-empty"><span aria-hidden="true">—</span><h3>この作品にネイティブ提案はありません。</h3><p>承認待ちや適用済みの変更が届くと、ここに表示されます。</p></div>
      : <div className="native-review-layout">
        <aside className="native-review-queue" aria-label="ネイティブ提案一覧">
          <div className="native-review-queue-heading"><h3>提案一覧</h3><span>{changeSets.length}件</span></div>
          <ul className="proposal-list native-changeset-list">
            {changeSets.map((item) => {
              const operation = item.operations[0];
              const headline = operation ? operationLabel(operation) : "内容を確認できません";
              const target = operation ? operationTarget(operation) : "提案payloadを確認してください";
              return <li key={item.id}>
                <button type="button" className="native-changeset-select" data-status={item.status} aria-pressed={selectedId === item.id} onClick={() => void inspect(item.id)} disabled={busy}>
                  <span className="native-review-row-meta"><span>POSTGRESQL</span><span className={"native-review-state is-" + item.status}>{statusLabel(item.status)}</span></span>
                  <strong>{headline}</strong>
                  <span className="native-review-row-target">{target}</span>
                  <small>{item.provenance.source} · {item.operations.length}件の操作 · version {item.version}</small>
                  <span className="native-review-id-token" aria-hidden="true">{item.id}</span>
                </button>
              </li>;
            })}
          </ul>
        </aside>
        <div className="native-review-detail">
          {!current
            ? loading ? <p className="native-review-pending" role="status">選択したChangeSetの詳細を取得しています。</p> : <p className="native-review-unknown">提案の詳細を取得できません。最新状態を再確認してください。</p>
            : <article className="proposal-card native-changeset-card">
              <header className="native-review-detail-header">
                <div>
                  <div className="native-review-detail-meta">
                    <span className={"native-review-state is-" + current.status}>{statusLabel(current.status)}</span>
                    <span>POSTGRESQL CHANGESET</span>
                  </div>
                  <h3>{firstOperation ? operationLabel(firstOperation) : "提案内容を確認できません"}</h3>
                  {firstOperation && <p className="native-review-target">{operationTarget(firstOperation)}</p>}
                </div>
                <div className="native-review-created"><span>作成</span><time dateTime={current.createdAt}>{dateLabel(current.createdAt)}</time></div>
              </header>
              <div className="native-review-facts">
                <p><span>提案元</span><strong>{current.provenance.source}</strong></p>
                <p><span>適用先</span><strong>この作品のPostgreSQL正本</strong></p>
                <p><span>変更件数</span><strong>{current.operations.length}件</strong></p>
              </div>
              <section className="native-review-changes" aria-labelledby="native-review-changes-title">
                <div className="native-review-section-heading"><h4 id="native-review-changes-title">変更内容</h4><span>{current.operations.length.toString().padStart(2, "0")} OPERATIONS</span></div>
                {current.operations.length === 0 && <p className="native-review-unknown">提案に操作が含まれていないため、変更内容を確認できません。</p>}
                {current.operations.map((operation, index) => <section className="proposal-operation native-review-operation" key={operation.type + ":" + index}>
                  <div className="native-review-operation-heading">
                    <span className="native-review-operation-number">{String(index + 1).padStart(2, "0")}</span>
                    <div><h5>{operationLabel(operation)}</h5><p>{operationTarget(operation)}</p></div>
                  </div>
                  <div className="native-review-diff-overview">
                    <div><span>変更前</span><p>{beforeSummary(operation)}</p></div>
                    <span className="native-review-diff-arrow" aria-hidden="true">→</span>
                    <div><span>変更後</span><dl className="native-review-fields">
                      {operationFields(operation).map((field) => <div key={field.label}>
                        <dt>{field.label}</dt><dd>{typeof field.value === "object" && field.value !== null
                          ? <pre>{readableValue(field.value)}</pre>
                          : readableValue(field.value)}</dd>
                      </div>)}
                    </dl></div>
                  </div>
                  <DocumentBodyReview projectId={projectId} operation={operation} />
                  {operation.type === "knowledge.merge" && <section className="native-review-merge" aria-label="Knowledge merge proposal">
                    <p><strong>{mergePlanName(operation.command.plan, "source")}</strong> (<code>{operation.command.sourceId}</code>) → <strong>{mergePlanName(operation.command.plan, "target")}</strong> (<code>{operation.command.targetId}</code>)</p>
                    <p>Preview snapshot: <code>{operation.command.projectVersion}</code> · Digest: <code>{operation.command.previewDigest}</code></p>
                    <p>実際の書き込み対象: 別名 {mergeWriteCount(current, "knowledge_alias")} 件 · 関係 {mergeWriteCount(current, "knowledge_relation")} 件 · 根拠リンク {mergeWriteCount(current, "mention_link")} 件 · 命題 {mergeWriteCount(current, "assertion")} 件</p>
                    {mergePlanConflicts(operation.command.plan).length > 0
                      ? <div role="alert"><strong>競合</strong><ul>{mergePlanConflicts(operation.command.plan).map(conflict => <li key={conflict}>{conflict}</li>)}</ul></div>
                      : <p>Preview conflicts: なし</p>}
                    <details><summary>統合計画と対象リソースを確認</summary><pre>{JSON.stringify(operation.command.plan, null, 2)}</pre></details>
                  </section>}
                  {operation.type === "evidence.anchor.save" && <div className="native-review-evidence">
                    <button type="button" className="quiet-button" disabled={busy || loading} onClick={() => void inspectSource(operation.command, current.id + ":" + index)}>引用元Revisionを確認</button>
                    {sourceQuote?.key === current.id + ":" + index && <div className="native-review-quote"><q>{sourceQuote.quote}</q><p>Revision: <code>{operation.command.revisionId}</code> · {operation.command.status}</p>{onOpenSource && <button type="button" className="quiet-button" onClick={() => void onOpenSource(operation.command, sourceQuote.quote).catch(error => setMessage(errorText(error)))}>原稿で確認</button>}</div>}
                  </div>}
                  <details className="native-review-operation-payload"><summary>操作payloadと期待versionを確認</summary><pre>{JSON.stringify(operation.command, null, 2)}</pre></details>
                </section>)}
              </section>
              <details className="native-review-technical">
                <summary>read set・write set・作成元を確認</summary>
                <div className="native-review-technical-grid">
                  <section><h4>読み取り前提</h4><pre>{JSON.stringify(current.readSet, null, 2)}</pre></section>
                  <section><h4>書き込み対象</h4><pre>{JSON.stringify(current.writeSet, null, 2)}</pre></section>
                  <section><h4>作成元と権限</h4><pre>{JSON.stringify({
                    id: current.id,
                    projectId: current.projectId,
                    authorId: current.authorId,
                    actorId: current.provenance.actorId,
                    origin: current.provenance.details.origin === "external-agent" ? "external-agent" : "author",
                    source: current.provenance.source,
                    projectVersion: sourceProjectVersion(current),
                    version: current.version,
                    createdAt: current.createdAt,
                    approvedAt: current.approvedAt,
                    approvedBy: current.approvedBy,
                    rejectedAt: current.rejectedAt,
                    rejectedBy: current.rejectedBy,
                  }, null, 2)}</pre></section>
                </div>
              </details>
              {current.status === "applied" && detail?.receipt && <section className="native-review-receipt" aria-label="適用receipt">
                <div className="native-review-section-heading"><h4>適用receipt</h4><span>{detail.receipt.replayed ? "再確認" : "適用結果"}</span></div>
                <p>正本への適用結果をサーバーのreceiptで確認しました。</p>
                <pre>{JSON.stringify(detail.receipt, null, 2)}</pre>
              </section>}
              {current.status === "applied" && !detail?.receipt && <p className="native-review-unknown" role="status">適用済みの状態を確認しましたが、receiptを取得できませんでした。最新状態を再確認してください。</p>}
              <div className="proposal-actions native-review-actions">
                {current.status === "proposed" && <>
                  <p>承認後も正本は変わりません。適用前に同じ提案の内容とversionを再確認します。</p>
                  <button type="button" disabled={!canWrite || busy || loading} onClick={() => void updateAfterAction(current.id, "approve")}>{!canWrite ? "閲覧専用" : busy ? "処理中…" : "承認する"}</button>
                  <button type="button" className="quiet-button" disabled={!canWrite || busy || loading} onClick={() => void updateAfterAction(current.id, "reject")}>却下する</button>
                </>}
                {current.status === "approved" && <>
                  <p>承認済みです。適用まではPostgreSQLの正本は変更されません。</p>
                  <button type="button" disabled={!canWrite || busy || loading} onClick={() => void updateAfterAction(current.id, "apply")}>{!canWrite ? "閲覧専用" : busy ? "適用結果を照合中…" : "承認済み提案を適用"}</button>
                </>}
              </div>
            </article>}
        </div>
      </div>}
  </section>;

}
