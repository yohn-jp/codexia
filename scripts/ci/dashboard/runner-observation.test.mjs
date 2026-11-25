import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectRunnerObservation } from './runner-observation.mjs';

test('runner observation records bounded metrics without dumping environment or inventing unavailable data', () => {
  const report = collectRunnerObservation('before', {
    env: { CODEXIA_EXPECTED_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '42', CODEXIA_CI_BROWSER_GROUP: 'core-reference',
      SECRET_TOKEN: 'never-export-this' },
    now: () => new Date('2026-11-25T00:00:00Z'),
    read: file => {
      if (file.endsWith('cpu.max')) return '200000 100000\n';
      if (file.endsWith('cpu.stat')) return 'x'.repeat(4097);
      throw new Error('Unavailable');
    },
  });
  assert.equal(report.group, 'core-reference');
  assert.equal(report.cgroup.cpuMax, '200000 100000');
  assert.equal(report.cgroup.cpuStat, null);
  assert.equal(report.cgroup.memoryMax, null);
  assert.equal(report.imageVersion, null);
  assert.equal(report.observedAt, '2026-11-25T00:00:00.000Z');
  assert.ok(!JSON.stringify(report).includes('never-export-this'));
  assert.throws(() => collectRunnerObservation('unknown'), /Invalid runner observation phase/);
});
