import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { initialControllerState } from './standalone-update-controller.mjs';
import { recoverSchemaMaintenance, runSchemaMaintenance, validateSchemaMaintenanceIntent } from './standalone-schema-maintenance.mjs';
import { signUpdateChannel, verifyUpdateChannel } from './update-channel.mjs';

const old = { format:'codexia-update-release/v1', channel:'stable', state:'published', version:'0.1.0', sourceSha:'a'.repeat(40), image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'a'.repeat(64), platform:'linux/amd64', profile:'core', migrationFingerprint:'sha256:'+'c'.repeat(64), persistenceFormat:1, apiEpoch:1 };
const next = { ...old, version:'0.1.1', sourceSha:'b'.repeat(40), image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'b'.repeat(64), migrationFingerprint:'sha256:'+'d'.repeat(64) };
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type:'spki', format:'pem' });
const privateKey = key.privateKey.export({ type:'pkcs8', format:'pem' });

const now = Date.parse('2026-11-20T00:00:00Z');
function signedChannel(sequence) {
  return signUpdateChannel({ format:'codexia-update-channel/v1', sequence,
    issuedAt:new Date(now-1000).toISOString(), expiresAt:new Date(now+12*60*60*1000).toISOString(), releases:[old,next] }, privateKey, now);
}

function fixture(fingerprint, { targetPersisted = false, writers } = {}) {
  const checkpoint = verifyUpdateChannel(signedChannel(1), publicKey, null, now).checkpoint;
  const initial = { ...initialControllerState(old, 'blue', checkpoint), paused:false };
  const state = targetPersisted ? { ...initial, installed:next, previous:old,
    journal:{ ...initial.journal, generation:1, phase:'committed', active:{ slot:'blue', image:next.image }, candidate:null } } : initial;
  let saved = state;
  const trace = [];
  let route = 'blocked';
  let currentWriters = writers ?? [{ slot:'blue', image:next.image }];
  const marker = validateSchemaMaintenanceIntent({ format:'codexia-schema-maintenance/v1', operationId:'11111111-1111-4111-8111-111111111111', phase:'applying', createdAt:'2026-11-20T00:00:00Z', databaseId:'123456789:12345', journalGeneration:0, priorPaused:false, priorTimerWasActive:true, priorSlot:'blue', priorRelease:old, targetRelease:next, stateFile:'/state.json', routeFile:'/route' });
  const controller = {
    publicKey, now: () => now,
    host: {
      async route(value) { route = value; trace.push('route:'+value); },
      async stopPollingTimer() { trace.push('stop-timer'); },
      async startPollingTimer() { trace.push('start-timer'); },
      async schemaFingerprint(release) {
        const observed = fingerprint;
        if (observed !== release.migrationFingerprint) throw new Error('ledger differs');
        return observed;
      },
      async freshDatabaseIdentity() { return '123456789:12345'; },
      async fetchChannel() { return signedChannel(2); },
      async startWriter(slot, release) { trace.push('start:'+slot+':'+release.image); currentWriters=[{slot,image:release.image}]; },
      async observe() { return { route, writers: currentWriters }; },
      async verifyBlockedPasswordRotation(slot, release) { trace.push('ready:'+release.image+':'+route); assert.equal(route,'blocked'); },
      async prepare(slot, release, owner) { trace.push('prepare:'+owner.operationId); assert.equal(route,'blocked'); assert.equal(release.image, currentWriters[0]?.image ?? release.image); },
      async stopInitialPreflight(slot, owner) { trace.push('stop-preflight:'+owner.operationId); },
      async probe(slot, release) { trace.push('probe:'+release.image+':'+route); },
    },
    async uiEpoch(release) { trace.push('epoch:'+release.image); assert.equal(release.apiEpoch, 1); },
    async save(value) { saved = structuredClone(value); return saved; },
    async assertServing() {},
  };
  const markerStore = { async load() { return marker; }, async clear() { trace.push('clear'); } };
  return { controller, state, marker, markerStore, trace, saved: () => saved };
}

test('committed schema marker admits only the target runtime during recovery', async () => {
  const fixtureValue = fixture(next.migrationFingerprint, { targetPersisted:true });
  const result = await recoverSchemaMaintenance({ ...fixtureValue, stateFile:'/state.json', routeFile:'/route' });
  assert.equal(result.installed.image, next.image);
  assert.equal(result.journal.generation, 1, 'Persisted target recovery must not advance the generation again');
  assert.equal(result.previous?.image, old.image, 'Persisted target recovery must preserve the prior release');
  assert.equal(fixtureValue.saved().paused, false);
  assert.ok(!fixtureValue.trace.some(item => item.startsWith('start:')),'Exact target writer should be retained during recovery');
  assert.ok(fixtureValue.trace.includes('route:blue'));
  assert.ok(fixtureValue.trace.indexOf('ready:'+next.image+':blocked') < fixtureValue.trace.indexOf('route:blue'), 'Writer must be proven ready while the route is blocked');
  assert.ok(fixtureValue.trace.includes('epoch:'+next.image), 'Recovery must recheck the current signed API epoch');
  assert.ok(fixtureValue.trace.includes('clear'));
});

test('unpersisted target recovery commits exactly once and reuses the durable preflight owner', async () => {
  const fixtureValue = fixture(next.migrationFingerprint, { writers:[] });
  const result = await recoverSchemaMaintenance({ ...fixtureValue, stateFile:'/state.json', routeFile:'/route' });
  assert.equal(result.installed.image, next.image);
  assert.equal(result.journal.generation, 1, 'Unpersisted target recovery must advance the generation once');
  assert.equal(result.previous?.image, old.image);
  assert.ok(fixtureValue.trace.includes('prepare:'+fixtureValue.marker.operationId));
  assert.ok(fixtureValue.trace.includes('stop-preflight:'+fixtureValue.marker.operationId));
  assert.ok(fixtureValue.trace.indexOf('ready:'+next.image+':blocked') < fixtureValue.trace.indexOf('route:blue'));
});

test('ambiguous schema marker remains blocked', async () => {
  const fixtureValue = fixture('sha256:'+'e'.repeat(64));
  await assert.rejects(recoverSchemaMaintenance({ ...fixtureValue, stateFile:'/state.json', routeFile:'/route' }), /cannot classify/);
  assert.deepEqual(fixtureValue.trace.slice(0, 2), ['route:blocked', 'stop-timer']);
  assert.ok(!fixtureValue.trace.some(item => item.startsWith('start:')));
});

test('incompatible API epoch or persistence format is rejected before backup evidence or host mutation', async t => {
  for (const field of ['apiEpoch', 'persistenceFormat']) {
    await t.test(field, async () => {
      const fixtureValue = fixture(old.migrationFingerprint);
      const incompatible = { ...next, [field]: next[field] + 1 };
      await assert.rejects(runSchemaMaintenance({
        controller: fixtureValue.controller,
        state: fixtureValue.state,
        target: incompatible,
        markerStore: fixtureValue.markerStore,
        stateFile: '/state.json',
        routeFile: '/route',
      }), new RegExp(`Same-epoch schema target changed ${field}`));
      assert.deepEqual(fixtureValue.trace, [], 'Incompatible maintenance must fail before channel, backup, lock-state or host operations');
    });
  }
});
