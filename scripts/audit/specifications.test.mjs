import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { packSpecifications, verifySpecifications } from './specifications.mjs';

test('[TEST-TRC-08-001] projects obligations, reverse surfaces, and evidence links without conformance promotion', () => {
  const root = mkdtempSync(join(tmpdir(), 'pages-spec-'));
  try {
    const output = join(root, 'export'); const site = join(root, 'site');
    mkdirSync(join(output, 'html', 'docs', 'requirements'), { recursive: true });
    mkdirSync(join(output, 'json'), { recursive: true });
    writeFileSync(join(output, 'html/index.html'), '<html><body>Requirements</body></html>');
    writeFileSync(join(output, 'html/docs/requirements/REQUIREMENT-REGISTER.sdoc-TRACE.html'),
      '<html><body><p id="verified">Trace</p><a href="./REQUIREMENT-REGISTER.sdoc-TRACE.html#meaning">Meaning</a><a href="#meaning">In-page meaning</a><a href="./REQUIREMENT-REGISTER.sdoc-TRACE.html#verified">Verified</a></body></html>');
    writeFileSync(join(output, 'html/docs/requirements/REQUIREMENT-REGISTER.sdoc.html'),
      '<html><body><p id="meaning">Meaning</p><a href="https://github.com/yohn-jp/codexia/blob/main/docs/design/screen-catalog.json">Model</a></body></html>');
    writeFileSync(join(output, 'json/index.json'), '{}');
    const sha = 'a'.repeat(40);
    const exactRun = { testId: 'TEST-TRC-01-001', sourceSha: sha, repository: 'yohn-jp/codexia', runId: '42', attempt: 1, job: 'specification', task: 'pages-requirements-trace', result: 'PASS', url: 'https://github.com/yohn-jp/codexia/actions/runs/42' };
    const rawFiles = ['html/index.html', 'html/docs/requirements/REQUIREMENT-REGISTER.sdoc-TRACE.html', 'html/docs/requirements/REQUIREMENT-REGISTER.sdoc.html', 'json/index.json'].sort().map(name => { const bytes=readFileSync(join(output,name)); return {name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}; });
    const report = {
      exports: { rawFiles },
      source: { sourceSha: sha, worktreeClean: true, documentScope: 'public', registerPath: 'docs/requirements/REQUIREMENT-REGISTER.sdoc' },
      toolchain: { strictdocVersion: '0.32.1', requirementsLockSha256: createHash('sha256').update(readFileSync('scripts/strictdoc/requirements.lock.txt')).digest('hex') },
      traceability: { TRC01: { status: 'LOCAL_PASS' }, TRC02: { status: 'LOCAL_PASS' }, TRC07: { status: 'PENDING_PAGES_PUBLISH', staticStaging: 'PASSED', browserAcceptance: 'PASSED' }, gates: Object.fromEntries(Array.from({length: 8}, (_, index) => [`G${index}`, {status: index === 0 ? 'LOCAL_PASS' : index === 7 ? 'PARTIAL' : 'NOT_RUN', evidence: `Gate ${index} evidence` }])) },
      obligationTrace: { rows: [{ requirementId: 'REQ-UI-001', obligationId: 'OBL-REQ-UI-001-O01', obligationText: 'Native UI remains separately accepted', decisionStatus: 'ACCEPTED', conformanceStatus: 'PARTIAL', applicability: 'CURRENT', requirementImplementationIdentifiers: ['Native state machine 未導入'], requirementComment: 'XState actorは目標・未実装', status: 'PARTIAL', designRefs: ['[Traceability design](STRICTDOC-TRACEABILITY.sdoc)'], sourceRefs: [{ path: 'scripts/strictdoc/case-results.mjs', range: '17, 28', LINE_RANGE: '17, 28' }], implementationIdentifiers: ['packages/api/src/job-history-store.ts: JobHistoryStore (target candidate)'], surfaceIdentifiers: [], testIds: ['TEST-TRC-01-001', 'TEST-TRC-02-001', 'TEST-TRC-03-001'], exactRuns: [exactRun] }], gaps: ['OBL-REQ-UI-001-O01: no semantic/device acceptance'] },
      reverseTrace: { rows: [
        { surface: { kind: 'mcpTool', id: 'list_projects' }, requirementId: 'REQ-UI-001', obligationId: 'OBL-REQ-UI-001-O01', status: 'UNVERIFIED', provenance: 'Literal registration', source: { path: 'scripts/strictdoc/reverse-trace.mjs', line: 18 }, testIds: ['TEST-TRC-01-001'], exactRuns: [exactRun] },
        { surface: { kind: 'mcpTool', id: 'unlinked.export' }, status: 'UNMAPPED', provenance: 'Literal registration', source: { path: 'scripts/strictdoc/reverse-trace.mjs', line: 19 }, inventoryClassification: 'candidate REQ-MCP-002; effect remains unverified', candidateRequirementIds: ['REQ-MCP-002'], testIds: [], exactRuns: [] },
      ], gaps: [{ kind: 'BLOCKED', provenance: 'Discovery limitation', area: 'native-ios-runtime', reason: 'Physical device not tested' }] },
      caseExecutions: [
        { testId: 'TEST-TRC-01-001', name: 'observed trace test', result: 'PASSED', sourceRefs: [{ path: 'scripts/strictdoc/verify.test.mjs', line: 23 }], file: 'scripts/strictdoc/verify.test.mjs', line: 23 },
        { testId: 'TEST-TRC-02-001', name: 'declared test not run', result: 'NOT_RUN', sourceRefs: [{ path: 'scripts/strictdoc/verify.test.mjs' }] },
        { testId: 'TEST-TRC-03-001', name: 'declared test skipped', result: 'SKIPPED', sourceRefs: [{ path: 'scripts/strictdoc/verify.test.mjs' }] },
      ],
      publication: { status: 'NOT_PUBLISHED', publisher: '.github/workflows/repository-audit.yml' },
      execution: { status: 'IN_PROGRESS', sourceSha: sha, repository: 'yohn-jp/codexia', runId: '42', runAttempt: 1, job: 'specification', task: 'pages-requirements-trace', runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/42' },
    };
    report.obligationTrace.rows.push({
      ...report.obligationTrace.rows[0],
      requirementId: 'REQ-UI-006', obligationId: 'OBL-REQ-UI-006-O01',
      requirementImplementationIdentifiers: ['WRT-01/REC-01 部分導入済み', 'ChangeSet・認証・バックアップは未実装'],
      requirementComment: 'XState v5 は部分導入済み。全受入は未認定。',
      testIds: [], exactRuns: [],
    });
    writeFileSync(join(output, 'trace-report.json'), JSON.stringify(report));
    packSpecifications(site, output, sha, { status: 'CERTIFIED', sourceSha: sha, repository: 'yohn-jp/codexia', runId: '43', attempt: 2, job: 'types', task: 'requirements-trace', runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/43', artifactId: 987, artifactDigest: 'sha256:' + 'd'.repeat(64), passedCaseIds: ['TEST-TRC-01-001'] });
    assert.equal(verifySpecifications(site, sha).sourceSha, sha);
    const publishedTrace = readFileSync(join(site, 'requirements/html/docs/requirements/REQUIREMENT-REGISTER.sdoc-TRACE.html'), 'utf8');
    assert.equal((publishedTrace.match(/REQUIREMENT-REGISTER\.sdoc\.html#meaning/gu) ?? []).length, 2);
    assert.match(publishedTrace, /REQUIREMENT-REGISTER\.sdoc-TRACE\.html#verified/u);
    const publishedDoc = readFileSync(join(site, 'requirements/html/docs/requirements/REQUIREMENT-REGISTER.sdoc.html'), 'utf8');
    assert.ok(publishedDoc.includes(`github.com/yohn-jp/codexia/blob/${sha}/docs/design/screen-catalog.json`));
    assert.match(readFileSync(join(site, 'requirements/html/index.html'), 'utf8'), /href="\.\.\/\.\.\/"/u);
    const tracePage = readFileSync(join(site, 'requirements/traceability/index.html'), 'utf8');
    const traceJson = JSON.parse(readFileSync(join(site, 'requirements/traceability/traceability.json'), 'utf8'));
    assert.match(tracePage, /REQ-UI-001/u);
    assert.match(tracePage, /no semantic\/device acceptance/u);
    assert.match(tracePage, /mcpTool/u);
    assert.equal(traceJson.sourceSha, sha);
    assert.equal(traceJson.pagesQualification.status, 'PENDING_PAGES_PUBLISH');
    assert.equal(traceJson.pagesQualification.sourceSha, sha);
    assert.equal(traceJson.pagesQualification.publicUrlConfirmation, 'PENDING');
    assert.equal(traceJson.verificationReceipt.status, 'CERTIFIED');
    assert.equal(traceJson.qualificationGates.G7.status, 'PARTIAL');
    assert.equal(traceJson.qualificationGates.G7.runStatus, undefined, 'private gate diagnostics must not be projected');
    assert.match(tracePage, /Specification qualification gates/u);
    assert.match(tracePage, /Gate 7 evidence/u);
    assert.equal(traceJson.verificationReceipt.artifactId, 987);
    assert.equal(traceJson.caseExecutions[0].verificationArtifact.url, 'https://github.com/yohn-jp/codexia/actions/runs/43/artifacts/987');
    assert.equal(traceJson.caseExecutions[1].verificationArtifact, undefined, 'artifact identity must only be attached to certified passed case IDs');
    assert.match(tracePage, /TRC-07 生成時点: <strong>PENDING_PAGES_PUBLISH<\/strong>/u);
    assert.equal(traceJson.requirements[0].conformanceStatus, 'PARTIAL');
    assert.equal(traceJson.requirements[0].implementationDeclarationStatus, 'EXPLICIT_NOT_IMPLEMENTED');
    assert.deepEqual(traceJson.requirements[0].implementationDeclarations.map(item => item.sourceField), ['Implementation identifiers', 'Comment']);
    assert.equal(traceJson.summary.implementationDeclarationCounts.EXPLICIT_NOT_IMPLEMENTED, 1);
    assert.equal(traceJson.caseExecutions[0].result, 'PASSED');
    assert.equal(traceJson.caseExecutions[0].sourceLinks[0].line, 23, 'discovered source line is retained');
    assert.match(traceJson.caseExecutions[0].sourceLinks[0].url, /#L23$/u, 'discovered source line is linked');
    assert.deepEqual(traceJson.caseExecutions[0].sourceRefs[0], { path: 'scripts/strictdoc/verify.test.mjs', line: 23 });
    assert.deepEqual(traceJson.obligations[0].sourceRefs[0], { path: 'scripts/strictdoc/case-results.mjs' }, 'legacy authored ranges are dropped');
    assert.equal(traceJson.execution.runUrl, 'https://github.com/yohn-jp/codexia/actions/runs/42');
    assert.equal(traceJson.obligations[0].exactRuns[0].job, 'specification');
    assert.equal(traceJson.requirements[0].area, 'UI');
    assert.equal(traceJson.summary.areaCounts.UI.obligationCount, 2);
    const partial = traceJson.requirements.find(item => item.requirementId === 'REQ-UI-006');
    assert.equal(partial.implementationDeclarationStatus, 'EXPLICIT_PARTIALLY_IMPLEMENTED');
    assert.equal(partial.conformanceStatus, 'PARTIAL');
    assert.equal(traceJson.summary.implementationDeclarationCounts.EXPLICIT_PARTIALLY_IMPLEMENTED, 1);
    assert.match(tracePage, /明示: 部分導入済み/u);
    assert.match(tracePage, /ChangeSet・認証・バックアップは未実装/u);
    assert.equal(traceJson.summary.reverseDispositionCounts.CANDIDATE_ONLY, 1);
    assert.match(tracePage, /id="surface-2"[^>]*data-status="UNMAPPED CANDIDATE_ONLY"/u);
    assert.match(tracePage, /id="surface-1"[^>]*data-status="UNVERIFIED LINKED"/u);
    assert.equal(traceJson.reverseTrace[1].requirementId, null, 'candidate IDs must not become accepted requirement links');
    assert.deepEqual(traceJson.reverseTrace[1].candidateRequirementIds, ['REQ-MCP-002']);
    assert.equal(traceJson.caseExecutions[1].result, 'NOT_RUN');
    assert.equal(traceJson.caseExecutions[1].sourceRefs[0].path, 'scripts/strictdoc/verify.test.mjs');
    assert.equal(traceJson.caseExecutions[2].result, 'SKIPPED');
    assert.equal(traceJson.caseExecutions[2].exactRuns.length, 0, 'a skip must not create passing run evidence');
    assert.equal(traceJson.summary.evidenceFreshness.status, 'IN_PROGRESS');
    assert.equal(traceJson.summary.evidenceFreshness.sourceSha, sha);
    assert.deepEqual(traceJson.obligations[0].implementationLinks, [{
      identifier: 'packages/api/src/job-history-store.ts: JobHistoryStore (target candidate)',
      path: 'packages/api/src/job-history-store.ts',
      url: `https://github.com/yohn-jp/codexia/blob/${sha}/packages/api/src/job-history-store.ts`,
    }]);
    assert.equal(traceJson.referenceAudit.broken.length, 0);
    assert.match(tracePage, /<search\b/u);
    assert.match(tracePage, /name="area"/u);
    assert.match(tracePage, new RegExp(`https://github\\.com/yohn-jp/codexia/blob/${sha}/docs/requirements/STRICTDOC-TRACEABILITY\\.sdoc`, 'u'));
    assert.match(tracePage, /href="#obligation-OBL-REQ-UI-001-O01"/u);
    assert.match(tracePage, /href="#test-TEST-TRC-01-001"/u);
    assert.match(tracePage, /NOT_RUN/u);
    assert.match(tracePage, /SKIPPED/u);
    assert.match(tracePage, /TRACE.html/u, 'StrictDoc standard trace matrix remains directly linked');
    assert.match(tracePage, /明示: 未実装/u);
    assert.match(tracePage, /宣言なしを実装済みとは扱いません/u);

    const staleReference = structuredClone(report);
    staleReference.obligationTrace.rows[0].implementationIdentifiers.push('packages/api/src/missing-implementation.ts: MissingImplementation');
    staleReference.obligationTrace.rows[0].sourceRefs.push({ path: 'packages/api/src/missing-trace-target.ts' });
    staleReference.reverseTrace.gaps.push({ kind: 'BLOCKED', source: { path: 'packages/api/src/missing-gap-source.ts' } });
    staleReference.obligationTrace.gaps.push('OBL-REQ-UI-001-O01: no exact-source run evidence for TEST-TRC-02-001');
    writeFileSync(join(output, 'trace-report.json'), JSON.stringify(staleReference));
    const staleSite = join(root, 'stale-reference');
    packSpecifications(staleSite, output, sha);
    const staleTrace = JSON.parse(readFileSync(join(staleSite, 'requirements/traceability/traceability.json'), 'utf8'));
    assert.ok(staleTrace.referenceAudit.broken.some(item => item.kind === 'implementation' && item.path === 'packages/api/src/missing-implementation.ts'));
    assert.ok(staleTrace.referenceAudit.broken.some(item => item.path === 'packages/api/src/missing-trace-target.ts'));
    assert.ok(staleTrace.referenceAudit.broken.some(item => item.path === 'packages/api/src/missing-gap-source.ts'));
    assert.equal(staleTrace.summary.brokenReferenceCount, staleTrace.referenceAudit.broken.length);
    assert.deepEqual(staleTrace.verificationReceipt, { status: 'NOT_AVAILABLE', sourceSha: sha }, 'missing Verify certification must remain explicit');
    assert.match(readFileSync(join(staleSite, 'requirements/traceability/index.html'), 'utf8'), /data-status="UNVERIFIED"[^>]*data-search="[^"]*no exact-source run evidence/u);
    assert.match(readFileSync(join(staleSite, 'requirements/traceability/index.html'), 'utf8'), /missing-trace-target\.ts/u);
    writeFileSync(join(output, 'trace-report.json'), JSON.stringify(report));

    for (const [name, mutate, message] of [
      ['pages-complete-without-public-proof', data => { data.traceability.TRC07.status = 'PASSED'; }, /TRC-07/iu],
      ['foreign-publisher-claim', data => { data.publication.publisher = 'other-workflow.yml'; }, /publication claim/iu],
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
    const browserCase = report.caseExecutions[1];
    browserCase.sourceRefs = [{ path: 'tests/e2e/ui-v1.acceptance.spec.ts', line: 238 }];
    report.obligationTrace.gaps.push('OBL-REQ-UI-001-O01: no exact-source run evidence for TEST-TRC-02-001');
    writeFileSync(join(output, 'trace-report.json'), JSON.stringify(report));
    const browserSite = join(root, 'browser');
    const browserReceipt = { status: 'CERTIFIED', sourceSha: sha, repository: 'yohn-jp/codexia', runId: '43', attempt: 2, job: 'types',
      task: 'requirements-trace', runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/43', artifactId: 987,
      artifactDigest: 'sha256:' + 'd'.repeat(64), passedCaseIds: ['TEST-TRC-01-001'], productBrowser: [{
        job: 'browser-core-ui-v1', task: 'browser-core-ui-v1', attempt: 1, profile: 'core', project: 'chromium',
        artifactId: 654, artifactDigest: 'sha256:' + 'e'.repeat(64), passedCaseIds: ['TEST-TRC-02-001'],
      }],
    };
    packSpecifications(browserSite, output, sha, browserReceipt);
    const browserTrace = JSON.parse(readFileSync(join(browserSite, 'requirements/traceability/traceability.json'), 'utf8'));
    assert.equal(browserTrace.caseExecutions[1].result, 'PASSED');
    assert.equal(browserTrace.qualificationGates.G4.status, 'PARTIAL');
    assert.equal(browserTrace.caseExecutions[1].exactRuns[0].artifactId, 654);
    assert.equal(browserTrace.caseExecutions[1].exactRuns[0].attempt, 1);
    assert.equal(browserTrace.caseExecutions[1].exactRuns[0].sourceSha, sha);
    assert.deepEqual(browserTrace.obligations[0].exactRuns[1], browserTrace.caseExecutions[1].exactRuns[0]);
    assert.equal(browserTrace.obligations[0].conformanceStatus, 'PARTIAL');
    assert.equal(browserTrace.caseExecutions[2].result, 'SKIPPED');
    assert.ok(!browserTrace.gaps.obligations.some(gap => gap.includes('no exact-source run evidence for TEST-TRC-02-001')));
    const browserHtml = readFileSync(join(browserSite, 'requirements/traceability/index.html'), 'utf8');
    assert.match(browserHtml, /core\/chromium · run 43 \/ attempt 1 · artifact 654/u);
    browserReceipt.productBrowser[0].passedCaseIds = ['TEST-TRC-03-001'];
    assert.throws(() => packSpecifications(join(root, 'foreign-browser-case'), output, sha, browserReceipt), /foreign case/u);
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
