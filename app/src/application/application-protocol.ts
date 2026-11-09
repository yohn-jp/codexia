import {
  assertChangeOperation,
  type Approval,
  type ChangeOperation,
  type ChangeProposal,
  type ApplyReceipt,
} from "@codexia/contracts";
import {
  assertApplicationReceipt,
  documentKey,
  journalEntryKey,
  projectKey,
  stableJson,
  type BrowserJournal,
  type JournalEntry,
} from "../storage/journal.js";

export interface ApplicationApi {
  propose(projectId: string, proposal: ChangeProposal, signal?: AbortSignal): Promise<ChangeProposal>;
  approve(projectId: string, approval: Approval, signal?: AbortSignal): Promise<void>;
  apply(projectId: string, operation: ChangeOperation, signal?: AbortSignal): Promise<ApplyReceipt>;
}

export type ApplicationJournal = Pick<BrowserJournal, "updateState" | "putProposal" | "removeProposal">;

export interface ApplicationProtocolInput {
  projectId: string;
  authorScope: string;
  entry: JournalEntry;
  api: ApplicationApi;
  journal: ApplicationJournal;
  signal?: AbortSignal;
  onApplying?: (entry: JournalEntry) => void;
}

export class ApplicationConflictError extends Error {
  constructor() {
    super("競合した回復記録は保存できません。");
    this.name = "ApplicationConflictError";
  }
}

function assertApplicationIdentity(
  entry: JournalEntry,
  projectId: string,
  authorScope: string,
): void {
  const owner = projectKey(projectId);
  if (!authorScope || entry.authorScope !== authorScope) {
    throw new Error("別の作者スコープの回復記録は保存できません。");
  }
  if (entry.projectKey !== owner || projectKey(entry.projectId) !== owner ||
      entry.documentKey !== documentKey(projectId, entry.documentPath) || entry.key !== journalEntryKey(entry) ||
      projectKey(entry.snapshot.projectId) !== owner || projectKey(entry.operation.projectId) !== owner ||
      entry.snapshot.projectVersion !== entry.operation.baseProjectVersion ||
      !entry.operation.writes.some((write) => write.path === entry.documentPath)) {
    throw new Error("回復記録のプロジェクトまたは原稿の識別情報が一致しません。");
  }
  if (entry.state !== "draft" && entry.state !== "applying" && entry.state !== "applied") {
    throw new Error("この回復記録は保存できない状態です。");
  }
  assertChangeOperation(entry.operation);
}

function assertAcceptedProposal(accepted: ChangeProposal, expected: ChangeProposal): void {
  if (stableJson(accepted) !== stableJson(expected)) {
    throw new Error("Core が受け付けた保存提案が回復記録と一致しません。");
  }
}

/** Run one durable browser-journal and Core effect sequence for an application attempt. */
export async function runApplicationProtocol(input: ApplicationProtocolInput): Promise<JournalEntry> {
  input.signal?.throwIfAborted();
  const projectId = input.projectId;
  const authorScope = input.authorScope;
  const entry = input.entry;
  assertApplicationIdentity(entry, projectId, authorScope);

  const proposalId = entry.proposalId ?? `author-${entry.operation.id}-${entry.operation.generation}`;
  const applying = await input.journal.updateState({
    ...entry,
    proposalId,
    authorizedAt: entry.authorizedAt ?? Date.now(),
  }, "applying");
  if (applying.state === "conflict") throw new ApplicationConflictError();
  if (applying.state !== "applying" && applying.state !== "applied") {
    throw new Error("競合または公開状態になった回復記録は保存できません。");
  }
  input.onApplying?.(applying);

  const proposal: ChangeProposal = {
    id: proposalId,
    snapshot: applying.snapshot,
    operations: [applying.operation],
    source: "author",
  };
  input.signal?.throwIfAborted();
  const accepted = await input.api.propose(input.projectId, proposal, input.signal);
  assertAcceptedProposal(accepted, proposal);
  await input.journal.putProposal(projectId, authorScope, accepted);

  const assigned = await input.journal.updateState({ ...applying, proposalId: accepted.id }, "applying");
  if (assigned.state === "conflict") throw new ApplicationConflictError();
  if (assigned.state !== "applying" && assigned.state !== "applied") {
    throw new Error("競合または公開状態になった回復記録は保存できません。");
  }
  input.signal?.throwIfAborted();
  await input.api.approve(input.projectId, {
    proposalId: accepted.id,
    operationIds: [assigned.operation.id],
    authorScope,
  }, input.signal);

  input.signal?.throwIfAborted();
  const receipt = await input.api.apply(input.projectId, assigned.operation, input.signal);
  assertApplicationReceipt(receipt, assigned.operation);
  const saved = await input.journal.updateState(assigned, "applied", receipt);
  if (saved.state !== "applied" || !saved.application ||
      stableJson(saved.application) !== stableJson(receipt)) {
    throw new Error("保存受領証を回復記録へ保存できませんでした。");
  }
  await input.journal.removeProposal(projectId, authorScope, accepted.id).catch(() => undefined);
  return saved;
}
