import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const THEME = /^[a-z0-9-]+$/u;
const CAPTURE_ID = /^[a-z0-9-]+$/u;
const SCREEN_ID = /^[A-Z]+-\d{2}$/u;
const ORDER = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function pngDimensions(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 24, 'Invalid PNG file');
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'Image is not a PNG file');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', 'PNG header has no IHDR chunk');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0, 'PNG has an empty viewport');
  return { width, height };
}

/** Reject incomplete, duplicated, skipped, extra, or non-standard viewport captures. */
export function validateCaptureSet({ targets, themes, screenshots }) {
  assert.ok(Array.isArray(targets) && targets.length > 0, 'No visual capture targets');
  assert.ok(Array.isArray(themes) && themes.length > 0 && new Set(themes).size === themes.length, 'Invalid theme inventory');
  assert.ok(Array.isArray(screenshots), 'Screenshot inventory is required');
  const targetIds = new Set();
  for (const target of targets) {
    assert.ok(target && CAPTURE_ID.test(target.id), 'Invalid capture target ID');
    assert.ok(!targetIds.has(target.id), 'Duplicate capture target');
    targetIds.add(target.id);
    assert.ok(SCREEN_ID.test(target.screenId), 'Invalid canonical screen ID');
    assert.ok(typeof target.scenarioId === 'string' && target.scenarioId.length > 0, 'Missing canonical scenario ID');
  }
  for (const theme of themes) assert.ok(THEME.test(theme), 'Invalid theme ID');
  const expected = new Set(targets.flatMap(target => themes.map(theme => `${target.id}\0${theme}`)));
  const seen = new Set();
  const paths = new Set();
  for (const shot of screenshots) {
    assert.ok(shot && targetIds.has(shot.targetId), 'Unknown capture target');
    assert.ok(themes.includes(shot.theme), 'Unknown capture theme');
    const key = `${shot.targetId}\0${shot.theme}`;
    assert.ok(!seen.has(key), 'Duplicate capture target/theme');
    seen.add(key);
    assert.equal(shot.status, 'success', `Capture ${shot.targetId}/${shot.theme} was not successful`);
    assert.equal(shot.width, 1920, `Capture ${shot.targetId}/${shot.theme} is not 1920×1080`);
    assert.equal(shot.height, 1080, `Capture ${shot.targetId}/${shot.theme} is not 1920×1080`);
    assert.ok(Number.isSafeInteger(shot.bytes) && shot.bytes > 64, 'Capture file is empty or invalid');
    assert.ok(DIGEST.test(shot.sha256), 'Capture digest is invalid');
    assert.ok(typeof shot.path === 'string' && shot.path === shot.path.replaceAll('\\', '/')
      && !shot.path.startsWith('/') && !shot.path.split('/').some(part => part === '.' || part === '..' || !part), 'Unsafe screenshot path');
    assert.ok(shot.path.startsWith(`${shot.theme}/`) && shot.path.endsWith('.png'), 'Screenshot path does not match its theme');
    assert.ok(!paths.has(shot.path), 'Duplicate screenshot path');
    paths.add(shot.path);
  }
  for (const key of expected) assert.ok(seen.has(key), `missing capture for ${key.replace('\0', '/')}`);
  for (const key of seen) assert.ok(expected.has(key), `unexpected capture for ${key.replace('\0', '/')}`);
  return { targetCount: targets.length, screenshotTargetCount: expected.size, successCount: seen.size };
}

function safeTree(root) {
  const entries = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort(ORDER)) {
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      assert.ok(!stat.isSymbolicLink(), 'Visual pack may not contain symlinks');
      if (stat.isDirectory()) visit(absolute);
      else {
        assert.ok(stat.isFile(), 'Visual pack may contain only regular files');
        const path = relative(root, absolute).split(sep).join('/');
        assert.ok(path && !path.split('/').some(part => part === '.' || part === '..'), 'Unsafe Visual pack path');
        entries.push({ absolute, path });
      }
    }
  }
  visit(root);
  return entries.sort((a, b) => ORDER(a.path, b.path));
}

/** Return file evidence from actual image files, and fail on missing/extra PNGs. */
export function inspectCaptureFiles({ captureDirectory, targets, themes, screenshots }) {
  const root = resolve(captureDirectory);
  assert.ok(existsSync(root) && lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Capture directory is unavailable');
  const plannedPaths = new Set(targets.flatMap(target => themes.map(theme => `${theme}/${target.fileName}`)));
  const files = safeTree(root);
  const actualPngs = files.filter(file => file.path.endsWith('.png')).map(file => file.path);
  assert.deepEqual(actualPngs.sort(ORDER), [...plannedPaths].sort(ORDER), 'Capture directory does not match the planned screenshot inventory');
  const capturedByPath = new Map(screenshots.map(shot => [shot.path, shot]));
  return files.filter(file => file.path.endsWith('.png')).map(file => {
    const bytes = readFileSync(file.absolute);
    const dimensions = pngDimensions(bytes);
    const record = capturedByPath.get(file.path);
    assert.ok(record, `Screenshot is missing capture metadata: ${file.path}`);
    assert.equal(dimensions.width, record.width, `PNG header width differs from capture record: ${file.path}`);
    assert.equal(dimensions.height, record.height, `PNG header height differs from capture record: ${file.path}`);
    assert.equal(bytes.length, record.bytes, `PNG byte length differs from capture record: ${file.path}`);
    assert.equal(sha256(bytes), record.sha256, `PNG digest differs from capture record: ${file.path}`);
    return { ...record, width: dimensions.width, height: dimensions.height, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

export function renderPackDocuments({ sourceSha, generatedAt, environment, themes, fixture, targets, screenshots, exclusions, timings = {} }) {
  assert.ok(SHA.test(sourceSha), 'Expected a full commit SHA');
  assert.ok(Number.isFinite(Date.parse(generatedAt)), 'Invalid generation timestamp');
  const coverage = validateCaptureSet({ targets, themes, screenshots });
  const targetById = new Map(targets.map(target => [target.id, target]));
  const pngBytes = screenshots.reduce((sum, shot) => sum + shot.bytes, 0);
  const manifest = {
    schemaVersion: 1,
    product: { name: 'Codexia', purpose: 'Desktop writing workspace for organizing manuscripts, references, and review work.' },
    commitSha: sourceSha,
    generatedAt,
    environment,
    themes,
    fixture,
    captureTargets: targets.map(({ id, screenId, scenarioId, label, screenTitle, purpose, operations, fileName }) => ({
      id, screenId, scenarioId, label, screenTitle, purpose, operations, fileName,
    })),
    screenshots: screenshots.map(({ targetId, theme, path, status, width, height, bytes, sha256: digest }) => {
      const { screenId, scenarioId } = targetById.get(targetId);
      return { targetId, screenId, scenarioId, theme, path, result: status, width, height, bytes, sha256: digest };
    }),
    coverage: {
      targetCount: coverage.screenshotTargetCount,
      successCount: coverage.successCount,
      stateCount: coverage.targetCount,
      themeCount: themes.length,
      imageCount: screenshots.length,
      pngBytes,
    },
    timings: {
      buildMs: timings.buildMs ?? null,
      fixtureStartMs: timings.fixtureStartMs ?? null,
      playwrightMs: timings.playwrightMs ?? null,
      captureMs: timings.captureMs ?? null,
      zipMs: null,
    },
    exclusions,
  };
  const targetRows = targets.map(target => {
    const paths = screenshots.filter(shot => shot.targetId === target.id).map(shot => `\`${shot.path}\``).join(', ');
    return `| ${target.screenId} | ${target.scenarioId} | ${target.label} | ${target.purpose} | ${target.operations.join('、') || '—'} | ${paths} |`;
  }).join('\n');
  const exclusionRows = exclusions.length
    ? exclusions.map(item => `| ${item.id} | ${item.reason} |`).join('\n')
    : '| — | — |';
  const readme = `# Codexia Visual Context Pack\n\n\
Codexiaは、執筆者が作品の構成・本文・知識参照・提案レビューを行うDesktop執筆ワークスペースです。このPackは、外部AIによるUI/UX監査とデザイン改善に使う、実プロダクトUIのスクリーンショット集です。UX Simulatorの画面ではなく、CodexiaのDesktopアプリをPlaywrightで描画しています。\n\n\
## Source and capture conditions\n\n\
- Commit SHA: \`${sourceSha}\`\n- Generated at (UTC): \`${generatedAt}\`\n- Platform: ${environment.platform}\n- Browser: ${environment.browser}\n- Viewport: ${environment.viewport.width}×${environment.viewport.height} CSS px; device scale factor ${environment.deviceScaleFactor}\n- Locale / time zone: ${environment.locale} / ${environment.timezone}\n- Themes: ${themes.join(', ')}\n- Fixture: ${fixture}\n- PNG images: ${screenshots.length}; total ${pngBytes} bytes\n\n\
## Screens and scenarios\n\n\
The screen purpose, control labels, and journey IDs below come from Codexia's canonical Screen Control Catalog and Screen State Atlas. Each filename is repeated in every theme directory. The filename prefix is the stable capture order; the capture state suffix distinguishes meaningful visual states within a canonical scenario.\n\n\
| Screen | Scenario | Captured state | Purpose | Main operations | Images |\n| --- | --- | --- | --- | --- | --- |\n${targetRows}\n\n\
## Fixture and limits\n\n\
Every image uses a disposable PostgreSQL/Better Auth E2E fixture with synthetic deterministic Japanese manuscript, Knowledge, Revision, and proposal data. No production endpoint, real user data, credentials, or secrets are included. The same canonical Playwright visual manuscript fixture is shared with the existing Desktop visual acceptance test.\n\n\
This pack covers Desktop Chromium at one resolution. It does not cover mobile, native iOS, other browsers or resolutions, video, UX Simulator controls/debug output, separate authentication-only screens, the public Reader, or Console screens outside the Desktop authoring shell. Targets without a separate implemented Desktop surface are listed below.\n\n\
| Excluded screen/scenario | Reason |\n| --- | --- |\n${exclusionRows}\n\n\
Full machine-readable evidence, image digests, timing, and coverage counts are in [manifest.json](manifest.json).\n`;
  return { manifest: json(manifest), readme, manifestObject: manifest };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zipPath(path) {
  assert.ok(path && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe ZIP entry path');
  return Buffer.from(path, 'utf8');
}

/** Build an uncompressed, timestamp-normalized ZIP suitable for already-compressed PNGs. */
export function createZip(sourceDirectory, zipFile) {
  const root = resolve(sourceDirectory);
  assert.ok(existsSync(root) && lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Pack output directory is unavailable');
  const entries = safeTree(root).map(({ absolute, path }) => {
    const name = zipPath(path);
    const data = readFileSync(absolute);
    return { name, data, crc: crc32(data) };
  });
  assert.ok(entries.length > 0, 'Cannot create an empty Visual Context Pack ZIP');
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    assert.ok(entry.data.length <= 0xffffffff && offset <= 0xffffffff, 'Visual Context Pack exceeds non-ZIP64 archive limits');
    const local = Buffer.alloc(30 + entry.name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12); // 1980-01-01 UTC for reproducible archive metadata.
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    local.writeUInt16LE(0, 28);
    entry.name.copy(local, 30);
    locals.push(local, entry.data);

    const directory = Buffer.alloc(46 + entry.name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(entry.crc, 16);
    directory.writeUInt32LE(entry.data.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(entry.name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    entry.name.copy(directory, 46);
    central.push(directory);
    offset += local.length + entry.data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const result = Buffer.concat([...locals, centralBytes, end]);
  mkdirSync(dirname(resolve(zipFile)), { recursive: true });
  writeFileSync(zipFile, result);
  return { bytes: result.length, sha256: sha256(result), entryCount: entries.length };
}

export function verifyZip(zipFile, expectedFiles) {
  const bytes = readFileSync(zipFile);
  assert.ok(bytes.length >= 22 && bytes.readUInt32LE(bytes.length - 22) === 0x06054b50, 'ZIP end record is missing');
  const centralOffset = bytes.readUInt32LE(bytes.length - 22 + 16);
  let cursor = centralOffset;
  const paths = [];
  while (cursor < bytes.length - 22) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50, 'Invalid ZIP central directory');
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    paths.push(bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.deepEqual(paths, [...expectedFiles].sort(ORDER), 'ZIP contents do not match the generated pack files');
  return { bytes: bytes.length, sha256: sha256(bytes), entryCount: paths.length };
}
