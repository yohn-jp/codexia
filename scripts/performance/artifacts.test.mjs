import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInventory, pack, verify } from './artifacts.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
test('artifact round trip reproduces archives and rejects corrupt archive, gzip and raw evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-artifacts-'));
  try {
    const source = join(root, 'source'), index = join(root, 'INDEX.json'); await mkdir(source);
    const data = Buffer.from('{"synthetic":true}\n');
    // Fixed, previously encoded RFC 1952 fixture for this schema-1 recipe.
    const gzip = Buffer.from('1f8b08000000000000ffab562aaecc2bc9482dc94c56b22a292a4dade50200301ca01713000000', 'hex');
    assert.deepEqual(gunzipSync(gzip), data);
    await writeFile(join(source, 'result.json'), data);
    const manifest = { schemaVersion: 1, artifacts: [{ file: 'raw/result.json.gz', sourceFile: 'result.json',
      sourceBytes: data.length, gzipBytes: gzip.length, sha256: hash(data), gzipSha256: hash(gzip), diagnostic: false }] };
    await writeFile(index, JSON.stringify(manifest));
    const url = 'https://github.com/yohn-jp/codexia/releases/download/test/evidence.tar';
    const a = await pack(index, source, join(root, 'a'), url);
    const b = await pack(join(root, 'a/INDEX.json'), source, join(root, 'b'), url);
    assert.deepEqual(a, b);
    const firstArchive = join(root, 'a/evidence.tar');
    const archiveBytes = await readFile(firstArchive);
    assert.deepEqual(archiveBytes, await readFile(join(root, 'b/evidence.tar')));
    assert.equal(a.storage.sha256, hash(archiveBytes));
    assert.equal(a.storage.bytes, archiveBytes.byteLength);
    assert.deepEqual(execFileSync('tar', ['-tf', firstArchive], { encoding: 'utf8' }).trim().split('\n'),
      ['raw/', 'raw/result.json.gz']);
    const extracted = execFileSync('tar', ['-xOf', firstArchive, 'raw/result.json.gz']);
    assert.deepEqual(gunzipSync(extracted), data);
    assert.equal(await verify(join(root, 'a/INDEX.json'), join(root, 'a')), 1);
    await assert.rejects(pack(index, source, join(root, 'a'), url), { code: 'EEXIST' });
    await writeFile(join(root, 'a/evidence.tar'), 'corrupt');
    await assert.rejects(verify(join(root, 'a/INDEX.json'), join(root, 'a')), /mismatch: evidence.tar/);
    await writeFile(join(root, 'a/evidence.tar'), await readFile(join(root, 'b/evidence.tar')));
    await writeFile(join(root, 'a/raw/result.json.gz'), 'corrupt');
    await assert.rejects(verify(join(root, 'a/INDEX.json'), join(root, 'a')), /mismatch: raw/);
    await writeFile(join(root, 'a/raw/result.json.gz'), gzip);
    a.artifacts[0].sha256 = '0'.repeat(64); await writeFile(join(root, 'a/INDEX.json'), JSON.stringify(a));
    await assert.rejects(verify(join(root, 'a/INDEX.json'), join(root, 'a')), /mismatch: result.json/);
    await writeFile(join(source, 'result.json'), 'changed');
    await assert.rejects(pack(index, source, join(root, 'changed'), url), /mismatch: result.json/);
    manifest.artifacts[0].sourceFile = '../outside'; await writeFile(index, JSON.stringify(manifest));
    await assert.rejects(pack(index, source, join(root, 'unsafe'), url), /Unsafe source/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new archive inventory is explicit, deterministic and rejects unsafe or changed inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'performance-inventory-'));
  try {
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'result.json'), '{"synthetic":true}\n');
    await writeFile(join(source, 'dataset.json'), '{"fixtureId":"synthetic"}\n');
    await writeFile(join(source, 'unselected.txt'), 'not evidence');
    await symlink(join(source, 'result.json'), join(source, 'link.json'));
    const index = join(root, 'recipe.json');
    const a = await createInventory(source, ['result.json', 'dataset.json'], index);
    const b = await createInventory(source, ['dataset.json', 'result.json'], join(root, 'other.json'));
    assert.deepEqual(a, b);
    assert.deepEqual(a.artifacts.map(row => row.sourceFile), ['dataset.json', 'result.json']);
    await assert.rejects(createInventory(source, ['result.json'], index), { code: 'EEXIST' });
    for (const files of [[], ['result.json', 'result.json'], ['../outside'], ['link.json']]) {
      await assert.rejects(createInventory(source, files, join(root, 'invalid.json')));
    }
    const url = 'https://github.com/yohn-jp/codexia/releases/download/test/evidence.tar';
    const output = join(root, 'archive');
    await pack(index, source, output, url);
    assert.deepEqual(execFileSync('tar', ['-tf', join(output, 'evidence.tar')], { encoding: 'utf8' }).trim().split('\n'),
      ['raw/', 'raw/dataset.json.gz', 'raw/result.json.gz']);
    assert.equal(await verify(join(output, 'INDEX.json'), output), 2);
    await writeFile(join(source, 'result.json'), 'changed');
    await assert.rejects(pack(index, source, join(root, 'changed'), url), /mismatch: result.json/);
    await rm(join(source, 'result.json'));
    await writeFile(join(root, 'replacement.json'), '{"synthetic":true}\n');
    await symlink(join(root, 'replacement.json'), join(source, 'result.json'));
    await assert.rejects(pack(index, source, join(root, 'linked'), url), { code: 'ELOOP' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
