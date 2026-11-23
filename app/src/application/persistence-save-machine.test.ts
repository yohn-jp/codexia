import assert from "node:assert/strict";
import test from "node:test";
import { createActor, waitFor } from "xstate";
import { createPersistenceSaveMachine, type PersistenceSaveMachineServices } from "./persistence-save-machine.js";

const identity = { projectId: "project-1", documentId: "document-1" };

function harness(overrides: Partial<PersistenceSaveMachineServices> = {}) {
  const calls: Array<{ kind: string; operationId?: string; generation?: number }> = [];
  const services: PersistenceSaveMachineServices = {
    async protectDraft(input) {
      calls.push({ kind: "protect", generation: input.generation });
      return "protected";
    },
    async saveOperation(input) {
      calls.push({ kind: "save", operationId: input.operationId ?? undefined, generation: input.generation });
      return { kind: "confirmed", operationId: input.operationId ?? "save-op-generated", generation: input.generation, receiptId: "revision-2" };
    },
    ...overrides,
  };
  const actor = createActor(createPersistenceSaveMachine(services), { input: { identity } });
  actor.start();
  actor.send({ type: "RECOVERY.READY", identity, recovery: "clean", generation: 0 });
  return { actor, calls };
}

test("an unprotected edit cannot start a server save", async () => {
  let releaseProtection!: (result: "protected") => void;
  const calls: Array<{ kind: string; generation?: number }> = [];
  const actor = createActor(createPersistenceSaveMachine({
    async protectDraft(input) {
      calls.push({ kind: "protect", generation: input.generation });
      return await new Promise<"protected">((resolve) => { releaseProtection = resolve; });
    },
    async saveOperation(input) {
      calls.push({ kind: "save", generation: input.generation });
      return { kind: "confirmed", operationId: "save-op-1", generation: input.generation, receiptId: "revision-2" };
    },
  }), { input: { identity } });
  actor.start();
  actor.send({ type: "RECOVERY.READY", identity, recovery: "clean", generation: 0 });
  actor.send({ type: "DRAFT.CHANGED", generation: 1, dirty: true });
  await waitFor(actor, (snapshot) => snapshot.matches({ active: { journal: "protecting" } }), { timeout: 1_000 });
  actor.send({ type: "SAVE.MANUAL" });
  assert.equal(calls.some((call) => call.kind === "save"), false);

  releaseProtection("protected");
  await waitFor(actor, (snapshot) => snapshot.matches({ active: { journal: "protected" } }), { timeout: 1_000 });
  actor.send({ type: "SAVE.MANUAL" });
  await waitFor(actor, (snapshot) => snapshot.matches({ active: { server: "confirmed" } }), { timeout: 1_000 });
  assert.equal(calls.some((call) => call.kind === "save" && call.generation === 1), true);
  actor.stop();
});

test("a newer edit cancels stale journal work and protects only its generation", async () => {
  let releaseOlderProtection!: (result: "protected") => void;
  const protectionSignals = new Map<number, AbortSignal>();
  const actor = createActor(createPersistenceSaveMachine({
    async protectDraft(input, signal) {
      protectionSignals.set(input.generation, signal);
      if (input.generation === 1) return await new Promise<"protected">((resolve) => { releaseOlderProtection = resolve; });
      return "protected";
    },
    async saveOperation(input) {
      return { kind: "confirmed", operationId: input.operationId, generation: input.generation, receiptId: "revision-2" };
    },
  }), { input: { identity } });
  actor.start();
  actor.send({ type: "RECOVERY.READY", identity, recovery: "clean", generation: 0 });
  actor.send({ type: "DRAFT.CHANGED", generation: 1, dirty: true });
  await waitFor(actor, (snapshot) => snapshot.matches({ active: { journal: "protecting" } }), { timeout: 1_000 });
  actor.send({ type: "DRAFT.CHANGED", generation: 2, dirty: true });
  await waitFor(actor, (snapshot) => snapshot.matches({ active: { journal: "protected" } }), { timeout: 1_000 });
  assert.equal(protectionSignals.get(1)?.aborted, true);
  assert.equal(actor.getSnapshot().context.protectedGeneration, 2);
  releaseOlderProtection("protected");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actor.getSnapshot().context.protectedGeneration, 2);
  actor.stop();
});

test("an unknown response retries the same operation and waits for its receipt", async () => {
  const calls: string[] = [];
  let attempts = 0;
  const { actor } = harness({
    async saveOperation(input) {
      calls.push(input.operationId ?? "missing-id");
      if (++attempts === 1) throw new Error("response lost");
      return { kind: "confirmed", operationId: input.operationId ?? "save-op-1", generation: input.generation, receiptId: "revision-2" };
    },
  });
  actor.send({
    type: "RECOVERY.READY", identity, recovery: "pending-save", generation: 2,
    draftProtected: true, operationId: "save-op-1", operationGeneration: 2,
  });
  await waitFor(actor, (snapshot) => snapshot.matches({ active: { server: "unknown" } }), { timeout: 1_000 });
  assert.equal(actor.getSnapshot().context.receiptId, null);
  actor.send({ type: "SAVE.RETRY" });
  await waitFor(actor, (snapshot) => snapshot.matches({ active: { server: "confirmed" } }), { timeout: 1_000 });
  assert.deepEqual(calls, ["save-op-1", "save-op-1"]);
  assert.equal(actor.getSnapshot().context.receiptId, "revision-2");
  actor.stop();
});

test("a 412 precondition response remains a conflict instead of becoming an unknown result", async () => {
  const conflict = Object.assign(new Error("precondition failed"), { status: 412 });
  const { actor } = harness({ async saveOperation() { throw conflict; } });
  actor.send({ type: "RECOVERY.READY", identity, recovery: "draft", generation: 2, draftProtected: true });
  actor.send({ type: "SAVE.MANUAL" });
  await waitFor(actor, (snapshot) => snapshot.matches({ active: { server: "conflict" } }), { timeout: 1_000 });
  assert.equal(actor.getSnapshot().context.receiptId, null);
  actor.stop();
});

test("IndexedDB protection failure blocks server writes", async () => {
  const calls: string[] = [];
  const { actor } = harness({
    async protectDraft() { throw new DOMException("quota full", "QuotaExceededError"); },
    async saveOperation() {
      calls.push("save");
      return { kind: "confirmed", operationId: "save-op-1", generation: 1, receiptId: "revision-2" };
    },
  });
  actor.send({ type: "DRAFT.CHANGED", generation: 1, dirty: true });
  await waitFor(actor, (snapshot) => snapshot.matches({ active: { journal: "failed" } }), { timeout: 1_000 });
  actor.send({ type: "SAVE.MANUAL" });
  assert.deepEqual(calls, []);
  actor.stop();
});

test("navigation protection preserves the explicit blocked state", async () => {
  const { actor } = harness();
  actor.send({ type: "NAVIGATION.REQUESTED", requestId: "nav-1" });
  actor.send({ type: "NAVIGATION.BLOCKED", requestId: "nav-1" });
  assert.equal(actor.getSnapshot().matches({ active: { navigation: "blocked" } }), true);
  actor.stop();
});
