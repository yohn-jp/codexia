import assert from "node:assert/strict";
import test from "node:test";
import type {
  Approval,
  ChangeOperation,
  ChangeProposal,
  ApplyReceipt,
} from "@codexia/contracts";
import { runApplicationProtocol, ApplicationConflictError, type ApplicationApi, type ApplicationJournal } from "./application-protocol.js";
import { documentKey, journalEntryKey, projectKey, type JournalEntry } from "../storage/journal.js";

const projectId = "project-1";
const authorScope = "author-1";
const documentPath = "manuscript/scene-1.md";
const projectVersion = 3;

function operation(overrides: Partial<ChangeOperation> = {}): ChangeOperation {
  return {
    id: "operation-1",
    generation: 7,
    projectId,
    baseProjectVersion: projectVersion,
    effect: "manuscript",
    reads: [{ path: documentPath, revision: null }],
    writes: [{ path: documentPath, revision: null, content: "---\ntitle: Scene\n---\nDraft text\n" }],
    message: "loom(scene): scene-1",
    ...overrides,
  };
}

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  const base: JournalEntry = {
    version: 1,
    key: "",
    projectKey: projectKey(projectId),
    documentKey: documentKey(projectId, documentPath),
    authorScope,
    projectId,
    documentPath,
    sceneId: "scene-1",
    snapshot: { projectId, projectVersion },
    text: "Draft text",
    baseText: "Original text",
    operation: operation(),
    state: "draft",
    updatedAt: 1,
  };
  const result = { ...base, ...overrides };
  result.key = journalEntryKey(result);
  return result;
}

interface HarnessOptions {
  failAt?: string;
  conflictOnFirstStateWrite?: boolean;
  wrongProposal?: boolean;
  wrongReceipt?: boolean;
  loseFirstApplicationResponse?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const proposalRecords = new Map<string, ChangeProposal>();
  const proposed: ChangeProposal[] = [];
  const approvals: Approval[] = [];
  const applications: ChangeOperation[] = [];
  let failAt = options.failAt;
  let stateWriteCount = 0;
  let stored = entry();
  const applicationReceipt: ApplyReceipt = {
    operationId: "operation-1",
    generation: 7,
    projectVersion: 4,
    revisions: [{ path: documentPath, revision: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" }],
  };

  const journal: ApplicationJournal = {
    async updateState(value, state, receipt) {
      stateWriteCount += 1;
      events.push(`journal:update:${state}:${stateWriteCount}`);
      if (failAt === `update:${state}:${stateWriteCount}`) throw new Error(`injected update failure ${stateWriteCount}`);
      if (options.conflictOnFirstStateWrite && stateWriteCount === 1) {
        stored = { ...stored, state: "conflict" };
        return stored;
      }
      stored = structuredClone({ ...value, state, ...(receipt ? { application: receipt } : {}) });
      return stored;
    },
    async putProposal(owner, scope, proposal) {
      events.push("journal:putProposal");
      if (failAt === "putProposal") throw new Error("injected proposal journal failure");
      assert.equal(owner, projectId);
      assert.equal(scope, authorScope);
      const previous = proposalRecords.get(proposal.id);
      if (previous) assert.deepEqual(previous, proposal);
      proposalRecords.set(proposal.id, proposal);
      return null;
    },
    async removeProposal(owner, scope, proposalId) {
      events.push("journal:removeProposal");
      if (failAt === "removeProposal") throw new Error("injected cleanup failure");
      assert.equal(owner, projectId);
      assert.equal(scope, authorScope);
      proposalRecords.delete(proposalId);
      return true;
    },
  };

  const api: ApplicationApi = {
    async propose(targetProject, proposal) {
      assert.equal(targetProject, projectId);
      assert.equal(stored.state, "applying", "recoverable state must be durable before transmission");
      events.push("api:propose");
      proposed.push(proposal);
      if (failAt === "propose") throw new Error("injected propose failure");
      if (options.wrongProposal) return { ...proposal, id: "unexpected-proposal" };
      return proposal;
    },
    async approve(targetProject, approval) {
      assert.equal(targetProject, projectId);
      assert.ok(proposalRecords.has(approval.proposalId), "the accepted proposal must be recoverable before approval");
      assert.equal(stored.proposalId, approval.proposalId);
      events.push("api:approve");
      approvals.push(approval);
      if (failAt === "approve") throw new Error("injected approval failure");
    },
    async apply(targetProject, submitted) {
      assert.equal(targetProject, projectId);
      assert.deepEqual(submitted, operation(), "the applied payload must be exactly the author's durable edit");
      assert.ok(approvals.some(approval =>
        approval.authorScope === authorScope && approval.operationIds.includes(submitted.id)),
      "application requires the matching author approval");
      events.push("api:application");
      applications.push(submitted);
      if (failAt === "application") throw new Error("injected application failure");
      if (options.wrongReceipt) return { ...applicationReceipt, generation: applicationReceipt.generation + 1 };
      if (options.loseFirstApplicationResponse && applications.length === 1) throw new Error("application response lost");
      return applicationReceipt;
    },
  };

  return {
    events,
    journal,
    api,
    proposed,
    approvals,
    applications,
    proposalRecords,
    get stored() { return stored; },
    get stateWriteCount() { return stateWriteCount; },
    retry() { failAt = undefined; },
    input(overrides: Partial<Parameters<typeof runApplicationProtocol>[0]> = {}) {
      return {
        projectId,
        authorScope,
        entry: entry(),
        api,
        journal,
        ...overrides,
      };
    },
  };
}

test("application effects share one durable sequence and emit only after the initial journal write", async () => {
  const worker = harness();
  let emitted: JournalEntry | undefined;
  const result = await runApplicationProtocol(worker.input({ onApplying: (value) => {
    assert.equal(worker.stored.state, "applying");
    emitted = value;
  } }));

  assert.ok(worker.events.includes("api:propose"));
  assert.ok(worker.events.includes("api:approve"));
  assert.ok(worker.events.includes("api:application"));
  assert.ok(worker.events.indexOf("api:application") < worker.events.indexOf("journal:removeProposal"));
  assert.equal(emitted?.state, "applying");
  assert.equal(result.state, "applied");
  assert.equal(result.proposalId, worker.proposed[0]?.id);
  assert.deepEqual(result.application, worker.stored.application);
  assert.equal(result.application?.projectVersion, 4);
  assert.equal(worker.proposalRecords.size, 0);
  assert.deepEqual(worker.approvals, [{ proposalId: result.proposalId, operationIds: ["operation-1"], authorScope }]);
});

test("failures at each durable or network step retain the same scoped operation for retry", async (context) => {
  const failurePoints = [
    "update:applying:1",
    "propose",
    "putProposal",
    "update:applying:2",
    "approve",
    "application",
    "update:applied:3",
  ];
  for (const failurePoint of failurePoints) {
    await context.test(failurePoint, async () => {
      const worker = harness({ failAt: failurePoint });
      let emitted = false;
      await assert.rejects(runApplicationProtocol(worker.input({ onApplying: () => { emitted = true; } })), /injected/u);
      assert.equal(emitted, failurePoint !== "update:applying:1");
      assert.ok(worker.stateWriteCount >= 1);
      assert.equal(worker.stored.operation.id, "operation-1");
      assert.equal(worker.stored.operation.generation, 7);
      if (worker.stored.state !== "draft") {
        assert.equal(worker.stored.state, "applying");
        assert.ok(worker.stored.proposalId);
      }
      for (const record of worker.proposalRecords.values()) {
        assert.equal(record.id, worker.stored.proposalId);
        assert.equal(record.snapshot.projectId, projectId);
        assert.equal(record.operations[0]?.id, "operation-1");
      }
      for (const approval of worker.approvals) {
        assert.equal(approval.authorScope, authorScope);
        assert.deepEqual(approval.operationIds, ["operation-1"]);
      }
      worker.retry();
      const result = await runApplicationProtocol(worker.input({ entry: worker.stored }));
      assert.equal(result.state, "applied");
      assert.deepEqual(result.operation, operation());
    });
  }
});

test("a lost application response is retried with the same proposal, operation generation, and author scope", async () => {
  const worker = harness({ loseFirstApplicationResponse: true });
  await assert.rejects(runApplicationProtocol(worker.input()), /response lost/u);
  assert.equal(worker.stored.state, "applying");
  const proposalId = worker.stored.proposalId;
  assert.ok(proposalId);
  assert.equal(worker.proposalRecords.size, 1);

  const result = await runApplicationProtocol(worker.input({ entry: worker.stored }));
  assert.equal(result.state, "applied");
  assert.equal(result.application?.operationId, "operation-1");
  assert.equal(result.application?.generation, 7);
  assert.deepEqual(worker.proposed.map((proposal) => proposal.id), [proposalId, proposalId]);
  assert.deepEqual(worker.applications.map((item) => [item.id, item.generation]), [["operation-1", 7], ["operation-1", 7]]);
  assert.deepEqual(worker.approvals.map((approval) => approval.authorScope), [authorScope, authorScope]);
  assert.equal(worker.proposalRecords.size, 0);
});

test("cleanup failure cannot turn a durable application receipt into a failed save", async () => {
  const worker = harness({ failAt: "removeProposal" });
  const result = await runApplicationProtocol(worker.input());

  assert.equal(result.state, "applied");
  assert.equal(result.application?.operationId, "operation-1");
  assert.equal(worker.stored.state, "applied");
  assert.equal(worker.proposalRecords.size, 1);
});

test("a conflict returned by the journal remains a conflict and prevents further effects", async () => {
  const worker = harness({ conflictOnFirstStateWrite: true });
  await assert.rejects(runApplicationProtocol(worker.input({ entry: entry({ state: "applying" }) })), ApplicationConflictError);

  assert.equal(worker.stored.state, "conflict");
  assert.equal(worker.proposed.length, 0);
  assert.deepEqual(worker.events, ["journal:update:applying:1"]);
});

test("receipt identity and caller projectId and author scope are checked before confirmation", async () => {
  const wrongProposal = harness({ wrongProposal: true });
  await assert.rejects(runApplicationProtocol(wrongProposal.input()), /提案/u);
  assert.equal(wrongProposal.stored.state, "applying");
  assert.equal(wrongProposal.proposalRecords.size, 0);
  assert.equal(wrongProposal.approvals.length, 0);

  const wrongReceipt = harness({ wrongReceipt: true });
  await assert.rejects(runApplicationProtocol(wrongReceipt.input()), /receipt/u);
  assert.equal(wrongReceipt.stored.state, "applying");
  assert.equal(wrongReceipt.proposalRecords.size, 1);

  const wrongAuthor = harness();
  await assert.rejects(runApplicationProtocol(wrongAuthor.input({ authorScope: "author-2" })), /作者スコープ/u);
  assert.deepEqual(wrongAuthor.events, []);

  const otherRepository = "project-2";
  const wrongRepository = harness();
  await assert.rejects(runApplicationProtocol(wrongRepository.input({ projectId: otherRepository })), /識別情報/u);
  assert.deepEqual(wrongRepository.events, []);
});

for (const phase of ["propose", "approve", "apply"] as const) {
  test(`cancelled ${phase} recovery retains the operation for an idempotent retry`, async () => {
    const worker = harness();
    const controller = new AbortController();
    const api: ApplicationApi = {
      ...worker.api,
      [phase]: async (_projectId: string, _value: unknown, signal?: AbortSignal) => {
        assert.equal(signal, controller.signal);
        controller.abort();
        signal?.throwIfAborted();
      },
    };
    await assert.rejects(runApplicationProtocol(worker.input({ api, signal: controller.signal })), { name: "AbortError" });
    assert.equal(worker.stored.state, "applying");
    assert.deepEqual(worker.stored.operation, operation());

    const recovered = await runApplicationProtocol(worker.input({ entry: worker.stored }));
    assert.equal(recovered.state, "applied");
    assert.deepEqual(recovered.operation, operation());
    assert.equal(worker.applications.length, 1);
  });
}

test("cancellation during journal persistence prevents the next approval request", async () => {
  const worker = harness();
  const controller = new AbortController();
  const journal: ApplicationJournal = {
    ...worker.journal,
    async putProposal(...args) {
      const ownership = await worker.journal.putProposal(...args);
      controller.abort();
      return ownership;
    },
  };
  await assert.rejects(runApplicationProtocol(worker.input({ journal, signal: controller.signal })), { name: "AbortError" });
  assert.equal(worker.proposalRecords.size, 1);
  assert.equal(worker.approvals.length, 0);
  assert.equal(worker.applications.length, 0);
  assert.deepEqual(worker.stored.operation, operation());
});
