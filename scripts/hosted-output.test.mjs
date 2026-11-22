import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { writeFileExclusive } from './hosted-output.mjs';

test('hosted output creation is exclusive and never truncates an existing file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-hosted-output-'));
  try {
    const target = path.join(directory, 'output');
    await writeFileExclusive(target, Buffer.from('first'));
    await assert.rejects(writeFileExclusive(target, Buffer.from('second')), /EEXIST/u);
    assert.equal(await readFile(target, 'utf8'), 'first');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hosted output creation leaves a pre-existing link and its destination intact', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-hosted-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = path.join(directory, 'original');
  const output = path.join(directory, 'output');
  await writeFile(original, 'unchanged');
  await symlink(original, output);

  await assert.rejects(writeFileExclusive(output, Buffer.from('replacement')), { code: 'EEXIST' });
  assert.equal(await readFile(original, 'utf8'), 'unchanged');
  assert.equal(await readFile(output, 'utf8'), 'unchanged');
  assert.deepEqual((await readdir(directory)).sort(), ['original', 'output']);
});
