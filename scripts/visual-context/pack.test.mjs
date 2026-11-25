import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, pngDimensions, validateCaptureSet, renderPackDocuments, verifyZip } from './pack.mjs';

const digest = 'a'.repeat(64);
const targets = [
  { id: 'library-empty', fileName: '001-library-empty.png', screenId: 'LIB-01', scenarioId: 'atlas-lib-01', label: '空の作品一覧', purpose: '作品を作成・選択します。', operations: ['作品を作成'] },
  { id: 'writing', fileName: '002-writing.png', screenId: 'WRT-01', scenarioId: 'atlas-wrt-01', label: '執筆ワークスペース', purpose: '本文を編集します。', operations: ['保存'] },
];
const themes = ['light', 'dark'];
const shots = targets.flatMap(target => themes.map((theme, themeIndex) => ({
  targetId: target.id,
  screenId: target.screenId,
  scenarioId: target.scenarioId,
  theme,
  path: `${theme}/${target.fileName}`,
  status: 'success',
  width: 1920,
  height: 1080,
  bytes: 512 + themeIndex,
  sha256: digest,
})));

test('capture inventory requires each canonical visual state in every theme exactly once', () => {
  const result = validateCaptureSet({ targets, themes, screenshots: shots });
  assert.deepEqual(result, { targetCount: 2, screenshotTargetCount: 4, successCount: 4 });
  assert.throws(() => validateCaptureSet({ targets, themes, screenshots: shots.slice(1) }), /missing capture/u);
  assert.throws(() => validateCaptureSet({ targets, themes, screenshots: [...shots, shots[0]] }), /Duplicate capture/u);
  assert.throws(() => validateCaptureSet({ targets, themes, screenshots: shots.map((shot, i) => i === 0 ? { ...shot, status: 'skipped' } : shot) }), /not successful/u);
  assert.throws(() => validateCaptureSet({ targets, themes, screenshots: shots.map((shot, i) => i === 0 ? { ...shot, width: 1440 } : shot) }), /1920×1080/u);
});

test('PNG header validation reads the exact viewport dimensions and rejects non-PNG data', () => {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(1920, 16);
  header.writeUInt32BE(1080, 20);
  assert.deepEqual(pngDimensions(header), { width: 1920, height: 1080 });
  assert.throws(() => pngDimensions(Buffer.from('not an image')), /PNG/u);
});

test('README and manifest are self-contained and map images to canonical screen/scenario metadata', () => {
  const documents = renderPackDocuments({
    sourceSha: 'b'.repeat(40),
    generatedAt: '2026-11-25T12:00:00.000Z',
    environment: { platform: 'desktop', browser: 'Chromium 140.0', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'ja-JP', timezone: 'Asia/Tokyo' },
    themes,
    fixture: 'Deterministic synthetic PostgreSQL author fixture.',
    targets,
    screenshots: shots,
    exclusions: [{ id: 'PUB-01', reason: 'Reader platform is outside this desktop capture.' }],
    timings: { buildMs: 10, fixtureStartMs: 20, captureMs: 30, zipMs: 40 },
  });
  const manifest = JSON.parse(documents.manifest);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.commitSha, 'b'.repeat(40));
  assert.equal(manifest.coverage.targetCount, 4);
  assert.equal(manifest.coverage.successCount, 4);
  assert.equal(manifest.screenshots[0].scenarioId, 'atlas-lib-01');
  assert.ok(documents.readme.includes('Codexia'));
  assert.ok(documents.readme.includes('atlas-lib-01'));
  assert.ok(documents.readme.includes('light/001-library-empty.png'));
  assert.ok(documents.readme.includes('synthetic PostgreSQL'));
  assert.ok(documents.readme.includes('PUB-01'));
  assert.ok(documents.readme.includes('2026-11-25T12:00:00.000Z'));
});

test('ZIP is valid, uncompressed and repeatable for identical pack files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codexia-vcp-test-'));
  try {
    const pack = join(directory, 'pack');
    mkdirSync(join(pack, 'light'), { recursive: true });
    writeFileSync(join(pack, 'README.md'), '# Codexia\n');
    writeFileSync(join(pack, 'light', '001-library.png'), Buffer.alloc(128, 7));
    const first = join(directory, 'one.zip');
    const second = join(directory, 'two.zip');
    const firstResult = createZip(pack, first);
    const secondResult = createZip(pack, second);
    assert.deepEqual(firstResult, secondResult);
    assert.deepEqual(readFileSync(first), readFileSync(second));
    assert.deepEqual(verifyZip(first, ['README.md', 'light/001-library.png']), firstResult);
    assert.match(execFileSync('unzip', ['-t', first], { encoding: 'utf8' }), /No errors detected/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
