import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readRegularFile } from './read-regular-file.mjs';

test('reads regular files through the validated descriptor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-regular-file-'));
  try {
    const file = path.join(root, 'source.txt');
    await writeFile(file, 'source');
    assert.equal(await readRegularFile(file), 'source');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects links and non-file filesystem objects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-regular-file-'));
  try {
    const source = path.join(root, 'source.txt');
    const link = path.join(root, 'link.txt');
    const directory = path.join(root, 'directory');
    await writeFile(source, 'source');
    await symlink(source, link);
    await mkdir(directory);
    await assert.rejects(readRegularFile(link), { code: 'ERR_NOT_REGULAR_FILE' });
    await assert.rejects(readRegularFile(directory), { code: 'ERR_NOT_REGULAR_FILE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
