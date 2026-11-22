import assert from "node:assert/strict";
import test from "node:test";
import type { EditorEvidenceIdentity, EditorPersistenceSave, EditorPersistenceSaveResult } from "../editor/evidence.js";
import type { Document as PersistenceDocument, DocumentRevision } from "@codexia/persistence-contracts";
import { PersistenceSaveConflictJournalError, runPersistenceSaveProtocol, type PersistenceSaveJournal, type PersistenceSaveRequest } from "./persistence-save-protocol.js";
import { resolvePersistenceSaveConflict, resolvePersistenceSaveSuccess, type ActiveDocument } from "./persistence-save-state.js";

const pending: PersistenceSaveRequest = {
  projectId: "project-1", documentId: "document-1", baseRevisionId: "revision-1", baseMarkdown: "old", markdown: "new",
  changes: [{ from: 0, to: 3, insert: "new" }], generation: 4, idempotencyKey: "save-operation-1", clientId: "client-1",
};
const authorScope = "author-1";
const document = { projectId: pending.projectId, id: pending.documentId, headRevisionId: "revision-2" };
const revision = { id: "revision-2", projectId: pending.projectId, documentId: pending.documentId, markdown: pending.markdown };
const response = { revisionId: revision.id, markdown: pending.markdown, document, revision } as unknown as EditorPersistenceSaveResult;

function journalHarness() {
  const events: string[] = [];
  const journal: PersistenceSaveJournal = {
    async getPersistenceDraft() { events.push("journal:read-draft"); return undefined; },
    async bindPersistenceDraftSave(_projectId, _documentId, _scope, operation) {
      events.push(`journal:bind:${operation.idempotencyKey}`); return true;
    },
    async acknowledgePersistenceDraftSave(_projectId, _documentId, _scope, operation, revisionId, rebase = true) {
      events.push(`journal:ack:${operation.idempotencyKey}:${revisionId}:${rebase}`); return { acknowledged: true };
    },
    async clearPersistenceDraftSave(_projectId, _documentId, _scope, operation) {
      events.push(`journal:clear:${operation.idempotencyKey}`); return true;
    },
  };
  return { events, journal };
}

test("save is journal-bound before send and acknowledged only after exact PostgreSQL receipt", async () => {
  const { events, journal } = journalHarness();
  const result = await runPersistenceSaveProtocol({
    authorScope, pending, reconcileReplay: false, journal,
    async save(_identity, operation) {
      events.push(`api:save:${operation.idempotencyKey}`);
      return response;
    },
    async readHead() { throw new Error("normal saves do not require replay lookup"); },
    signal: new AbortController().signal,
  });
  assert.deepEqual(events, ["journal:bind:save-operation-1", "api:save:save-operation-1", "journal:ack:save-operation-1:revision-2:true"]);
  assert.equal(result.result.revision.id, "revision-2");
  assert.equal(result.acknowledgement.acknowledged, true);
});

test("lost response can be retried with the same identity and reconciles the committed head", async () => {
  const { events, journal } = journalHarness();
  let attempts = 0;
  const input = {
    authorScope, pending, reconcileReplay: true, journal,
    async save(_identity: EditorEvidenceIdentity, operation: EditorPersistenceSave) {
      events.push(`api:save:${operation.idempotencyKey}`);
      attempts += 1;
      if (attempts === 1) throw new Error("response lost");
      return response;
    },
    async readHead() { events.push("api:read-head"); return { document: document as PersistenceDocument, revision: revision as DocumentRevision }; },
    signal: new AbortController().signal,
  };
  await assert.rejects(runPersistenceSaveProtocol(input), /response lost/u);
  const result = await runPersistenceSaveProtocol(input);
  assert.equal(result.result.revision.id, "revision-2");
  assert.equal(result.replayWasSuperseded, false);
  assert.deepEqual(events, [
    "journal:bind:save-operation-1", "api:save:save-operation-1",
    "journal:bind:save-operation-1", "api:save:save-operation-1", "api:read-head",
    "journal:ack:save-operation-1:revision-2:true",
  ]);
});

test("409 clears only the exact pending save identity while preserving the recovery draft", async () => {
  const { events, journal } = journalHarness();
  const conflict = Object.assign(new Error("conflict"), { status: 409 });
  await assert.rejects(runPersistenceSaveProtocol({
    authorScope, pending, reconcileReplay: false, journal,
    async save() { throw conflict; },
    async readHead() { throw new Error("conflicts are handled by the caller"); },
    signal: new AbortController().signal,
  }), (error) => error === conflict);
  assert.deepEqual(events, ["journal:bind:save-operation-1", "journal:clear:save-operation-1"]);
});

test("server receipt identity and content mismatches never acknowledge or clear the recovery operation", async (context) => {
  const malformed = [
    { label: "returned text", result: { ...response, markdown: "different text" } },
    { label: "revision text", result: { ...response, revision: { ...revision, markdown: "different text" } } },
    { label: "document project", result: { ...response, document: { ...document, projectId: "other-project" } } },
    { label: "document identity", result: { ...response, document: { ...document, id: "other-document" } } },
    { label: "head identity", result: { ...response, document: { ...document, headRevisionId: "other-revision" } } },
    { label: "revision project", result: { ...response, revision: { ...revision, projectId: "other-project" } } },
    { label: "revision document", result: { ...response, revision: { ...revision, documentId: "other-document" } } },
    { label: "revision id", result: { ...response, revisionId: "different-revision" } },
  ];
  for (const item of malformed) {
    await context.test(item.label, async () => {
      const { events, journal } = journalHarness();
      await assert.rejects(runPersistenceSaveProtocol({
        authorScope, pending, reconcileReplay: false, journal,
        async save() { return item.result as unknown as EditorPersistenceSaveResult; },
        async readHead() { throw new Error("receipt validation must fail first"); },
        signal: new AbortController().signal,
      }), /PostgreSQLの保存結果/u);
      assert.deepEqual(events, ["journal:bind:save-operation-1"]);
    });
  }
});

function activeState(overrides: Partial<ActiveDocument> = {}): ActiveDocument {
  return {
    document: document as never,
    revision: revision as never,
    baseRevisionId: pending.baseRevisionId,
    baseMarkdown: pending.baseMarkdown,
    markdown: pending.markdown,
    generation: pending.generation,
    dirty: true,
    recovery: "stored",
    save: "saving",
    error: "",
    remoteConflict: null,
    evidence: {} as never,
    evidenceLoadKey: 1,
    ...overrides,
  };
}

test("ABA generations remain distinct after an older save receipt", () => {
  const current = activeState({ generation: pending.generation + 2, markdown: pending.markdown, dirty: true });
  const rebasedDraft = {
    generation: current.generation + 1,
    markdown: current.markdown,
    baseRevisionId: revision.id,
    baseMarkdown: pending.markdown,
  } as never;
  const decision = resolvePersistenceSaveSuccess({
    current, pending, acknowledgedDocument: document as never, acknowledgedRevision: revision as never,
    replayWasSuperseded: false, journalAcknowledged: true, remainingDraft: rebasedDraft,
  });
  assert.equal(decision.kind, "publish");
  if (decision.kind !== "publish") return;
  assert.equal(decision.active.generation, current.generation + 1);
  assert.equal(decision.active.dirty, true);
  assert.equal(decision.active.recovery, "pending");
  assert.equal(decision.active.markdown, pending.markdown);
});

test("409 conflict projection keeps current text and associates the exact remote revision", () => {
  const current = activeState({ markdown: "author text survives" });
  const latestRevision = { id: "new-head", markdown: "remote text" } as never;
  const next = resolvePersistenceSaveConflict(current, latestRevision);
  assert.equal(next.markdown, "author text survives");
  assert.equal(next.remoteConflict, latestRevision);
  assert.equal(next.save, "failed");
  assert.match(next.error, /下書きはIndexedDBに残/u);
});

test("a failed journal acknowledgement cannot project the PostgreSQL receipt as saved", () => {
  const current = activeState();
  const decision = resolvePersistenceSaveSuccess({
    current, pending, acknowledgedDocument: document as never, acknowledgedRevision: revision as never,
    replayWasSuperseded: false, journalAcknowledged: false, remainingDraft: undefined,
  });
  assert.equal(decision.kind, "publish");
  if (decision.kind !== "publish") return;
  assert.equal(decision.active.recovery, "failed");
  assert.equal(decision.active.save, "failed");
  assert.equal(decision.active.dirty, true);
});

test("a 409 whose journal clear fails remains a recovery failure instead of opening a conflict as resolved", async () => {
  const { journal } = journalHarness();
  journal.clearPersistenceDraftSave = async () => { throw new Error("storage unavailable"); };
  const conflict = Object.assign(new Error("conflict"), { status: 409 });
  await assert.rejects(runPersistenceSaveProtocol({
    authorScope, pending, reconcileReplay: false, journal,
    async save() { throw conflict; },
    async readHead() { throw new Error("not reached"); },
    signal: new AbortController().signal,
  }), PersistenceSaveConflictJournalError);
});
