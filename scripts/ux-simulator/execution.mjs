import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const machinePath = 'app/src/application/persistence-save-machine.ts';
const testPath = 'app/src/application/persistence-save-machine.test.ts';
const platform = 'desktop';
const screen = 'WRT-01';
const scenarioId = 'observed-save-receipt';

// The canonical actor owns state transitions, guards and identity checks.
// This fixture supplies only an isolated service response and known test inputs.
export async function captureSaveEvidence(source, repositoryRoot, sourceSha, observed) {
  const definition = source.location(machinePath, 'export function createPersistenceSaveMachine');
  const expectation = source.location(testPath, 'an unknown response retries the same operation');
  if (!definition || !expectation || !observed.screens.some(({ id, platform: scope }) => id === screen && scope === platform)) {
    return;
  }
  const require = createRequire(pathToFileURL(join(repositoryRoot, 'app/package.json')));
  const { createActor, waitFor } = require('xstate');
  const { createPersistenceSaveMachine } = await import(pathToFileURL(join(repositoryRoot, machinePath)));
  const identity = { projectId: 'synthetic-project', documentId: 'synthetic-document' };
  const operationId = 'synthetic-operation';
  const receiptId = 'synthetic-receipt';
  const actorId = 'ux-save-evidence';
  const calls = [];
  const states = new Map();
  const transitions = [];
  let previous;
  const stateKey = (value) => screen + '/server/' + states.size + '/' + value;
  const actor = createActor(createPersistenceSaveMachine({
    async protectDraft() {
      return 'protected';
    },
    async saveOperation(input) {
      calls.push(input.operationId);
      if (calls.length === 1) throw new Error('synthetic lost response');
      return { kind: 'confirmed', operationId: input.operationId, generation: input.generation, receiptId };
    },
  }), {
    id: actorId,
    input: { identity },
    inspect(event) {
      if (event.type !== '@xstate.snapshot' || event.actorRef.id !== actorId) return;
      const current = event.snapshot.value?.active?.server;
      if (typeof current !== 'string' || current === previous?.state) return;
      const currentId = stateKey(current);
      states.set(currentId, { id: currentId, platform, screen, label: current, source: definition });
      if (previous) {
        const codeLocation = source.location(machinePath, '"' + event.event.type + '"') ?? definition;
        transitions.push({
          id: 'executed-save.' + previous.state + '.' + current + '.' + transitions.length,
          platform, screen, from: previous.id, to: currentId, event: event.event.type,
          source: codeLocation, method: 'trace',
          evidence: { ...expectation, sourceSha, outcome: 'passed' },
          context: { operationId: event.snapshot.context.operationId ?? null, receiptId: event.snapshot.context.receiptId ?? null },
        });
      }
      previous = { id: currentId, state: current };
    },
  });
  try {
    actor.start();
    actor.send({ type: 'RECOVERY.READY', identity, recovery: 'pending-save', generation: 2,
      draftProtected: true, operationId, operationGeneration: 2 });
    await waitFor(actor, (snapshot) => snapshot.matches({ active: { server: 'unknown' } }), { timeout: 1_000 });
    assert.equal(actor.getSnapshot().context.receiptId, null);
    actor.send({ type: 'SAVE.RETRY' });
    await waitFor(actor, (snapshot) => snapshot.matches({ active: { server: 'confirmed' } }), { timeout: 1_000 });
    assert.deepEqual(calls, [operationId, operationId]);
    assert.equal(actor.getSnapshot().context.receiptId, receiptId);
  } finally {
    actor.stop();
  }
  assert.ok(transitions.length > 0);
  observed.states.push(...states.values());
  observed.transitions.push(...transitions);
  observed.scenarios.push({
    id: scenarioId, platform, platforms: [platform], screens: [screen],
    label: '正規保存機械 · 応答不明と同一操作の照合', initial: transitions[0].from, source: expectation,
  });
}
