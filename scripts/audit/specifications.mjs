#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decoratePage } from '../pages-ui/navigation.mjs';
import { isNativeSpecification, isDesignProjectionModel } from '../ci/evidence/task-inputs.mjs';
import { BROWSER_SHARDS, VERIFICATION_GROUPS } from '../ci/impact/contract.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const esc = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function exactExecution(execution, sourceSha) {
  assert.ok(execution && typeof execution === 'object', 'StrictDoc execution identity missing');
  if (execution.status === 'NOT_RUN') return { status: 'NOT_RUN', sourceSha };
  assert.equal(execution.status, 'IN_PROGRESS', 'Invalid StrictDoc execution status');
  assert.equal(execution.sourceSha, sourceSha, 'StrictDoc exact-source execution SHA mismatch');
  assert.equal(execution.repository, TRACE_REPOSITORY, 'StrictDoc execution repository mismatch');
  assert.match(String(execution.runId ?? ''), /^\d+$/u, 'Invalid execution run ID');
  assert.ok(Number.isInteger(execution.runAttempt) && execution.runAttempt > 0, 'Invalid execution attempt');
  assert.ok(typeof execution.job === 'string' && !/\s/u.test(execution.job), 'Invalid execution job');
  assert.ok(typeof execution.task === 'string' && !/\s/u.test(execution.task), 'Invalid execution task');
  assert.equal(execution.job, 'specification', 'StrictDoc report came from a foreign Pages job');
  assert.equal(execution.task, 'pages-requirements-trace', 'StrictDoc report came from a foreign Pages task');
  assert.equal(execution.runUrl, `https://github.com/${execution.repository}/actions/runs/${execution.runId}`, 'Execution URL does not match exact run identity');
  return {
    status: 'IN_PROGRESS', sourceSha, repository: execution.repository, runId: execution.runId,
    attempt: execution.runAttempt, job: execution.job, task: execution.task, runUrl: execution.runUrl,
  };
}

function publicExactRuns(items, testIds, execution, caseById) {
  return items.map(item => {
    assert.ok(testIds.includes(item.testId), `Exact-source evidence references undeclared TEST-ID ${item.testId}`);
    assert.equal(item.sourceSha, execution.sourceSha, 'StrictDoc exact-source run evidence SHA mismatch');
    assert.equal(item.repository, execution.repository, 'StrictDoc exact-source run evidence repository mismatch');
    assert.equal(String(item.runId), String(execution.runId), 'StrictDoc exact-source run evidence run mismatch');
    assert.equal(item.attempt, execution.attempt, 'StrictDoc exact-source run evidence attempt mismatch');
    assert.equal(item.job, execution.job, 'StrictDoc exact-source run evidence job mismatch');
    assert.equal(item.task, execution.task, 'StrictDoc exact-source run evidence task mismatch');
    assert.equal(item.url, execution.runUrl, 'StrictDoc exact-source run evidence URL mismatch');
    assert.ok(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(item.result), 'Invalid exact-source run result');
    const resultByCase = { PASS: 'PASSED', FAIL: 'FAILED', BLOCKED: 'BLOCKED', NOT_RUN: 'NOT_RUN' };
    assert.equal(caseById.get(item.testId)?.result, resultByCase[item.result], `Exact-source evidence does not match observed test execution for ${item.testId}`);
    return { testId: item.testId, sourceSha: execution.sourceSha, repository: item.repository, runId: String(item.runId), attempt: item.attempt, job: item.job, task: item.task, result: item.result, url: item.url };
  });
}

const TRACE_INPUTS = ['docs/architecture/DOCUMENTATION-AUTHORITY.sdoc', 'docs/architecture/MCP-V2-MIGRATION.sdoc', 'docs/architecture/SPECIFICATION-IMPLEMENTATION-CONTRACT.sdoc', 'docs/architecture/SPECIFICATION-TOOLCHAIN.sdoc', 'docs/requirements/REQUIREMENTS-GOVERNANCE.sdoc', 'docs/requirements/REQUIREMENT-REGISTER.sdoc', 'docs/requirements/STRICTDOC-TRACEABILITY.sdoc', 'docs/requirements/codexia.sgra', 'docs/verification/TRACEABILITY-REGISTER.sdoc', 'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.sdoc', 'scripts/strictdoc/strictdoc_config.py', 'scripts/strictdoc/surface-inventory.json', 'scripts/strictdoc/requirements.lock.txt', 'scripts/strictdoc/verify.mjs', 'scripts/strictdoc/test-sources.mjs', 'scripts/strictdoc/test-source-path.mjs', 'scripts/strictdoc/ansible-source-graph.mjs', 'scripts/strictdoc/obligation-trace.mjs', 'scripts/strictdoc/reverse-trace.mjs', 'scripts/strictdoc/case-results.mjs', 'scripts/ci/evidence/trace-receipt.mjs', 'scripts/ci/evidence/download-artifacts.mjs', 'scripts/ci/browser/coverage-reporter.mjs', 'scripts/ci/browser/shards.mjs', 'scripts/ci/impact/contract.mjs', 'scripts/audit/specifications.mjs', 'scripts/audit/traceability.css', 'scripts/audit/traceability-ui.js', 'scripts/pages-ui/navigation.mjs', 'scripts/pages-ui/navigation.css', 'scripts/pages-ui/navigation.js'];
const TRACE_REPOSITORY = 'yohn-jp/codexia';
const AREA_LABELS = { API: 'API', AUTH: '認証', CORE: 'Core', DATA: 'DB', EXT: '外部IF・IaC', MCP: 'MCP', OPS: 'デプロイ・運用', QUAL: '品質', TRACE: '追跡基盤', UI: 'Desktop UI', IOS: 'Native iOS', OTHER: 'その他' };
const SURFACE_AREA_LABELS = { ...AREA_LABELS, EXT: 'IaC', EXTIF: 'External IF' };
const SURFACE_AREAS = [
  [/^httpExternalOperation$/u, 'EXTIF'], [/^http/u, 'API'], [/^mcp/u, 'MCP'], [/^database/u, 'DATA'], [/^uiControl/u, 'UI'],
  [/^nativeIos/u, 'IOS'], [/^iacResource$/u, 'EXT'], [/^ansibleSource$/u, 'OPS'], [/^ciWorkflow$/u, 'QUAL'],
  [/^(?:backup|deployment)/u, 'OPS'],
];

function traceInputDigests() {
  const tracked = execFileSync('git', ['ls-files', '-z', 'docs'], { encoding: 'utf8' }).split('\0');
  const inputs = new Set([...TRACE_INPUTS, ...tracked.filter(path => isNativeSpecification(path) || isDesignProjectionModel(path))]);
  return [...inputs].sort().map(path => ({ path, sha256: hash(readFileSync(path)) }));
}

function requirementArea(requirementId) { return requirementId?.match(/^REQ-([A-Z]+)-\d{3}$/u)?.[1] ?? 'OTHER'; }
function surfaceArea(kind) { return SURFACE_AREAS.find(([pattern]) => pattern.test(kind ?? ''))?.[1] ?? 'OTHER'; }
function repositoryPathInfo(repoPath) {
  if (typeof repoPath !== 'string' || repoPath === '' || posix.isAbsolute(repoPath) || repoPath === '..' || repoPath.startsWith('../')) return null;
  const root = resolve(process.cwd());
  let current = root;
  let kind = 'file';
  for (const part of repoPath.split('/')) {
    if (!part || part === '.') continue;
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return null;
      kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      if (kind === 'other') return null;
    } catch { return null; }
  }
  return { kind, absolute: current };
}
function lineFragment(reference) {
  if (Number.isInteger(reference?.line)) return `#L${reference.line}`;
  return '';
}
function projectSourceReference(reference) {
  if (!reference || typeof reference.path !== 'string' || reference.path === '') return null;
  return { path: reference.path, ...(Number.isInteger(reference.line) ? { line: reference.line } : {}) };
}
function repositoryHref(repoPath, sourceSha, reference = {}) {
  const info = repositoryPathInfo(repoPath);
  if (!info) return null;
  const mode = info.kind === 'directory' ? 'tree' : 'blob';
  const encodedPath = repoPath.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${TRACE_REPOSITORY}/${mode}/${sourceSha}/${encodedPath}${lineFragment(reference)}`;
}
function addBrokenReference(audit, { kind, path, from }) {
  const key = `${kind}\0${path}\0${from}`;
  if (!audit._seen.has(key)) {
    audit._seen.add(key);
    audit.broken.push({ kind, path, from, reason: 'Repository source path is missing, outside the checkout, or not a regular file/directory.' });
  }
}
function linkRepositoryPath(pathValue, sourceSha, audit, { kind, from, base = '', reference = {} }) {
  if (typeof pathValue !== 'string' || pathValue === '') return null;
  const repoPath = posix.normalize(posix.join(base, pathValue.replaceAll('\\', '/')));
  const href = repositoryHref(repoPath, sourceSha, reference);
  if (!href) { addBrokenReference(audit, { kind, path: repoPath, from }); return null; }
  return { path: repoPath, ...(Number.isInteger(reference.line) ? { line: reference.line } : {}), url: href };
}
function designLinksFor(references, sourceSha, audit, obligationId) {
  const links = [];
  for (const reference of references ?? []) {
    const text = String(reference);
    const markdownLinks = [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)];
    for (const match of markdownLinks) {
      const target = match[2].split('#')[0];
      if (!target || /^https?:/iu.test(target)) continue;
      const link = linkRepositoryPath(target, sourceSha, audit, { kind: 'design', from: obligationId, base: 'docs/requirements' });
      if (link) links.push({ label: match[1], ...link });
    }
  }
  return [...new Map(links.map(link => [`${link.path}\0${link.label}`, link])).values()];
}
function implementationLinksFor(identifiers, sourceSha, audit, obligationId) {
  const links = [];
  let lastDirectory = '';
  for (const raw of identifiers ?? []) {
    const identifier = String(raw).trim();
    if (!identifier || /^UNMAPPED\b/iu.test(identifier)) continue;
    // A colon followed by whitespace introduces a symbol annotation.
    const leadingToken = identifier.match(/^([^\s;、，]+?)(?=:\s|[\s;、，]|$)/u)?.[1] ?? identifier;
    const candidates = [leadingToken];
    if (lastDirectory && !leadingToken.includes('/')) candidates.push(posix.join(lastDirectory, leadingToken));
    const candidate = candidates.find(pathValue => repositoryPathInfo(posix.normalize(pathValue)));
    if (candidate) {
      const repoPath = posix.normalize(candidate);
      const href = repositoryHref(repoPath, sourceSha);
      links.push({ identifier, path: repoPath, url: href });
      lastDirectory = posix.dirname(repoPath);
      continue;
    }
    if (/^(?:packages|modules|app|ios|deploy|scripts|docs|tests|\.github)\//u.test(leadingToken) || (!/^[A-Z]{2,}-\d+\.[A-Z]$/u.test(leadingToken) && /^[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|sql|ya?ml|tf|sh)$/iu.test(leadingToken))) {
      addBrokenReference(audit, { kind: 'implementation', path: leadingToken, from: obligationId });
    }
    links.push({ identifier, path: null, url: null });
  }
  return links;
}
function publicTraceability(report, sourceSha, receipt = { status: 'NOT_AVAILABLE', sourceSha }) {
  const rows = report.obligationTrace?.rows;
  const sourceObligationGaps = report.obligationTrace?.gaps;
  const reverseRows = report.reverseTrace?.rows;
  const reverseGaps = report.reverseTrace?.gaps;
  const caseExecutions = report.caseExecutions;
  const pagesQualification = report.traceability?.TRC07;
  const sourceGates = report.traceability?.gates;
  assert.ok(pagesQualification && typeof pagesQualification === 'object', 'TRC-07 Pages qualification is missing');
  assert.equal(pagesQualification.status, 'PENDING_PAGES_PUBLISH', 'TRC-07 must remain pending until the exact source is confirmed at the public Pages URL');
  assert.equal(pagesQualification.staticStaging, 'PASSED', 'TRC-07 static staging qualification is missing');
  assert.equal(pagesQualification.browserAcceptance, 'PASSED', 'TRC-07 browser acceptance qualification is missing');
  assert.ok(report.publication?.status === 'NOT_PUBLISHED' && report.publication.publisher === '.github/workflows/repository-audit.yml', 'StrictDoc report has a foreign or invalid Pages publication claim');
  assert.ok(sourceGates && typeof sourceGates === 'object', 'Specification qualification gates are missing');
  const gateStatuses = new Set(['LOCAL_PASS', 'NOT_RUN', 'BLOCKED', 'PARTIAL', 'PASS', 'FAIL', 'IN_PROGRESS']);
  const gates = Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
    const id = `G${index}`;
    const gate = sourceGates[id];
    assert.ok(gate && gateStatuses.has(gate.status) && typeof gate.evidence === 'string' && gate.evidence.length > 0, `Invalid ${id} qualification evidence`);
    return [id, { status: gate.status, evidence: gate.evidence }];
  }));
  assert.deepEqual(Object.keys(sourceGates).sort(), Object.keys(gates), 'Unexpected specification qualification gate IDs');
  assert.ok(receipt && ['CERTIFIED', 'NOT_AVAILABLE'].includes(receipt.status), 'Invalid Verify artifact receipt status');
  assert.equal(receipt.sourceSha, sourceSha, 'Verify artifact receipt source SHA mismatch');
  let publicReceipt = { status: 'NOT_AVAILABLE', sourceSha };
  if (receipt.status === 'CERTIFIED') {
    assert.equal(receipt.repository, TRACE_REPOSITORY, 'Verify artifact receipt repository mismatch');
    assert.match(String(receipt.runId ?? ''), /^\d+$/u, 'Invalid Verify run ID');
    assert.ok(Number.isInteger(receipt.attempt) && receipt.attempt > 0, 'Invalid Verify run attempt');
    assert.equal(receipt.job, 'types', 'Unexpected Verify job identity');
    assert.equal(receipt.task, 'requirements-trace', 'Unexpected Verify task identity');
    assert.equal(receipt.runUrl, `https://github.com/${TRACE_REPOSITORY}/actions/runs/${receipt.runId}`, 'Verify URL does not match run identity');
    assert.ok(Number.isSafeInteger(receipt.artifactId) && receipt.artifactId > 0, 'Invalid Verify artifact ID');
    assert.match(receipt.artifactDigest ?? '', /^sha256:[a-f0-9]{64}$/u, 'Invalid Verify artifact digest');
    assert.ok(Array.isArray(receipt.passedCaseIds) && new Set(receipt.passedCaseIds).size === receipt.passedCaseIds.length, 'Invalid or duplicate Verify case IDs');
    const caseResults = new Map(caseExecutions.map(item => [item.testId, item.result]));
    for (const testId of receipt.passedCaseIds) assert.equal(caseResults.get(testId), 'PASSED', `Verify receipt claims an unobserved passing case ${testId}`);
    publicReceipt = {
      status: 'CERTIFIED', sourceSha, repository: receipt.repository, runId: String(receipt.runId), attempt: receipt.attempt,
      job: receipt.job, task: receipt.task, runUrl: receipt.runUrl, artifactId: receipt.artifactId,
      artifactDigest: receipt.artifactDigest, artifactUrl: `${receipt.runUrl}/artifacts/${receipt.artifactId}`,
      passedCaseIds: [...receipt.passedCaseIds].sort(),
    };
  } else assert.deepEqual(Object.keys(receipt).sort(), ['sourceSha', 'status'], 'NOT_AVAILABLE receipt must not carry unverified evidence fields');
  assert.ok(Array.isArray(rows) && Array.isArray(sourceObligationGaps), 'StrictDoc obligation trace is missing');
  assert.ok(Array.isArray(reverseRows) && Array.isArray(reverseGaps), 'StrictDoc reverse trace is missing');
  assert.ok(Array.isArray(caseExecutions), 'StrictDoc case execution inventory is missing');
  const execution = exactExecution(report.execution, sourceSha);
  const referenceAudit = { broken: [], _seen: new Set() };
  const caseById = new Map(caseExecutions.map(item => {
    assert.ok(item && /^TEST-(?:[A-Z0-9]+-)+\d{3}$/u.test(item.testId ?? ''), 'Invalid observed TEST-ID');
    assert.ok(['PASSED', 'FAILED', 'BLOCKED', 'NOT_RUN', 'SKIPPED', 'TODO', 'AMBIGUOUS'].includes(item.result), `Invalid observed test result for ${item.testId}`);
    return [item.testId, item];
  }));
  const browserRunsByTest = new Map();
  const browserReceipts = receipt.productBrowser ?? [];
  assert.ok(Array.isArray(browserReceipts), 'Invalid certified browser observations');
  const browserTasks = new Set();
  for (const browser of browserReceipts) {
    assert.ok(/^browser-(core|full)-/u.test(browser.job) && VERIFICATION_GROUPS[browser.job]?.includes(browser.task),
      'Unexpected Verify browser job or task');
    const shard = BROWSER_SHARDS.find(item => browser.task === `browser-${browser.profile}-${item.id}`);
    assert.ok(shard && ['core', 'full'].includes(browser.profile) && shard.project === browser.project, 'Invalid Verify browser profile or project');
    assert.ok(!browserTasks.has(browser.task), 'Duplicate Verify browser task evidence');
    browserTasks.add(browser.task);
    assert.ok(Number.isSafeInteger(browser.artifactId) && browser.artifactId > 0, 'Invalid Verify browser artifact ID');
    assert.match(browser.artifactDigest ?? '', /^sha256:[a-f0-9]{64}$/u, 'Invalid Verify browser artifact digest');
    assert.ok(Number.isInteger(browser.attempt) && browser.attempt > 0, 'Invalid Verify browser producer attempt');
    assert.ok(Array.isArray(browser.passedCaseIds) && new Set(browser.passedCaseIds).size === browser.passedCaseIds.length,
      'Invalid or duplicate Verify browser case IDs');
    for (const testId of browser.passedCaseIds) {
      const observation = caseById.get(testId);
      assert.ok(observation?.result === 'NOT_RUN' && observation.sourceRefs?.[0]?.path === `tests/e2e/${shard.file}`,
        `Verify browser evidence refers to a foreign case ${testId}`);
      const exactRun = {
        testId, sourceSha, repository: publicReceipt.repository, runId: publicReceipt.runId, attempt: browser.attempt,
        job: browser.job, task: browser.task, profile: browser.profile, project: browser.project, result: 'PASS', url: publicReceipt.runUrl,
        artifactId: browser.artifactId, artifactDigest: browser.artifactDigest,
        artifactUrl: `${publicReceipt.runUrl}/artifacts/${browser.artifactId}`,
      };
      const runs = browserRunsByTest.get(testId) ?? [];
      runs.push(exactRun);
      browserRunsByTest.set(testId, runs);
    }
  }
  if (browserRunsByTest.size > 0 && gates.G4.status === 'NOT_RUN') {
    gates.G4 = {
      status: 'PARTIAL',
      evidence: `Verify certified ${browserRunsByTest.size} mapped Chromium cases. Remaining G4 obligations require independent evidence.`,
    };
  }
  const resolvedGaps = new Set();
  const publicRows = rows.map(row => {
    assert.ok(row && /^REQ-[A-Z]+-\d{3}$/u.test(row.requirementId ?? '') && /^OBL-REQ-[A-Z]+-\d{3}-O\d{2}$/u.test(row.obligationId ?? ''), 'Invalid obligation trace identity');
    const testIds = row.testIds ?? [];
    const observedRuns = publicExactRuns(row.exactRuns ?? [], testIds, execution, caseById);
    const browserRuns = testIds.flatMap(testId => browserRunsByTest.get(testId) ?? []);
    for (const browser of browserRuns) resolvedGaps.add(`${row.obligationId}: no exact-source run evidence for ${browser.testId}`);
    const exactRuns = [...observedRuns, ...browserRuns];
    return {
      requirementId: row.requirementId, obligationId: row.obligationId,
      statement: row.obligationText ?? '', decisionStatus: row.decisionStatus ?? 'UNKNOWN',
      conformanceStatus: row.conformanceStatus ?? 'UNMAPPED', applicability: row.applicability ?? 'UNKNOWN',
      requirementImplementationIdentifiers: row.requirementImplementationIdentifiers ?? [],
      requirementComment: row.requirementComment ?? '',
      status: row.status, designRefs: row.designRefs ?? [], sourceRefs: (row.sourceRefs ?? []).map(projectSourceReference).filter(Boolean),
      implementationIdentifiers: row.implementationIdentifiers ?? [], surfaceIdentifiers: row.surfaceIdentifiers ?? [],
      testIds: row.testIds ?? [], exactRuns,
      area: requirementArea(row.requirementId),
      designLinks: designLinksFor(row.designRefs ?? [], sourceSha, referenceAudit, row.obligationId),
      sourceLinks: (row.sourceRefs ?? []).map(projectSourceReference).filter(Boolean).map(reference => linkRepositoryPath(reference.path, sourceSha, referenceAudit, { kind: 'implementation', from: row.obligationId, reference })).filter(Boolean),
      implementationLinks: implementationLinksFor(row.implementationIdentifiers ?? [], sourceSha, referenceAudit, row.obligationId),
    };
  });
  const obligationGaps = sourceObligationGaps.filter(gap => !resolvedGaps.has(gap));
  const requirements = [...new Set(report.source.requirementIds ?? publicRows.map(row => row.requirementId))].sort().map(requirementId => {
    const matching = publicRows.filter(row => row.requirementId === requirementId);
    const partialDeclaration = /部分導入済み|partially implemented/iu;
    const implementationDeclarations = [...new Map(matching.flatMap(row => [
      ...row.requirementImplementationIdentifiers.filter(text => /未実装|未導入|not implemented|unimplemented/iu.test(text) || partialDeclaration.test(text)).map(text => ({ sourceField: 'Implementation identifiers', text })),
      ...(row.requirementComment && (/未実装|未導入|not implemented|unimplemented/iu.test(row.requirementComment) || partialDeclaration.test(row.requirementComment)) ? [{ sourceField: 'Comment', text: row.requirementComment }] : []),
      ...(row.statement && /未実装|not implemented|unimplemented/iu.test(row.statement) ? [{ sourceField: 'Obligation statement', text: row.statement }] : []),
    ]).map(item => [`${item.sourceField}\0${item.text}`, item])).values()];
    return {
      requirementId,
      area: requirementArea(requirementId),
      decisionStatus: matching[0]?.decisionStatus ?? 'UNKNOWN',
      conformanceStatus: matching[0]?.conformanceStatus ?? 'UNMAPPED',
      applicability: matching[0]?.applicability ?? 'UNKNOWN',
      implementationDeclarations,
      implementationDeclarationStatus: implementationDeclarations.some(note => partialDeclaration.test(note.text))
        ? 'EXPLICIT_PARTIALLY_IMPLEMENTED'
        : implementationDeclarations.length ? 'EXPLICIT_NOT_IMPLEMENTED' : 'NO_EXPLICIT_DECLARATION',
      obligationIds: matching.map(row => row.obligationId),
      obligationStatusCounts: Object.fromEntries([...new Set(matching.map(row => row.status))].sort().map(status => [status, matching.filter(row => row.status === status).length])),
    };
  });
  const obligationById = new Map(publicRows.map(row => [row.obligationId, row]));
  const reverse = reverseRows.map((row, index) => {
    assert.ok(row?.surface && typeof row.surface.kind === 'string' && typeof row.surface.id === 'string', 'Invalid reverse trace surface identity');
    assert.notEqual(row.status, 'VERIFIED', 'Reverse trace cannot certify VERIFIED');
    const obligation = row.obligationId ? obligationById.get(row.obligationId) : undefined;
    assert.ok(!row.obligationId || obligation, `Reverse trace references unknown obligation ${row.obligationId}`);
    if (obligation) assert.equal(row.requirementId, obligation.requirementId, 'Reverse trace requirement relation mismatch');
    else assert.ok(!row.requirementId, 'Reverse trace requirement requires an obligation relation');
    const exactRuns = obligation?.exactRuns ?? [];
    assert.deepEqual(row.exactRuns ?? [], exactRuns.filter(run => !run.artifactId), `Reverse trace exact-run evidence mismatch for ${row.surface.kind} ${row.surface.id}`);
    const inventoryClassification = row.inventoryClassification ?? null;
    const candidateRequirementIds = [...new Set(row.candidateRequirementIds ?? (inventoryClassification?.match(/REQ-[A-Z]+-\d{3}/gu) ?? []))];
    const explicitNotApplicable = /\bNOT_APPLICABLE\b|no requirement applies|outside the requirements/iu.test(inventoryClassification ?? '');
    const disposition = obligation ? 'LINKED' : explicitNotApplicable ? 'NOT_APPLICABLE' : candidateRequirementIds.length ? 'CANDIDATE_ONLY' : inventoryClassification ? 'NO_OBLIGATION_LINK' : 'UNCLASSIFIED';
    const source = projectSourceReference(row.source);
    const sourceLink = source?.path ? linkRepositoryPath(source.path, sourceSha, referenceAudit, { kind: 'surface', from: `${row.surface.kind} ${row.surface.id}`, reference: source }) : null;
    return {
      surface: row.surface, requirementId: row.requirementId ?? null, obligationId: row.obligationId ?? null,
      area: surfaceArea(row.surface.kind), status: row.status, disposition,
      provenance: row.provenance ?? '', source, sourceLink,
      classification: row.classification ?? null, inventoryClassification, candidateRequirementIds,
      operationId: row.operationId ?? null, contractStatus: row.contractStatus ?? null,
      testIds: row.testIds ?? [], exactRuns, surfaceKey: `surface-${index + 1}`,
    };
  });
  const obligationIdsByTest = new Map();
  for (const row of publicRows) for (const testId of row.testIds) obligationIdsByTest.set(testId, [...(obligationIdsByTest.get(testId) ?? []), row.obligationId]);
  const publicCases = caseExecutions.map(item => {
    const sourceRefs = (item.sourceRefs ?? (item.file ? [{ path: item.file, ...(Number.isInteger(item.line) ? { line: item.line } : {}) }] : [])).map(projectSourceReference).filter(Boolean);
    const sourceLinks = sourceRefs.map(reference => linkRepositoryPath(reference.path, sourceSha, referenceAudit, { kind: 'test', from: item.testId, reference })).filter(Boolean);
    const obligationIds = [...new Set(obligationIdsByTest.get(item.testId) ?? [])];
    const projectedRuns = [...new Map(obligationIds.flatMap(id => obligationById.get(id)?.exactRuns ?? []).filter(run => run.testId === item.testId).map(run => [`${run.runId}\0${run.task}\0${run.testId}`, run])).values()];
    const browserRuns = browserRunsByTest.get(item.testId) ?? [];
    const exactRuns = [...projectedRuns.filter(run => !run.artifactId), ...browserRuns];
    return {
      testId: item.testId, name: item.name ?? '', result: browserRuns.length ? 'PASSED' : item.result, sourceRefs, sourceLinks,
      requirementIds: [...new Set(obligationIds.map(id => obligationById.get(id)?.requirementId).filter(Boolean))],
      obligationIds, exactRuns,
      ...(publicReceipt.status === 'CERTIFIED' && publicReceipt.passedCaseIds.includes(item.testId) ? { verificationArtifact: { runId: publicReceipt.runId, attempt: publicReceipt.attempt, artifactId: publicReceipt.artifactId, artifactDigest: publicReceipt.artifactDigest, url: publicReceipt.artifactUrl } } : {}),
      ...(item.file ? { file: item.file } : {}), ...(Number.isInteger(item.line) ? { line: item.line } : {}),
    };
  });
  const countsBy = (items, field) => Object.fromEntries([...new Set(items.map(item => item[field] ?? 'UNKNOWN'))].sort().map(status => [status, items.filter(item => (item[field] ?? 'UNKNOWN') === status).length]));
  const conformanceCounts = countsBy(publicRows, 'conformanceStatus');
  const requirementConformanceCounts = countsBy(requirements, 'conformanceStatus');
  const implementationDeclarationCounts = countsBy(requirements, 'implementationDeclarationStatus');
  const statusCounts = Object.fromEntries([...new Set(publicRows.map(item => item.status))].sort().map(status => [status, publicRows.filter(item => item.status === status).length]));
  const reverseDispositionCounts = countsBy(reverse, 'disposition');
  const areaCounts = {};
  for (const area of [...new Set(publicRows.map(row => row.area))].sort()) {
    const areaRows = publicRows.filter(row => row.area === area);
    const areaRequirements = requirements.filter(row => row.area === area);
    areaCounts[area] = {
      label: AREA_LABELS[area] ?? area, requirementCount: areaRequirements.length, obligationCount: areaRows.length,
      conformanceCounts: countsBy(areaRows, 'conformanceStatus'), statusCounts: countsBy(areaRows, 'status'),
      testLinkedObligationCount: areaRows.filter(row => row.testIds.length > 0).length,
      exactRunCount: areaRows.reduce((sum, row) => sum + row.exactRuns.length, 0),
    };
  }
  const surfaceAreaCounts = {};
  for (const area of [...new Set(reverse.map(row => row.area))].sort()) {
    const areaRows = reverse.filter(row => row.area === area);
    surfaceAreaCounts[area] = {
      label: SURFACE_AREA_LABELS[area] ?? area, surfaceCount: areaRows.length,
      linkedCount: areaRows.filter(row => row.disposition === 'LINKED').length,
      noObligationLinkCount: areaRows.filter(row => row.disposition === 'NO_OBLIGATION_LINK').length,
      candidateOnlyCount: areaRows.filter(row => row.disposition === 'CANDIDATE_ONLY').length,
      notApplicableCount: areaRows.filter(row => row.disposition === 'NOT_APPLICABLE').length,
      unclassifiedCount: areaRows.filter(row => row.disposition === 'UNCLASSIFIED').length,
    };
  }
  const caseResultCounts = countsBy(publicCases, 'result');
  const reverseLinkCount = reverse.filter(row => row.disposition === 'LINKED').length;
  const notApplicableSurfaceCount = reverse.filter(row => row.disposition === 'NOT_APPLICABLE').length;
  const trace = {
    schemaVersion: 1, sourceSha, generatedAt: report.generatedAt,
    verificationReceipt: publicReceipt,
    pagesQualification: {
      status: 'PENDING_PAGES_PUBLISH', sourceSha,
      publisher: '.github/workflows/repository-audit.yml',
      strictDocStaticStaging: 'PASSED', strictDocBrowserAcceptance: 'PASSED', publicUrlConfirmation: 'PENDING',
      publisherExecution: execution.status === 'IN_PROGRESS' ? {
        status: 'IN_PROGRESS', repository: execution.repository, sourceSha, runId: execution.runId,
        attempt: execution.attempt, job: execution.job, task: execution.task, runUrl: execution.runUrl,
      } : { status: 'NOT_RUN', sourceSha },
      detail: 'Staging checks passed; this exact source SHA still requires public Pages URL confirmation.',
    },
    qualificationGates: gates,
    summary: {
      requirementCount: requirements.length, obligationCount: publicRows.length,
      reverseSurfaceCount: reverse.length, linkedSurfaceCount: reverseLinkCount,
      surfaceWithoutObligationCount: reverse.length - reverseLinkCount,
      explicitNotApplicableSurfaceCount: notApplicableSurfaceCount,
      obligationGapCount: obligationGaps.length, reverseGapCount: reverseGaps.length,
      conformanceCounts, requirementConformanceCounts, statusCounts, areaCounts, surfaceAreaCounts,
      implementationDeclarationCounts,
      reverseDispositionCounts, caseResultCounts,
      observedCaseCount: publicCases.length, passedCaseCount: publicCases.filter(item => item.result === 'PASSED').length,
      evidenceFreshness: {
        status: execution.status, sourceSha, generatedAt: report.generatedAt,
        exactSourceRunCount: publicRows.reduce((sum, row) => sum + row.exactRuns.length, 0),
      },
      brokenReferenceCount: referenceAudit.broken.length,
    },
    requirements, obligations: publicRows, reverseTrace: reverse,
    gaps: { obligations: obligationGaps, reverse: reverseGaps, referenceAudit },
    caseExecutions: publicCases, execution, referenceAudit,
  };
  const areaOptions = [...new Set([...Object.keys(areaCounts), ...Object.keys(surfaceAreaCounts)])].sort().map(area => `<option value="${esc(area)}">${esc(SURFACE_AREA_LABELS[area] ?? AREA_LABELS[area] ?? area)}</option>`).join('');
  const statusOptions = [...new Set([...Object.keys(statusCounts), ...Object.keys(conformanceCounts), ...Object.keys(caseResultCounts), ...Object.keys(implementationDeclarationCounts), ...reverse.map(row => row.status), ...Object.keys(reverseDispositionCounts), 'DEVIATION', 'BLOCKED', 'NOT_APPLICABLE', 'UNCLASSIFIED'])].sort().map(status => `<option value="${esc(status)}">${esc(status)}</option>`).join('');
  const kindOptions = [...new Set(reverse.map(row => row.surface.kind))].sort().map(kind => `<option value="${esc(kind)}">${esc(kind)}</option>`).join('');
  const attr = (row, searchText, kind = '') => `data-trace-row data-area="${esc(row.area ?? 'OTHER')}" data-status="${esc(Array.isArray(row.status) ? row.status.join(' ') : row.status ?? '')}" data-kind="${esc(kind)}" data-search="${esc(searchText.toLowerCase())}"`;
  const obligationHtml = publicRows.map((row, index) => {
    const relatedSurfaces = reverse.filter(surface => surface.obligationId === row.obligationId);
    const designHtml = row.designLinks.map(link => `<li><a href="${esc(link.url)}">${esc(link.label)}</a></li>`).join('') || '<li>設計参照のリンクがありません</li>';
    const sourceHtml = [...row.sourceLinks, ...row.implementationLinks.filter(link => link.url)].map(link => `<li><a href="${esc(link.url)}">${esc(link.path)}${link.line ? `:L${esc(link.line)}` : ''}</a></li>`).join('') || '<li>識別済みsourceリンクなし</li>';
    const symbolsHtml = row.implementationLinks.filter(link => !link.url).map(link => `<li><code>${esc(link.identifier)}</code></li>`).join('');
    const testHtml = row.testIds.map(testId => {
      const item = publicCases.find(candidate => candidate.testId === testId);
      const result = item?.result ?? 'NOT_RUN';
      return `<li><a href="#test-${esc(testId)}">${esc(testId)}</a> · <span class="state" data-state="${esc(result)}">${esc(result)}</span>${item?.sourceLinks[0] ? ` · <a href="${esc(item.sourceLinks[0].url)}">source</a>` : ''}</li>`;
    }).join('') || '<li>TEST-ID未登録</li>';
    const surfaceHtml = relatedSurfaces.map(surface => `<li><a href="#${esc(surface.surfaceKey)}">${esc(surface.surface.kind)} · ${esc(surface.surface.id)}</a> · ${esc(surface.status)}</li>`).join('') || '<li>実装面との明示リンクなし</li>';
    const runHtml = row.exactRuns.map(item => `<li><a href="${esc(item.url)}">${esc(item.result)} · run ${esc(item.runId)} / attempt ${esc(item.attempt)}</a> · source ${esc(item.sourceSha)}</li>`).join('') || '<li>exact-source run evidenceなし</li>';
    const requirementHref = `../html/docs/requirements/REQUIREMENT-REGISTER.sdoc-TRACE.html#${encodeURIComponent(row.requirementId)}`;
    const declarationText = [row.requirementComment, ...row.requirementImplementationIdentifiers].filter(Boolean).join(' ');
    const implementationStatus = requirements.find(item => item.requirementId === row.requirementId)?.implementationDeclarationStatus ?? 'NO_EXPLICIT_DECLARATION';
    return `<tr id="obligation-${esc(row.obligationId)}" ${attr({ area: row.area, status: [row.conformanceStatus, row.status, implementationStatus] }, `${row.requirementId} ${row.obligationId} ${row.statement} ${row.conformanceStatus} ${row.status} ${declarationText} ${row.designRefs.join(' ')} ${row.implementationIdentifiers.join(' ')} ${row.testIds.join(' ')} ${relatedSurfaces.map(item => item.surface.id).join(' ')}`)}><td>${index === publicRows.findIndex(item => item.requirementId === row.requirementId) ? `<a id="${esc(row.requirementId)}" href="${esc(requirementHref)}">${esc(row.requirementId)}</a>` : `<a href="#${esc(row.requirementId)}">${esc(row.requirementId)}</a>`}<br><small>${esc(AREA_LABELS[row.area] ?? row.area)}</small></td><td><strong>${esc(row.obligationId)}</strong><p>${esc(row.statement)}</p><details data-detail><summary>設計・実装・テスト・証拠を表示</summary><div class="detail-grid"><section><h4>設計正本</h4><ul>${designHtml}</ul></section><section><h4>実装参照</h4><ul>${sourceHtml}${symbolsHtml}</ul></section><section><h4>対応面</h4><ul>${surfaceHtml}</ul></section><section><h4>TEST-ID / 実行</h4><ul>${testHtml}${runHtml}</ul></section><section><h4>要求登録にある実装宣言</h4><p>${esc(declarationText || '明示的な未実装宣言なし。実装済みを意味しない。')}</p></section></div></details></td><td><span class="state" data-state="${esc(row.conformanceStatus)}">${esc(row.conformanceStatus)}</span><br><small>義務: ${esc(row.status)}</small></td><td>${esc(row.applicability)}<br>${esc(row.decisionStatus)}</td></tr>`;
  }).join('');
  const requirementHtml = requirements.map(item => {
    const related = publicRows.filter(row => row.requirementId === item.requirementId);
    const declarationHtml = item.implementationDeclarations.map(note => `<li><strong>${esc(note.sourceField)}</strong>: ${esc(note.text)}</li>`).join('');
    const declaration = item.implementationDeclarationStatus === 'NO_EXPLICIT_DECLARATION'
      ? '明示記述なし'
      : `<span class="state" data-state="${esc(item.implementationDeclarationStatus)}">明示: ${item.implementationDeclarationStatus === 'EXPLICIT_PARTIALLY_IMPLEMENTED' ? '部分導入済み' : '未実装'}</span><details><summary>登録記述を確認</summary><ul>${declarationHtml}</ul></details>`;
    return `<tr ${attr({ area: item.area, status: [item.conformanceStatus, item.implementationDeclarationStatus] }, `${item.requirementId} ${item.implementationDeclarationStatus} ${declarationHtml} ${related.map(row => `${row.obligationId} ${row.statement} ${row.conformanceStatus} ${row.status}`).join(' ')}`)}><td><a href="#${esc(related[0]?.obligationId ? `obligation-${related[0].obligationId}` : '')}">${esc(item.requirementId)}</a></td><td>${esc(AREA_LABELS[item.area] ?? item.area)}</td><td>${esc([...new Set(related.map(row => row.conformanceStatus))].join(' · '))}</td><td>${related.map(row => `<a href="#obligation-${esc(row.obligationId)}">${esc(row.obligationId)}</a>`).join('<br>')}</td><td>${declaration}</td></tr>`;
  }).join('');
  const reverseHtml = reverse.map(row => {
    const relationLink = row.obligationId ? `<a href="#obligation-${esc(row.obligationId)}">${esc(row.requirementId)} · ${esc(row.obligationId)}</a>` : '対応義務リンクなし';
    const candidates = row.candidateRequirementIds.map(id => requirements.some(item => item.requirementId === id) ? `<a class="candidate" href="#${esc(id)}">${esc(id)} candidate</a>` : `<span class="candidate">${esc(id)} candidate</span>`).join('<br>');
    return `<tr id="${esc(row.surfaceKey)}" ${attr({ area: row.area, status: [row.status, row.disposition] }, `${row.surface.kind} ${row.surface.id} ${row.operationId ?? ''} ${row.contractStatus ?? ''} ${row.requirementId ?? ''} ${row.obligationId ?? ''} ${row.inventoryClassification ?? ''} ${row.provenance}`, row.surface.kind)}><td><code>${esc(row.surface.kind)}</code><br><small>${esc(SURFACE_AREA_LABELS[row.area] ?? row.area)}</small></td><td><strong>${esc(row.surface.id)}</strong>${row.operationId ? `<p><code>Operation ID: ${esc(row.operationId)}</code> · ${esc(row.contractStatus ?? '')}</p>` : ''}<p>${esc(row.provenance)}</p></td><td>${relationLink}${candidates ? `<div>${candidates}</div>` : ''}</td><td><span class="state" data-state="${esc(row.status)}">${esc(row.disposition)}</span><br><small>${esc(row.status)}</small>${row.inventoryClassification ? `<p>${esc(row.inventoryClassification)}</p>` : '<p>分類なし</p>'}</td><td>${row.sourceLink ? `<a href="${esc(row.sourceLink.url)}">${esc(row.sourceLink.path)}${row.sourceLink.line ? `:L${row.sourceLink.line}` : ''}</a>` : '<span class="missing">source link unavailable</span>'}</td></tr>`;
  }).join('');
  const areaHtml = Object.entries(areaCounts).map(([area, count]) => `<tr ${attr({ area, status: '' }, `${area} ${count.label} ${JSON.stringify(count)}`)}><th scope="row">${esc(count.label)} <small>${esc(area)}</small></th><td>${count.requirementCount}</td><td>${count.obligationCount}</td><td>${count.conformanceCounts.UNMAPPED ?? 0}</td><td>${count.conformanceCounts.PARTIAL ?? 0}</td><td>${count.conformanceCounts.MAPPED_UNVERIFIED ?? 0}</td><td>${count.conformanceCounts.VERIFIED ?? 0}</td><td>${count.testLinkedObligationCount}</td><td>${count.exactRunCount}</td></tr>`).join('');
  const surfaceAreaHtml = Object.entries(surfaceAreaCounts).map(([area, count]) => `<tr ${attr({ area, status: '' }, `${area} ${count.label} ${JSON.stringify(count)}`)}><th scope="row">${esc(count.label)} <small>${esc(area)}</small></th><td>${count.surfaceCount}</td><td>${count.linkedCount}</td><td>${count.noObligationLinkCount}</td><td>${count.candidateOnlyCount}</td><td>${count.notApplicableCount}</td><td>${count.unclassifiedCount}</td></tr>`).join('');
  const gapRows = [
    ...obligationGaps.map((item, index) => ({ source: '義務', item, index })),
    ...reverseGaps.map((item, index) => ({ source: '実装面', item, index })),
  ].map(({ source, item, index }) => {
    const kind = typeof item === 'string' ? (item.includes(': no exact-source run evidence for ') ? 'UNVERIFIED' : 'UNMAPPED') : item.kind ?? 'UNKNOWN';
    const area = typeof item === 'string' ? requirementArea(item.match(/OBL-(REQ-[A-Z]+-\d{3})/u)?.[1]) : item.surface ? surfaceArea(item.surface.kind) : requirementArea(item.obligationId?.match(/OBL-(REQ-[A-Z]+-\d{3})/u)?.[1]);
    const text = typeof item === 'string' ? item : `${item.surface ? `${item.surface.kind} ${item.surface.id} · ` : ''}${item.reason ?? item.provenance ?? item.area ?? JSON.stringify(item)}`;
    const surface = typeof item === 'object' && item.surface ? reverse.find(row => row.surface.kind === item.surface.kind && row.surface.id === item.surface.id) : null;
    const obligation = typeof item === 'object' && item.obligationId ? obligationById.get(item.obligationId) : null;
    const sourceLink = typeof item === 'object' && item.source?.path ? linkRepositoryPath(item.source.path, sourceSha, referenceAudit, { kind: 'gap', from: `${kind}-${index}`, reference: item.source }) : null;
    const links = `${obligation ? `<a href="#obligation-${esc(obligation.obligationId)}">${esc(obligation.obligationId)}</a>` : ''}${surface ? ` <a href="#${esc(surface.surfaceKey)}">${esc(surface.surface.kind)} ${esc(surface.surface.id)}</a>` : ''}${sourceLink ? ` <a href="${esc(sourceLink.url)}">source</a>` : ''}`;
    return `<tr ${attr({ area, status: kind }, `${source} ${kind} ${text}`)}><td>${esc(source)}</td><td><span class="state" data-state="${esc(kind)}">${esc(kind)}</span></td><td>${esc(text)}${links ? `<p>${links}</p>` : ''}</td></tr>`;
  }).join('');
  const caseHtml = publicCases.map(item => {
    const area = requirementArea(item.requirementIds[0]);
    const sourceHtml = item.sourceLinks.map(link => `<a href="${esc(link.url)}">${esc(link.path)}${link.line ? `:L${esc(link.line)}` : ''}</a>`).join('<br>') || 'source refなし';
    const obligationHtml = item.obligationIds.map(id => `<a href="#obligation-${esc(id)}">${esc(id)}</a>`).join('<br>') || '個別義務へのリンクなし';
    const runHtml = [
      ...item.exactRuns.map(run => run.artifactUrl
        ? `<a href="${esc(run.artifactUrl)}">${esc(run.profile)}/${esc(run.project)} · run ${esc(run.runId)} / attempt ${esc(run.attempt)} · artifact ${esc(run.artifactId)} · ${esc(run.artifactDigest)}</a>`
        : `<a href="${esc(run.url)}">run ${esc(run.runId)} / ${esc(run.result)}</a>`),
      ...(item.verificationArtifact ? [`<a href="${esc(item.verificationArtifact.url)}">Verify artifact ${esc(item.verificationArtifact.artifactId)} · ${esc(item.verificationArtifact.artifactDigest)}</a>`] : []),
    ].join('<br>') || 'exact-source runなし';
    return `<tr id="test-${esc(item.testId)}" ${attr({ area, status: item.result }, `${item.testId} ${item.name} ${item.result} ${item.obligationIds.join(' ')}`)}><td><strong>${esc(item.testId)}</strong><p>${esc(item.name)}</p></td><td><span class="state" data-state="${esc(item.result)}">${esc(item.result)}</span></td><td>${sourceHtml}</td><td>${obligationHtml}</td><td>${runHtml}</td></tr>`;
  }).join('');
  referenceAudit.broken.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from));
  delete referenceAudit._seen;
  trace.summary.brokenReferenceCount = referenceAudit.broken.length;
  const brokenHtml = referenceAudit.broken.map(item => `<li><strong>${esc(item.kind)}</strong> · <code>${esc(item.path)}</code> · ${esc(item.from)} · ${esc(item.reason)}</li>`).join('') || '<li>検出したリンク切れはありません。</li>';
  const runNote = execution.status === 'IN_PROGRESS'
    ? `Actions run <a href="${esc(execution.runUrl)}">${esc(execution.runId)}</a> / attempt ${esc(execution.attempt)} / ${esc(execution.job)} / ${esc(execution.task)} をsource <code>${esc(sourceSha)}</code>で観測。既存のVerify certifierがartifactを別途照合する。`
    : `このsource SHAに対応するGitHub Actions runはレポートにありません。`;
  const gateHtml = Object.entries(gates).map(([id, gate]) => `<tr><th scope="row">${esc(id)}</th><td><span class="state" data-state="${esc(gate.status)}">${esc(gate.status)}</span></td><td>${esc(gate.evidence)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Codexiaの要求義務と実装面、テスト、実行証拠をsource SHAに結び付けて探索する静的ダッシュボード"><title>Implementation Traceability · Codexia</title><link rel="stylesheet" href="./traceability.css"></head><body><main id="main" class="traceability"><header class="page-heading"><p class="eyebrow">REQUIREMENTS / IMPLEMENTATION / EVIDENCE</p><h1>実装トレーサビリティ</h1><p>Requirement Registerの要求・個別義務と、最新sourceから抽出した実装面、テスト、実行記録を同じSHAで探索します。</p></header><section class="source-summary" aria-labelledby="source-heading"><h2 id="source-heading">対象sourceと証拠</h2><p>source SHA <code>${esc(sourceSha)}</code></p><p>生成時刻 <time datetime="${esc(report.generatedAt ?? '')}">${esc(report.generatedAt ?? '不明')}</time> · ${runNote}</p><p>TRC-07 生成時点: <strong>${esc(trace.pagesQualification.status)}</strong> · StrictDoc static staging ${esc(trace.pagesQualification.strictDocStaticStaging)} · StrictDoc browser acceptance ${esc(trace.pagesQualification.strictDocBrowserAcceptance)}. 公開URL確認はビルド後の別観測です。</p><div id="pages-live-confirmation" data-source-sha="${esc(sourceSha)}" aria-live="polite"><h3>TRC-07 公開確認 (live)</h3><p data-live-status>未確認。このPages公開観測はStrictDoc Verifyの認定とは別に表示します。</p></div><section aria-labelledby="qualification-gates"><h2 id="qualification-gates">Specification qualification gates</h2><div class="table-scroll"><table><thead><tr><th scope="col">Gate</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead><tbody>${gateHtml}</tbody></table></div><p>G7 outputs are linked in the StrictDoc navigation above. The separate Pages live observation and Verify certification have distinct evidence sources.</p></section><p>このページのsource参照とcase結果は追跡情報です。テスト成功やCI runの存在だけで製品適合を認定しません。UNMAPPEDは対応義務・実装参照が未接続である状態を示し、コード不存在の断定ではありません。候補REQは手掛かりであり、採用関係ではありません。</p><nav class="standard-links" aria-label="StrictDoc出力"><a href="../html/docs/requirements/REQUIREMENT-REGISTER.sdoc-TRACE.html">StrictDoc Traceability Matrix</a><a href="../html/docs/requirements/REQUIREMENT-REGISTER.sdoc-DEEP-TRACE.html">StrictDoc Deep Trace</a><a href="../html/docs/requirements/REQUIREMENT-REGISTER.sdoc-TABLE.html">StrictDoc Coverage Table</a><a href="../html/">StrictDoc HTML</a><a href="../json/index.json">StrictDoc JSON</a><a href="./traceability.json">このページのJSON</a></nav></section><section aria-labelledby="summary-heading"><h2 id="summary-heading">領域別の適合・検証状況</h2><div class="table-scroll" tabindex="0" aria-label="領域別状況テーブル"><table><caption>要求・個別義務の既存状態。実行数は紐付け済みexact-source runの数。</caption><thead><tr><th scope="col">領域</th><th scope="col">要求</th><th scope="col">義務</th><th scope="col">UNMAPPED</th><th scope="col">PARTIAL</th><th scope="col">MAPPED_UNVERIFIED</th><th scope="col">VERIFIED</th><th scope="col">TEST-IDあり</th><th scope="col">exact run</th></tr></thead><tbody>${areaHtml}</tbody></table></div><p class="summary-line">${trace.summary.requirementCount} requirements · ${trace.summary.obligationCount} obligations · ${trace.summary.reverseSurfaceCount} source surfaces · ${trace.summary.linkedSurfaceCount} linked surfaces · ${trace.summary.obligationGapCount + trace.summary.reverseGapCount} trace gaps · ${trace.summary.explicitNotApplicableSurfaceCount} explicit NOT_APPLICABLE</p><p class="status-key">適合状態: ${Object.entries(conformanceCounts).map(([status, count]) => `<span class="state" data-state="${esc(status)}">${esc(status)} · ${count}</span>`).join(' ')}。VERIFIEDは既存certifierが記録した値のみ表示します。</p></section><section aria-labelledby="surface-area-heading"><h2 id="surface-area-heading">実装面の領域別接続状況</h2><div class="table-scroll" tabindex="0" aria-label="実装面の領域別接続テーブル"><table><caption>sourceで検出した面と個別義務リンク。candidateだけではlinkedに数えません。</caption><thead><tr><th scope="col">領域</th><th scope="col">検出面</th><th scope="col">義務リンク</th><th scope="col">リンクなし・分類あり</th><th scope="col">候補のみ</th><th scope="col">NOT_APPLICABLE</th><th scope="col">未分類</th></tr></thead><tbody>${surfaceAreaHtml}</tbody></table></div></section><search class="trace-search"><form id="trace-filter"><div class="filter-grid"><label>追跡データを検索<input type="search" name="q" aria-label="追跡データを検索" autocomplete="off" placeholder="REQ、義務、surface、source、test"></label><label>領域<select name="area" aria-label="領域"><option value="">全領域</option>${areaOptions}</select></label><label>状態<select name="status" aria-label="状態"><option value="">全状態</option>${statusOptions}</select></label><label>surface種別<select name="kind" aria-label="surface種別"><option value="">全surface種別</option>${kindOptions}</select></label><button type="button" id="clear-filters">条件を解除</button></div></form><p id="filter-count" aria-live="polite"></p></search><section aria-labelledby="requirements-heading"><h2 id="requirements-heading">要求から義務へ</h2><p>適合状態はRequirement Registerの値です。明示的な未実装宣言だけを別表示し、宣言なしを実装済みとは扱いません。</p><div class="table-scroll" tabindex="0" aria-label="要求一覧テーブル"><table id="requirement-table"><thead><tr><th scope="col">Requirement</th><th scope="col">領域</th><th scope="col">適合状態</th><th scope="col">個別義務</th><th scope="col">実装宣言</th></tr></thead><tbody>${requirementHtml}</tbody></table></div></section><section aria-labelledby="obligations-heading"><h2 id="obligations-heading">要求・個別義務の実装と検証</h2><div class="table-scroll" id="obligation-table-scroll" tabindex="0" aria-label="個別義務の横スクロールテーブル"><table id="obligation-table"><thead><tr><th scope="col">Requirement</th><th scope="col">個別義務・根拠リンク</th><th scope="col">適合 / 追跡状態</th><th scope="col">適用・決定</th></tr></thead><tbody>${obligationHtml}</tbody></table></div></section><section aria-labelledby="surfaces-heading"><h2 id="surfaces-heading">実装面の逆引き</h2><p>source上のAPI operation、MCP tool、DB object、UI control、Native iOS view、IaC resource、Ansible/運用面を個別義務へ逆引きします。候補REQ・未分類・要求リンクなしは別状態です。</p><div class="table-scroll" tabindex="0" aria-label="実装面の逆引きテーブル"><table id="surface-table"><thead><tr><th scope="col">領域・種別</th><th scope="col">識別子・抽出根拠</th><th scope="col">要求 / 義務</th><th scope="col">分類・状態</th><th scope="col">source SHA link</th></tr></thead><tbody>${reverseHtml}</tbody></table></div></section><section aria-labelledby="gaps-heading"><h2 id="gaps-heading">未達・逸脱・観測制約・参照欠落</h2><div class="table-scroll" tabindex="0" aria-label="未解決trace gapテーブル"><table id="gap-table"><thead><tr><th scope="col">一覧</th><th scope="col">状態</th><th scope="col">詳細 / 対象</th></tr></thead><tbody>${gapRows}</tbody></table></div></section><section aria-labelledby="tests-heading"><h2 id="tests-heading">テストから個別義務・実行証拠へ</h2><p>${trace.summary.passedCaseCount} / ${trace.summary.observedCaseCount} observed cases reported PASSED. NOT_RUN、SKIPPED、TODO、AMBIGUOUS、FAILEDは個別の結果として残し、PASSに合算しません。</p><div class="table-scroll" tabindex="0" aria-label="テスト実行一覧テーブル"><table id="test-table"><thead><tr><th scope="col">TEST-ID / case</th><th scope="col">観測結果</th><th scope="col">宣言source</th><th scope="col">個別義務</th><th scope="col">exact-source run</th></tr></thead><tbody>${caseHtml}</tbody></table></div></section><section aria-labelledby="references-heading"><h2 id="references-heading">参照欠落</h2><p>設計正本・宣言済み実装・source・test参照のうち、checkout内の正規ファイルへ解決できないものを表示します。</p><ul class="reference-gaps">${brokenHtml}</ul></section><footer class="page-footer">Same-source projection · ${esc(sourceSha)} · generated ${esc(report.generatedAt ?? '不明')}</footer></main><script src="./traceability-ui.js" defer></script></body></html>\n`;
  const decorated = decoratePage(html, { pagePath: 'requirements/traceability/index.html', page: { id: 'requirements', title: 'Implementation Traceability', section: 'Requirements', mode: 'source-bound status', source: 'StrictDoc and source inventory', sha: sourceSha } });
  return { trace, html: decorated };
}

function files(root) {
  const result = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), 'Symlink in StrictDoc output');
      if (stat.isDirectory()) walk(path);
      else { assert.ok(stat.isFile(), 'Non-regular StrictDoc output'); result.push(relative(root, path).split(sep).join('/')); }
    }
  }
  walk(root); return result;
}
function publishStrictDocLinks(htmlRoot, sourceSha) {
  const paths = files(htmlRoot).filter(name => /\.sdoc(?:-DEEP-TRACE|-TRACE|-TABLE)?\.html$/u.test(name));
  const anchors = new Map(paths.map(name => {
    const source = readFileSync(join(htmlRoot, name), 'utf8');
    return [resolve(htmlRoot, name), new Set([...source.matchAll(/\s+id="([^"]+)"/gu)].map(match => match[1]))];
  }));
  for (const name of paths) {
    const file = join(htmlRoot, name);
    const source = readFileSync(file, 'utf8');
    // Published design references resolve against the same source as the export.
    const sourceLinks = source.replace(/(href="https:\/\/github\.com\/yohn-jp\/codexia\/(?:blob|tree)\/)main(?=\/)/gu, `$1${sourceSha}`);
    const updated = sourceLinks.replace(/\bhref="((?:\.\.?\/)*[^"#?:]*?\.sdoc)-(?:DEEP-TRACE|TRACE|TABLE)\.html#([^"]+)"/gu, (link, document, fragment) => {
      const documentPath = resolve(dirname(file), `${document}.html`);
      const viewPath = resolve(dirname(file), link.slice(6, link.indexOf('#')));
      const decoded = decodeURIComponent(fragment);
      if (anchors.get(viewPath)?.has(decoded) || !anchors.get(documentPath)?.has(decoded)) return link;
      return `href="${document}.html#${fragment}"`;
    });
    if (updated !== source) writeFileSync(file, updated);
  }
}

export function packSpecifications(site, output, sourceSha, receipt = { status: 'NOT_AVAILABLE', sourceSha }) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/u, 'Invalid source SHA');
  const report = JSON.parse(readFileSync(join(output, 'trace-report.json'), 'utf8'));
  assert.ok(report.source?.sourceSha === sourceSha && report.source.worktreeClean === true, 'StrictDoc source must match clean checkout');
  assert.equal(report.source.documentScope, 'public', 'Pages requires the public StrictDoc export');
  assert.equal(report.source.registerPath, 'docs/requirements/REQUIREMENT-REGISTER.sdoc');
  assert.equal(report.toolchain?.strictdocVersion, '0.32.1');
  assert.equal(report.toolchain.requirementsLockSha256, hash(readFileSync('scripts/strictdoc/requirements.lock.txt')), 'StrictDoc lock mismatch');
  assert.equal(report.traceability?.TRC01?.status, 'LOCAL_PASS');
  assert.equal(report.traceability?.TRC02?.status, 'LOCAL_PASS');
  assert.equal(report.traceability?.TRC07?.staticStaging, 'PASSED');
  assert.equal(report.traceability?.TRC07?.browserAcceptance, 'PASSED');
  const { trace, html } = publicTraceability(report, sourceSha, receipt);
  const rawNames = ['html', 'json'].flatMap(folder => files(join(output, folder)).map(name => `${folder}/${name}`)).sort();
  assert.ok(Array.isArray(report.exports?.rawFiles), 'StrictDoc raw inventory missing');
  assert.deepEqual(report.exports.rawFiles.map(item => item.name), rawNames, 'StrictDoc raw inventory mismatch');
  for (const item of report.exports.rawFiles) {
    const bytes = readFileSync(join(output, item.name));
    assert.equal(bytes.length, item.bytes, 'StrictDoc raw size mismatch');
    assert.equal(hash(bytes), item.sha256, 'StrictDoc raw digest mismatch');
  }
  const dest = join(site, 'requirements');
  assert.ok(!existsSync(dest), 'Requirements destination must not exist');
  for (const folder of ['html', 'json']) { files(join(output, folder)); mkdirSync(dest, { recursive: true }); cpSync(join(output, folder), join(dest, folder), { recursive: true, errorOnExist: true }); }
  publishStrictDocLinks(join(dest, 'html'), sourceSha);
  const indexPath = join(dest, 'html/index.html');
  const index = readFileSync(indexPath, 'utf8');
  assert.match(index, /<body\b[^>]*>/iu, 'StrictDoc index has no body');
  writeFileSync(indexPath, index.replace(/<body\b[^>]*>/iu, '$&<nav aria-label="Development Portal"><a href="../../">Development Portal</a></nav>'));
  const entries = files(dest).map(name => { const data = readFileSync(join(dest, name)); return { name, bytes: data.length, sha256: hash(data) }; });
  assert.ok(entries.some(x => x.name === 'html/index.html') && entries.some(x => x.name === 'html/docs/requirements/REQUIREMENT-REGISTER.sdoc-TRACE.html') && entries.some(x => x.name === 'json/index.json'), 'Missing StrictDoc output');
  const legacy = join(dest, 'html/requirements');
  mkdirSync(legacy, { recursive: true });
  for (const view of ['', '-TRACE', '-DEEP-TRACE', '-TABLE']) {
    const file = `REQUIREMENT-REGISTER.sdoc${view}.html`;
    const target = `../docs/requirements/${file}`;
    if (!existsSync(join(dest, 'html/docs/requirements', file))) continue;
    writeFileSync(join(legacy, `REQUIREMENT-REGISTER.md${view}.html`),
      `<!doctype html><meta charset="utf-8"><title>Requirement register</title><a href="${target}">Open the requirement register</a><script>location.replace(${JSON.stringify(target)} + location.hash)</script>\n`);
  }
  const traceRoot = join(dest, 'traceability');
  mkdirSync(traceRoot, { recursive: true });
  for (const name of ['traceability.css', 'traceability-ui.js']) cpSync(join('scripts/audit', name), join(traceRoot, name));
  writeFileSync(join(traceRoot, 'index.html'), html);
  writeFileSync(join(traceRoot, 'traceability.json'), JSON.stringify(trace, null, 2) + '\n');
  const traceIndex = readFileSync(indexPath, 'utf8').replace(/<body\b[^>]*>/iu, '$&<nav aria-label="Traceability"><a href="../traceability/">Traceability status and gaps</a></nav>');
  writeFileSync(indexPath, traceIndex);
  const updatedEntries = files(dest).map(name => { const data = readFileSync(join(dest, name)); return { name, bytes: data.length, sha256: hash(data) }; });
  const manifest = { schemaVersion: 1, sourceSha, generatedAt: new Date().toISOString(), publication: 'public', pagesQualification: trace.pagesQualification, qualificationGates: trace.qualificationGates, verificationReceipt: trace.verificationReceipt, inputContracts: traceInputDigests(), generator: report.toolchain, outputs: updatedEntries };
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export function verifySpecifications(site, sourceSha) {
  const root = join(site, 'requirements');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const trace = JSON.parse(readFileSync(join(root, 'traceability', 'traceability.json'), 'utf8'));
  assert.equal(manifest.sourceSha, sourceSha, 'Requirements source mismatch');
  assert.equal(manifest.publication, 'public');
  assert.deepEqual(manifest.pagesQualification, trace.pagesQualification, 'TRC-07 publication qualification mismatch');
  assert.deepEqual(manifest.pagesQualification, {
    status: 'PENDING_PAGES_PUBLISH', sourceSha, publisher: '.github/workflows/repository-audit.yml',
    strictDocStaticStaging: 'PASSED', strictDocBrowserAcceptance: 'PASSED', publicUrlConfirmation: 'PENDING',
    publisherExecution: trace.execution,
    detail: 'Staging checks passed; this exact source SHA still requires public Pages URL confirmation.',
  }, 'TRC-07 publisher execution is missing, stale, or foreign');
  assert.ok(manifest.verificationReceipt && manifest.verificationReceipt.sourceSha === sourceSha && ['CERTIFIED', 'NOT_AVAILABLE'].includes(manifest.verificationReceipt.status), 'Verify artifact receipt is missing or source-mismatched');
  assert.deepEqual(trace.verificationReceipt, manifest.verificationReceipt, 'Verify artifact receipt differs from public trace JSON');
  assert.deepEqual(trace.qualificationGates, manifest.qualificationGates, 'Qualification gate projection differs from public trace JSON');
  assert.equal(manifest.generator?.strictdocVersion, '0.32.1');
  assert.deepEqual(manifest.inputContracts, traceInputDigests(), 'Requirements input digest mismatch');
  assert.equal(manifest.generator.requirementsLockSha256, hash(readFileSync('scripts/strictdoc/requirements.lock.txt')), 'Requirements lock mismatch');
  const actual = files(root).filter(name => name !== 'manifest.json');
  assert.deepEqual(actual, manifest.outputs.map(x => x.name), 'Requirements output inventory mismatch');
  for (const item of manifest.outputs) { const data = readFileSync(join(root, item.name)); assert.equal(data.length, item.bytes, 'Requirements size mismatch'); assert.equal(hash(data), item.sha256, 'Requirements digest mismatch'); }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const [site, output, sha, receiptPath] = process.argv.slice(2); const receipt = receiptPath ? JSON.parse(readFileSync(receiptPath, 'utf8')) : { status: 'NOT_AVAILABLE', sourceSha: sha }; packSpecifications(site, output, sha, receipt); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
