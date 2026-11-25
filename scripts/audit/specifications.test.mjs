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
    const exactRun = { testId: 'TEST-TRC-01-001', sourceSha: sha, repository: 'yohn-jp/codexia', runId: '42', attempt: 1, job: 'specification', task: 'pages-requirements-trace', result: 'PASS', url: 'https://github.com/yohn-jp/codexia/actions/runs/42' };
    const rawFiles = ['html/index.html', 'html/requirements/REQUIREMENT-REGISTER.md-TRACE.html', 'json/index.json'].map(name => { const bytes=readFileSync(join(output,name)); return {name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}; });
    const report = {
      exports: { rawFiles },
      source: { sourceSha: sha, worktreeClean: true, registerPath: 'docs/requirements/REQUIREMENT-REGISTER.md' },
      toolchain: { strictdocVersion: '0.32.1', requirementsLockSha256: createHash('sha256').update(readFileSync('scripts/strictdoc/requirements.lock.txt')).digest('hex') },
      traceability: { TRC01: { status: 'LOCAL_PASS' }, TRC02: { status: 'LOCAL_PASS' }, TRC07: { staticStaging: 'PASSED', browserAcceptance: 'PASSED' } },
      obligationTrace: { rows: [{ requirementId: 'REQ-UI-001', obligationId: 'OBL-REQ-UI-001-O01', obligationText: 'Native UI remains separately accepted', decisionStatus: 'ACCEPTED', conformanceStatus: 'PARTIAL', applicability: 'CURRENT', status: 'PARTIAL', designRefs: ['IOS-SWIFTUI-ARCHITECTURE.md'], sourceRefs: [{ path: 'ios/CodexiaApp/Sources/CodexiaApp.swift' }], testIds: ['TEST-TRC-01-001'], exactRuns: [exactRun] }], gaps: ['OBL-REQ-UI-001-O01: no semantic/device acceptance'] },
      reverseTrace: { rows: [{ surface: { kind: 'nativeIosView', id: 'AuthoringView' }, requirementId: 'REQ-UI-001', obligationId: 'OBL-REQ-UI-001-O01', status: 'UNVERIFIED', exactRuns: [exactRun] }], gaps: [{ kind: 'BLOCKED', provenance: 'Discovery limitation', area: 'native-ios-runtime', reason: 'Physical device not tested' }] },
      caseExecutions: [{ testId: 'TEST-TRC-01-001', result: 'PASSED', file: 'scripts/strictdoc/verify.test.mjs', line: 12 }],
      execution: { status: 'IN_PROGRESS', sourceSha: sha, repository: 'yohn-jp/codexia', runId: '42', runAttempt: 1, job: 'specification', task: 'pages-requirements-trace', runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/42' },
    };
    writeFileSync(join(output, 'trace-report.json'), JSON.stringify(report));
    packSpecifications(site, output, sha);
    assert.equal(verifySpecifications(site, sha).sourceSha, sha);
    assert.match(readFileSync(join(site, 'requirements/html/index.html'), 'utf8'), /href="\.\.\/\.\.\/"/u);
    const tracePage = readFileSync(join(site, 'requirements/traceability/index.html'), 'utf8');
    const traceJson = JSON.parse(readFileSync(join(site, 'requirements/traceability/traceability.json'), 'utf8'));
    assert.match(tracePage, /REQ-UI-001/u);
    assert.match(tracePage, /no semantic\/device acceptance/u);
    assert.match(tracePage, /nativeIosView/u);
    assert.equal(traceJson.sourceSha, sha);
    assert.equal(traceJson.requirements[0].conformanceStatus, 'PARTIAL');
    assert.equal(traceJson.caseExecutions[0].result, 'PASSED');
    assert.equal(traceJson.execution.runUrl, 'https://github.com/yohn-jp/codexia/actions/runs/42');
    assert.equal(traceJson.obligations[0].exactRuns[0].job, 'specification');

    for (const [name, mutate, message] of [
      ['obligation-job', data => { data.obligationTrace.rows[0].exactRuns[0].job = 'other-job'; }, /job/iu],
      ['obligation-task', data => { data.obligationTrace.rows[0].exactRuns[0].task = 'other-task'; }, /task/iu],
      ['unobserved-test', data => { data.obligationTrace.rows[0].exactRuns[0].testId = 'TEST-TRC-02-001'; }, /TEST-ID|test execution/iu],
      ['reverse-evidence', data => { data.reverseTrace.rows[0].exactRuns[0].runId = '43'; }, /run mismatch|reverse trace exact-run evidence mismatch/iu],
    ]) {
      const invalid = structuredClone(report);
      mutate(invalid);
      writeFileSync(join(output, 'trace-report.json'), JSON.stringify(invalid));
      assert.throws(() => packSpecifications(join(root, `bad-${name}`), output, sha), message);
    }
    writeFileSync(join(output, 'trace-report.json'), JSON.stringify(report));
    writeFileSync(join(site, 'requirements/html/index.html'), 'tampered');
    assert.throws(() => verifySpecifications(site, sha), /size|digest/i);
    assert.throws(() => packSpecifications(join(root, 'other'), output, 'c'.repeat(40)), /source/i);
    writeFileSync(join(output, 'json/index.json'), '{"stale":true}');
    assert.throws(() => packSpecifications(join(root, 'stale'), output, sha), /StrictDoc.*(?:size|digest)/i);
    report.execution.sourceSha = 'b'.repeat(40);
    writeFileSync(join(output, 'trace-report.json'), JSON.stringify(report));
    assert.throws(() => packSpecifications(join(root, 'bad-execution'), output, sha), /exact.source/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
