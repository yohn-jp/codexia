import { useState } from "react";
import type { ChangeOperation, ProposalStatus } from "@codexia/contracts";
import { api } from "../api";
import { BrowserJournal, proposalOperationEntry, stableJson, type JournalEntry, type JournalProposal } from "../storage/journal";
import "./ProposalReview.css";

function operationKey(operation: ChangeOperation): string {
  return operation.id + "\u0000" + operation.generation;
}

function applicationFor(status: ProposalStatus | undefined, operation: ChangeOperation) {
  return status?.applications.find((receipt) => receipt.operationId === operation.id && receipt.generation === operation.generation);
}

function effectLabel(effect: ChangeOperation["effect"]): string {
  return ({
    manuscript: "原稿",
    structure: "作品構成",
    metadata: "作品情報",
    settings: "設定",
    migration: "移行",
  })[effect];
}

function proposalSourceLabel(source: JournalProposal["proposal"]["source"]): string {
  if (source === "author") return "作者の提案";
  if (source === "module") return "モジュールの提案";
  return "外部ツールの提案";
}

function beforeFileSummary(operation: ChangeOperation, path: string): string {
  const read = operation.reads.find((item) => item.path === path);
  if (!read) return "変更前を示すread setがありません。";
  if (read.revision === null) return "基準snapshotに存在しない新規ファイルです。";
  return "変更前の本文は提案に含まれていません（基準revision: " + read.revision + "）。現在の本文を変更前として表示しません。";
}

function fileChangeLabel(operation: ChangeOperation, path: string, content: string | null): string {
  if (content === null) return "削除";
  const read = operation.reads.find((item) => item.path === path);
  if (read?.revision === null) return "新規作成";
  return read ? "更新" : "変更前不明";
}

function dateLabel(value: number): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "日時を確認できません" : parsed.toLocaleString("ja-JP");
}

export function ProposalReview({
  projectId,
  authorScope,
  journal,
  proposals,
  canWrite = true,
  onChange,
  onStatus,
}: {
  projectId: string;
  authorScope: string;
  journal: BrowserJournal;
  proposals: JournalProposal[];
  canWrite?: boolean;
  onChange: () => void;
  onStatus: (message: string, kind?: "normal" | "error" | "success") => void;
}) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  async function approve(record: JournalProposal): Promise<void> {
    if (!canWrite || busyId || record.authorScope !== authorScope) return;
    setBusyId(record.proposal.id);
    setError("");
    try {
      const pending = await journal.getProject(projectId, authorScope);
      let status = record.status;
      if (status?.payloadComplete === false) {
        const originalIds = status.operationIds ?? [];
        const localIds = record.proposal.operations.map((operation) => operation.id);
        if (JSON.stringify(localIds) !== JSON.stringify(originalIds)) {
          throw new Error("PostgreSQLの提案記録には承認済み操作だけがあり、未承認の元提案はこのブラウザー回復記録にありません。未承認分を復元できません。");
        }
        const restored = await api.propose(projectId, record.proposal);
        if (stableJson(restored) !== stableJson(record.proposal)) {
          throw new Error("PostgreSQLに保存された元の提案がブラウザー回復記録と一致しません。");
        }
        const latest = (await api.proposalStatuses(projectId)).proposals.find((item) => item.proposal.id === record.proposal.id);
        if (!latest || latest.payloadComplete === false || stableJson(latest.proposal) !== stableJson(record.proposal)) {
          throw new Error("元の提案をPostgreSQLに復元できませんでした。提案はブラウザー回復記録に保持しています。");
        }
        await journal.putProposal(projectId, authorScope, record.proposal, latest);
        status = latest;
      }
      const published = new Set(status?.appliedOperationIds ?? []);
      const alreadyApproved = new Set(status?.approvedOperationIds ?? []);
      const entries: JournalEntry[] = [];
      const needsApproval: string[] = [];
      for (const operation of record.proposal.operations) {
        if (published.has(operation.id) || applicationFor(status, operation)) continue;
        const current = pending.find((entry) => entry.operation.id === operation.id && entry.operation.generation === operation.generation);
        const entry = current ?? proposalOperationEntry(projectId, authorScope, record.proposal, operation);
        // Persist the exact operation and author scope before either approval or applicationing.
        await journal.put(entry);
        const authorized = await journal.updateState({
          ...entry,
          proposalId: record.proposal.id,
          authorizedAt: entry.authorizedAt ?? Date.now(),
        }, "applying");
        entries.push(authorized);
        if (!alreadyApproved.has(operation.id)) needsApproval.push(operation.id);
      }
      if (entries.length === 0) {
        onStatus("この提案の操作はすでに PostgreSQL Revision 済みです。保存結果は確認済みです。", "normal");
        onChange();
        return;
      }
      if (needsApproval.length > 0) {
        await api.approve(projectId, {
          proposalId: record.proposal.id,
          operationIds: needsApproval,
          authorScope,
        });
      }
      for (const entry of entries) {
        const receipt = await api.apply(projectId, entry.operation);
        await journal.updateState(entry, "applied", receipt);
      }
      onStatus("確認した操作をPostgreSQL Revision に保存しました。保存結果を確認しました。", "success");
      onChange();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "提案を処理できませんでした。";
      setError(message);
      onStatus("提案はブラウザー回復記録に保持されています。" + message, "error");
      onChange();
    } finally {
      setBusyId("");
    }
  }

  async function dismiss(record: JournalProposal): Promise<void> {
    if (busyId || record.authorScope !== authorScope || !window.confirm("この提案をこのブラウザーの一覧から隠しますか？PostgreSQL上の提案は保持され、却下されません。")) return;
    setBusyId(record.proposal.id);
    setError("");
    try {
      const status = record.status;
      if ((status?.approvedOperationIds.length ?? 0) > 0 || (status?.applications.length ?? 0) > 0) {
        throw new Error("承認済みまたは PostgreSQL Revision 済みの提案は一覧から隠せません。");
      }
      const pending = await journal.getProject(projectId, authorScope);
      const authorized = record.proposal.operations.some((operation) => pending.some((entry) =>
        entry.operation.id === operation.id && entry.operation.generation === operation.generation && entry.state !== "draft",
      ));
      if (authorized) throw new Error("承認処理が始まった提案は一覧から隠せません。");
      await journal.dismissProposal(projectId, authorScope, record.proposal.id);
      onStatus("提案をこのブラウザーの一覧から隠しました。PostgreSQL上の提案記録は保持しています（却下ではありません）。", "success");
      onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提案を隠せませんでした。");
    } finally {
      setBusyId("");
    }
  }

  if (proposals.length === 0) return null;
  return (
    <section className="proposal-review module-proposal-review" aria-labelledby="proposal-review-title">
      <header className="module-review-masthead">
        <div>
          <p className="module-review-kicker">MODULE CONTRIBUTIONS / AUTHOR REVIEW</p>
          <h2 id="proposal-review-title">確認待ちの提案</h2>
          <p>提案元、変更対象、根拠、状態を確認してから処理します。承認操作は適用まで続けて行います。</p>
        </div>
        <div className="module-review-count" aria-label={"取得済み提案 " + proposals.length + " 件"}>
          <strong>{proposals.length.toString().padStart(2, "0")}</strong><span>件</span>
        </div>
      </header>
      <p className="module-review-authority-note">作者承認後、既存のAPIが各操作をPostgreSQL Revisionへ適用します。この提案経路にはサーバー側の却下APIがありません。「このブラウザーの一覧から隠す」は却下ではなく、PostgreSQL上の提案を保持します。</p>
      {error && <p className="status module-review-error" data-kind="error" role="alert">{error}</p>}
      <ul className="proposal-list module-proposal-list">
        {proposals.map((record) => {
          const status = record.status;
          const published = new Set(status?.appliedOperationIds ?? []);
          const pendingOperations = record.proposal.operations.filter((operation) =>
            !published.has(operation.id) && !applicationFor(status, operation),
          );
          const originalIds = status?.operationIds ?? record.proposal.operations.map((operation) => operation.id);
          const fullOriginalAvailable = status?.payloadComplete !== false ||
            JSON.stringify(record.proposal.operations.map((operation) => operation.id)) === JSON.stringify(originalIds);
          const unacceptedPayloadMissing = status?.payloadComplete === false && !fullOriginalAvailable;
          const needsApproval = pendingOperations.some((operation) => !status?.approvedOperationIds.includes(operation.id));
          const approvedPendingCount = pendingOperations.filter((operation) => status?.approvedOperationIds.includes(operation.id)).length;
          const completed = pendingOperations.length === 0 && !unacceptedPayloadMissing;
          const stateLabel = unacceptedPayloadMissing
            ? "未承認内容を確認できません"
            : completed
              ? "PostgreSQL Revision済み"
              : needsApproval && approvedPendingCount > 0
                ? "一部承認済み"
                : needsApproval
                  ? "承認待ち"
                  : "承認済み・PostgreSQL Revision待ち";
          return (
            <li key={record.proposal.id}>
              <article className="proposal-card module-proposal-card">
                <header className="module-proposal-heading">
                  <div>
                    <p className="module-proposal-origin">{proposalSourceLabel(record.proposal.source)}</p>
                    <h3>{record.proposal.operations[0]?.message || "変更内容を確認できません"}</h3>
                  </div>
                  <time dateTime={new Date(record.createdAt).toISOString()}>{dateLabel(record.createdAt)}</time>
                </header>
                <div className="module-proposal-summary">
                  <span className={"module-proposal-state" + (unacceptedPayloadMissing || status?.stale ? " is-attention" : completed ? " is-complete" : "")}>{stateLabel}</span>
                  <span>{record.proposal.operations.length}件の操作</span>
                  <span>適用先: PostgreSQL Revision</span>
                </div>
                {status?.stale && <p className="status module-proposal-warning" data-kind="error" role="status">提案の基準snapshotが現在の状態より古い可能性があります。適用前にPostgreSQLがread setとrevisionを再確認します。</p>}
                {unacceptedPayloadMissing
                  ? <p className="status module-proposal-warning" data-kind="error" role="alert">PostgreSQL側の提案記録に未承認操作がなく、完全な元提案をブラウザー回復記録から確認できません。未承認分は表示・承認できません。</p>
                  : status?.payloadComplete === false
                    ? <p className="status module-proposal-warning" data-kind="error" role="status">PostgreSQL側の記録には承認済み操作だけがあります。承認前にブラウザー回復記録の完全な提案を照合します。</p>
                    : null}
                <div className="module-proposal-operations">
                  {record.proposal.operations.map((operation, operationIndex) => {
                    const isPublished = published.has(operation.id);
                    const receipt = applicationFor(status, operation);
                    const isApproved = status?.approvedOperationIds.includes(operation.id) ?? false;
                    const operationState = isPublished
                      ? "PostgreSQL 保存済み"
                      : receipt
                        ? "PostgreSQL Revision 済み · " + receipt.projectVersion
                        : isApproved
                          ? "作者承認済み · PostgreSQL Revision 待ち"
                          : "承認待ち";
                    return (
                      <section className="proposal-operation module-proposal-operation" key={operationKey(operation)}>
                        <div className="module-operation-heading">
                          <span className="module-operation-number">{String(operationIndex + 1).padStart(2, "0")}</span>
                          <div>
                            <h4>{operation.message || "操作内容を確認できません"}</h4>
                            <p>{effectLabel(operation.effect)} · {operation.writes.length}件のファイル変更</p>
                          </div>
                          <span className="module-operation-state">{operationState}</span>
                        </div>
                        <ul className="module-change-list">
                          {operation.writes.map((write) => (
                            <li className="module-change-entry" key={write.path}>
                              <div className="module-change-heading">
                                <span className={"module-change-kind" + (write.content === null ? " is-delete" : "")}>{fileChangeLabel(operation, write.path, write.content)}</span>
                                <code>{write.path}</code>
                              </div>
                              <div className="module-change-before"><span>変更前</span><p>{beforeFileSummary(operation, write.path)}</p></div>
                              {write.content === null
                                ? <p className="module-change-after-label"><strong>変更後:</strong> ファイルを削除</p>
                                : <details className="module-change-after">
                                  <summary>変更後の内容を読む</summary>
                                  {write.encoding === "base64"
                                    ? <p>バイナリ内容を含みます。本文をテキストとして表示できません。</p>
                                    : <pre>{write.content}</pre>}
                                </details>}
                            </li>
                          ))}
                        </ul>
                        <details className="module-operation-technical">
                          <summary>operation、snapshot、読み取り前提を確認</summary>
                          <dl>
                            <div><dt>Operation ID</dt><dd><code>{operation.id}</code></dd></div>
                            <div><dt>Generation</dt><dd>{operation.generation}</dd></div>
                            <div><dt>Base project version</dt><dd>{operation.baseProjectVersion}</dd></div>
                            <div><dt>Read set</dt><dd><pre>{JSON.stringify(operation.reads, null, 2)}</pre></dd></div>
                            {operation.readScopes?.length ? <div><dt>Read scopes</dt><dd><pre>{JSON.stringify(operation.readScopes, null, 2)}</pre></dd></div> : null}
                          </dl>
                        </details>
                      </section>
                    );
                  })}
                </div>
                {record.proposal.evidence?.length ? (
                  <details className="module-proposal-evidence">
                    <summary>根拠を確認 · {record.proposal.evidence.length}件</summary>
                    <ul>
                      {record.proposal.evidence.map((evidence) => (
                        <li key={evidence.id}>
                          <p><strong>{evidence.kind}</strong> · {evidence.module}</p>
                          <ul>{evidence.paths.map((path) => <li key={path.path}><code>{path.path}</code><span>revision: {path.revision ?? "新規"}</span></li>)}</ul>
                          <details><summary>根拠の詳細データ</summary><pre>{JSON.stringify(evidence.details, null, 2)}</pre></details>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : <p className="module-proposal-no-evidence">根拠はこの提案に含まれていません。</p>}
                <details className="module-proposal-technical">
                  <summary>提案ID・作者scope・snapshotを確認</summary>
                  <dl>
                    <div><dt>Proposal ID</dt><dd><code>{record.proposal.id}</code></dd></div>
                    <div><dt>Source</dt><dd>{record.proposal.source}</dd></div>
                    <div><dt>Author scope</dt><dd><code>{record.authorScope ?? "未割り当て"}</code></dd></div>
                    <div><dt>Snapshot</dt><dd><code>{JSON.stringify(record.proposal.snapshot)}</code></dd></div>
                    <div><dt>Original digest</dt><dd><code>{status?.originalDigest ?? "記録なし"}</code></dd></div>
                  </dl>
                </details>
                <div className="module-proposal-action-note">
                  <strong>承認とPostgreSQL適用</strong>
                  <p>この操作は未承認の全操作を作者承認し、その後、同じproposal ID・operation ID・generationの結果をPostgreSQLへ適用してreceiptを確認します。承認だけで画面を成功状態にはしません。</p>
                </div>
                <div className="proposal-actions module-proposal-actions">
                  <button type="button" onClick={() => void approve(record)} disabled={!canWrite || Boolean(busyId) || completed || unacceptedPayloadMissing}>
                    {!canWrite ? "閲覧専用" : busyId === record.proposal.id ? "承認内容を保存中…" : unacceptedPayloadMissing ? "未承認分を回復できません" : completed ? "PostgreSQL Revision 完了" : needsApproval ? status?.payloadComplete === false ? "元の提案を照合して承認" : "承認して PostgreSQL Revision" : "承認済みを PostgreSQL Revision"}
                  </button>
                  <button type="button" className="quiet-button" onClick={() => void dismiss(record)} disabled={Boolean(busyId) || unacceptedPayloadMissing || (status?.approvedOperationIds.length ?? 0) > 0 || (status?.applications.length ?? 0) > 0}>
                    このブラウザーの一覧から隠す
                  </button>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
