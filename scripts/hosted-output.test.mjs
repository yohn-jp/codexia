import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { writeFileExclusive } from './hosted-output.mjs';
import { readRegularFile } from './read-regular-file.mjs';

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
