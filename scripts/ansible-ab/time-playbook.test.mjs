import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./time-playbook.sh', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codexia-ansible-timing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const playbook = join(directory, 'synthetic-playbook');
  const metric = join(directory, 'invocations.csv');
  const called = join(directory, 'arguments.txt');
  await writeFile(playbook, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FIXTURE_CALLED"\nprintf "playbook output\\n"\nprintf "playbook error\\n" >&2\nexit 7\n', { mode: 0o700 });
  function invoke(overrides) {
    return spawnSync('bash', [runner, 'fixture.yml', 'value with spaces'], {
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        ANSIBLE_REAL_PLAYBOOK: playbook,
        ANSIBLE_AB_METRIC_FILE: metric,
        ANSIBLE_AB_ARM: 'fixture',
        FIXTURE_CALLED: called,
        ...overrides,
      },
    });
  }
  return { called, invoke, metric };
}

test('Ansible timing wrapper refuses invalid setup before running a playbook', async t => {
  const f = await fixture(t);
  for (const input of [{ GITHUB_ACTIONS: 'false' }, { ANSIBLE_AB_ARM: '' }, { ANSIBLE_AB_METRIC_FILE: '' }]) {
    const result = f.invoke(input);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(f.called), { code: 'ENOENT' });
    await assert.rejects(readFile(f.metric), { code: 'ENOENT' });
  }
});

test('Ansible timing wrapper retains arguments, streams, exit code and one nonsecret metric', async t => {
  const f = await fixture(t);
  const result = f.invoke({});
  assert.ifError(result.error);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'playbook output\n');
  assert.equal(result.stderr, 'playbook error\n');
  assert.equal(await readFile(f.called, 'utf8'), 'fixture.yml\nvalue with spaces\n');
  assert.match(await readFile(f.metric, 'utf8'), /^fixture,\d+,7\n$/u);
});
