import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { packSpecifications, verifySpecifications } from './specifications.mjs';

test('publishes only a clean exact-source StrictDoc export and rejects tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'pages-spec-'));
  try {
    const output = join(root, 'export'); const site = join(root, 'site');
    mkdirSync(join(output, 'html', 'requirements'), { recursive: true });
    mkdirSync(join(output, 'json'), { recursive: true });
    writeFileSync(join(output, 'html/index.html'), '<html><body>Requirements</body></html>');
    writeFileSync(join(output, 'html/requirements/REQUIREMENT-REGISTER.md-TRACE.html'), '<html><body>Trace</body></html>');
    writeFileSync(join(output, 'json/index.json'), '{}');
    const sha = 'a'.repeat(40);
    const rawFiles = ['html/index.html', 'html/requirements/REQUIREMENT-REGISTER.md-TRACE.html', 'json/index.json'].map(name => { const bytes=readFileSync(join(output,name)); return {name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}; });
    writeFileSync(join(output, 'trace-report.json'), JSON.stringify({ exports: { rawFiles }, source: { sourceSha: sha, worktreeClean: true, registerPath: 'docs/requirements/REQUIREMENT-REGISTER.md' }, toolchain: { strictdocVersion: '0.32.1', requirementsLockSha256: createHash('sha256').update(readFileSync('scripts/strictdoc/requirements.lock.txt')).digest('hex') }, traceability: { TRC01: { status: 'LOCAL_PASS' }, TRC02: { status: 'LOCAL_PASS' }, TRC07: { staticStaging: 'PASSED', browserAcceptance: 'PASSED' } } }));
    packSpecifications(site, output, sha);
    assert.equal(verifySpecifications(site, sha).sourceSha, sha);
    assert.match(readFileSync(join(site, 'requirements/html/index.html'), 'utf8'), /href="\.\.\/\.\.\/"/u);
    writeFileSync(join(site, 'requirements/html/index.html'), 'tampered');
    assert.throws(() => verifySpecifications(site, sha), /size|digest/i);
    assert.throws(() => packSpecifications(join(root, 'other'), output, 'c'.repeat(40)), /source/i);
    writeFileSync(join(output, 'json/index.json'), '{"stale":true}');
    assert.throws(() => packSpecifications(join(root, 'stale'), output, sha), /StrictDoc.*(?:size|digest)/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
