import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePreviewArgs, parsePublishedPort } from './preview.mjs';
import { checkedSnapshotUrl } from './scan.mjs';

test('UI preview defaults to isolated core UI with both browser snapshots', () => {
  assert.deepEqual(parsePreviewArgs([]), { profile: 'core', port: 4173, engine: 'auto', skipBuild: false, capture: true });
});

test('UI preview accepts deliberate profile, port and capture settings', () => {
  assert.deepEqual(parsePreviewArgs(['--profile', 'full', '--port', '4812', '--engine', 'podman', '--skip-build', '--no-capture']), {
    profile: 'full', port: 4812, engine: 'podman', skipBuild: true, capture: false,
  });
});

test('UI preview rejects unknown flags and dangerous invalid options', () => {
  for (const flags of [['--profile', 'evil'], ['--port', '0'], ['--port', '65534'], ['--engine', 'other'], ['--missing'], ['--port']]) {
    assert.throws(() => parsePreviewArgs(flags));
  }
});

test('only a loopback-bound PostgreSQL port can be adopted', () => {
  assert.equal(parsePublishedPort('127.0.0.1:49153\n'), 49153);
  for (const output of [
    '0.0.0.0:49153', '[::]:49153', '127.0.0.1:0', '127.0.0.1:49153\n127.0.0.1:49154',
    '127.0.0.1:49153\n0.0.0.0:49154', '[::]:49154\r\n127.0.0.1:49153', '',
  ]) {
    assert.throws(() => parsePublishedPort(output));
  }
});

test('scan accepts only local snapshot server origin', () => {
  assert.equal(checkedSnapshotUrl('http://127.0.0.1:49153'), 'http://127.0.0.1:49153');
  for (const url of ['https://127.0.0.1:49153/', 'http://localhost:49153/', 'http://192.168.1.1:49153/', 'http://127.0.0.1:49153/api', 'http://u:p@127.0.0.1:49153/', 'http://127.0.0.1:49153/?x=1']) {
    assert.throws(() => checkedSnapshotUrl(url));
  }
});
