import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialControllerState } from './standalone-update-controller.mjs';
import { recoverSchemaMaintenance, validateSchemaMaintenanceIntent } from './standalone-schema-maintenance.mjs';

const old = { format:'codexia-update-release/v1', channel:'stable', state:'published', version:'0.1.0', sourceSha:'a'.repeat(40), image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'a'.repeat(64), platform:'linux/amd64', profile:'core', migrationFingerprint:'sha256:'+'c'.repeat(64), persistenceFormat:1, apiEpoch:1 };
const next = { ...old, version:'0.1.1', sourceSha:'b'.repeat(40), image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'b'.repeat(64), migrationFingerprint:'sha256:'+'d'.repeat(64) };

function fixture(fingerprint) {
  const state = { ...initialControllerState(old, 'blue', null), paused:false };
  let saved = state;
  const trace = [];
  let route = 'blocked';
  const marker = validateSchemaMaintenanceIntent({ format:'codexia-schema-maintenance/v1', operationId:'11111111-1111-4111-8111-111111111111', phase:'applying', createdAt:'2026-11-20T00:00:00Z', databaseId:'123456789:12345', journalGeneration:0, priorPaused:false, priorTimerWasActive:true, priorSlot:'blue', priorRelease:old, targetRelease:next, stateFile:'/state.json', routeFile:'/route' });
  const controller = {
    publicKey: 'unused', now: () => Date.parse('2026-11-20T00:00:00Z'),
    host: {
      async route(value) { route = value; trace.push('route:'+value); },
      async stopPollingTimer() { trace.push('stop-timer'); },
      async startPollingTimer() { trace.push('start-timer'); },
      async schemaFingerprint(release) {
        const observed = fingerprint;
        if (observed !== release.migrationFingerprint) throw new Error('ledger differs');
        return observed;
      },
      async startWriter(slot, release) { trace.push('start:'+slot+':'+release.image); },
      async observe() { return { route, writers: [{ slot:'blue', image: next.image }] }; },
      async probe() {},
    },
    async save(value) { saved = structuredClone(value); return saved; },
    async assertServing() {},
  };
  const markerStore = { async load() { return marker; }, async clear() { trace.push('clear'); } };
  return { controller, state, markerStore, trace, saved: () => saved };
}

test('committed schema marker admits only the target runtime during recovery', async () => {
  const fixtureValue = fixture(next.migrationFingerprint);
  const result = await recoverSchemaMaintenance(fixtureValue);
  assert.equal(result.installed.image, next.image);
  assert.equal(fixtureValue.saved().paused, false);
  assert.ok(fixtureValue.trace.includes('start:blue:'+next.image));
  assert.ok(fixtureValue.trace.includes('route:blue'));
  assert.ok(fixtureValue.trace.includes('clear'));
});

test('ambiguous schema marker remains blocked', async () => {
  const fixtureValue = fixture('sha256:'+'e'.repeat(64));
  await assert.rejects(recoverSchemaMaintenance(fixtureValue), /cannot classify/);
  assert.deepEqual(fixtureValue.trace.slice(0, 2), ['route:blocked', 'stop-timer']);
  assert.ok(!fixtureValue.trace.some(item => item.startsWith('start:')));
});
