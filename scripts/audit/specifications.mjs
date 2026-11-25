#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const esc = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function exactExecution(execution, sourceSha) {
  assert.ok(execution && typeof execution === 'object', 'StrictDoc execution identity missing');
  if (execution.status === 'NOT_RUN') return { status: 'NOT_RUN', sourceSha };
  assert.equal(execution.status, 'IN_PROGRESS', 'Invalid StrictDoc execution status');
  assert.equal(execution.sourceSha, sourceSha, 'StrictDoc exact-source execution SHA mismatch');
  assert.match(execution.repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'Invalid execution repository');
  assert.match(String(execution.runId ?? ''), /^\d+$/u, 'Invalid execution run ID');
  assert.ok(Number.isInteger(execution.runAttempt) && execution.runAttempt > 0, 'Invalid execution attempt');
  assert.ok(typeof execution.job === 'string' && !/\s/u.test(execution.job), 'Invalid execution job');
  assert.ok(typeof execution.task === 'string' && !/\s/u.test(execution.task), 'Invalid execution task');
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

function publicTraceability(report, sourceSha) {
  const rows = report.obligationTrace?.rows;
  const obligationGaps = report.obligationTrace?.gaps;
  const reverseRows = report.reverseTrace?.rows;
  const reverseGaps = report.reverseTrace?.gaps;
  const caseExecutions = report.caseExecutions;
  assert.ok(Array.isArray(rows) && Array.isArray(obligationGaps), 'StrictDoc obligation trace is missing');
  assert.ok(Array.isArray(reverseRows) && Array.isArray(reverseGaps), 'StrictDoc reverse trace is missing');
  assert.ok(Array.isArray(caseExecutions), 'StrictDoc case execution inventory is missing');
  const execution = exactExecution(report.execution, sourceSha);
  const caseById = new Map(caseExecutions.map(item => {
    assert.ok(item && /^TEST-(?:[A-Z0-9]+-)+\d{3}$/u.test(item.testId ?? ''), 'Invalid observed TEST-ID');
    assert.ok(['PASSED', 'FAILED', 'BLOCKED', 'NOT_RUN'].includes(item.result), `Invalid observed test result for ${item.testId}`);
    return [item.testId, item];
  }));
  const publicRows = rows.map(row => {
    assert.ok(row && /^REQ-[A-Z]+-\d{3}$/u.test(row.requirementId ?? '') && /^OBL-REQ-[A-Z]+-\d{3}-O\d{2}$/u.test(row.obligationId ?? ''), 'Invalid obligation trace identity');
    const testIds = row.testIds ?? [];
    const exactRuns = publicExactRuns(row.exactRuns ?? [], testIds, execution, caseById);
    return {
      requirementId: row.requirementId, obligationId: row.obligationId,
      statement: row.obligationText ?? '', decisionStatus: row.decisionStatus ?? 'UNKNOWN',
      conformanceStatus: row.conformanceStatus ?? 'UNMAPPED', applicability: row.applicability ?? 'UNKNOWN',
      status: row.status, designRefs: row.designRefs ?? [], sourceRefs: row.sourceRefs ?? [],
      implementationIdentifiers: row.implementationIdentifiers ?? [], surfaceIdentifiers: row.surfaceIdentifiers ?? [],
      testIds: row.testIds ?? [], exactRuns,
    };
  });
  const requirements = [...new Set(report.source.requirementIds ?? publicRows.map(row => row.requirementId))].sort().map(requirementId => {
    const matching = publicRows.filter(row => row.requirementId === requirementId);
    return {
      requirementId,
      decisionStatus: matching[0]?.decisionStatus ?? 'UNKNOWN',
      conformanceStatus: matching[0]?.conformanceStatus ?? 'UNMAPPED',
      applicability: matching[0]?.applicability ?? 'UNKNOWN',
      obligationIds: matching.map(row => row.obligationId),
    };
  });
  const obligationById = new Map(publicRows.map(row => [row.obligationId, row]));
  const reverse = reverseRows.map(row => {
    assert.ok(row?.surface && typeof row.surface.kind === 'string' && typeof row.surface.id === 'string', 'Invalid reverse trace surface identity');
    assert.notEqual(row.status, 'VERIFIED', 'Reverse trace cannot certify VERIFIED');
    const obligation = row.obligationId ? obligationById.get(row.obligationId) : undefined;
    assert.ok(!row.obligationId || obligation, `Reverse trace references unknown obligation ${row.obligationId}`);
    if (obligation) assert.equal(row.requirementId, obligation.requirementId, 'Reverse trace requirement relation mismatch');
    else assert.ok(!row.requirementId, 'Reverse trace requirement requires an obligation relation');
    const exactRuns = obligation?.exactRuns ?? [];
    assert.deepEqual(row.exactRuns ?? [], exactRuns, `Reverse trace exact-run evidence mismatch for ${row.surface.kind} ${row.surface.id}`);
    return {
      surface: row.surface, requirementId: row.requirementId ?? null, obligationId: row.obligationId ?? null,
      status: row.status, provenance: row.provenance ?? '', source: row.source ?? null,
      testIds: row.testIds ?? [], exactRuns,
    };
  });
  const publicCases = caseExecutions.map(item => ({
    testId: item.testId, result: item.result, ...(item.file ? { file: item.file } : {}),
    ...(Number.isInteger(item.line) ? { line: item.line } : {}),
  }));
  const conformanceCounts = Object.fromEntries([...new Set(requirements.map(item => item.conformanceStatus))].sort().map(status => [status, requirements.filter(item => item.conformanceStatus === status).length]));
  const statusCounts = Object.fromEntries([...new Set(publicRows.map(item => item.status))].sort().map(status => [status, publicRows.filter(item => item.status === status).length]));
  const trace = {
    schemaVersion: 1, sourceSha, generatedAt: report.generatedAt,
    summary: {
      requirementCount: requirements.length, obligationCount: publicRows.length,
      reverseSurfaceCount: reverse.length, obligationGapCount: obligationGaps.length,
      reverseGapCount: reverseGaps.length, conformanceCounts, statusCounts,
      observedCaseCount: publicCases.length, passedCaseCount: publicCases.filter(item => item.result === 'PASSED').length,
    },
    requirements, obligations: publicRows, reverseTrace: reverse,
    gaps: { obligations: obligationGaps, reverse: reverseGaps },
    caseExecutions: publicCases, execution,
  };
  const rowsHtml = publicRows.map(row => `<tr><td>${esc(row.requirementId)}</td><td>${esc(row.obligationId)}</td><td>${esc(row.conformanceStatus)} · ${esc(row.status)}</td><td>${esc(row.designRefs.join('; '))}</td><td>${esc([...row.implementationIdentifiers, ...row.surfaceIdentifiers.map(item => `${item.kind}=${item.id}`)].join('; '))}</td><td>${esc(row.testIds.join(', ') || 'No TEST-ID')}</td><td>${row.exactRuns.length ? row.exactRuns.map(item => `<a href="${esc(item.url)}">${esc(item.result)} · run ${esc(item.runId)} attempt ${esc(item.attempt)}</a>`).join('<br>') : 'No exact-source run'}</td></tr>`).join('');
  const reverseHtml = reverse.map(row => `<tr><td>${esc(row.surface?.kind ?? 'unknown')}</td><td>${esc(row.surface?.id ?? 'unknown')}</td><td>${esc(row.requirementId ?? 'UNMAPPED')}</td><td>${esc(row.status)}</td><td>${esc(row.source?.path ?? '')}</td></tr>`).join('');
  const gapHtml = [...obligationGaps.map(item => ({ source: 'Obligation', detail: typeof item === 'string' ? item : JSON.stringify(item) })), ...reverseGaps.map(item => ({ source: 'Reverse inventory', detail: typeof item === 'string' ? item : `${item.kind ?? item.area ?? 'gap'}: ${item.reason ?? item.provenance ?? JSON.stringify(item)}` }))]
    .map(item => `<li><strong>${esc(item.source)}</strong> · ${esc(item.detail)}</li>`).join('');
  const runNote = execution.status === 'IN_PROGRESS'
    ? `Observed in <a href="${esc(execution.runUrl)}">Actions run ${esc(execution.runId)}</a>, attempt ${esc(execution.attempt)}, job ${esc(execution.job)}, task ${esc(execution.task)} for source <code>${esc(sourceSha)}</code>. The existing Verify certifier binds the uploaded artifact separately.`
    : `No GitHub Actions execution was present for source <code>${esc(sourceSha)}</code>.`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Requirements traceability status</title></head><body><main><nav aria-label="Development Portal"><a href="../../">Development Portal</a> · <a href="../html/">StrictDoc requirements</a> · <a href="traceability.json">Traceability JSON</a></nav><h1>Requirements traceability status</h1><p>Source SHA <code>${esc(sourceSha)}</code></p><p>Static references establish trace links only. They do not establish semantic implementation fit, test sufficiency, or product conformance.</p><p>${runNote}</p><section><h2>Coverage summary</h2><p>${trace.summary.requirementCount} requirements · ${trace.summary.obligationCount} obligations · ${trace.summary.reverseSurfaceCount} discovered surfaces · ${trace.summary.obligationGapCount + trace.summary.reverseGapCount} visible gaps</p><ul>${Object.entries(conformanceCounts).map(([status, count]) => `<li>${esc(status)}: ${count}</li>`).join('')}</ul></section><section><h2>Requirement obligations</h2><table><thead><tr><th>Requirement</th><th>Obligation</th><th>Status</th><th>Design</th><th>Implementation</th><th>Tests</th><th>Exact-source run</th></tr></thead><tbody>${rowsHtml}</tbody></table></section><section><h2>Reverse surface inventory</h2><table><thead><tr><th>Kind</th><th>Identifier</th><th>Requirement</th><th>Status</th><th>Source</th></tr></thead><tbody>${reverseHtml}</tbody></table></section><section><h2>Unresolved gaps</h2><ul>${gapHtml}</ul></section><section><h2>Observed test execution</h2><p>${trace.summary.passedCaseCount} of ${trace.summary.observedCaseCount} declared trace cases reported PASSED in this execution. This applies to those cases only.</p><ul>${publicCases.map(item => `<li>${esc(item.testId)} · ${esc(item.result)} · ${esc(item.file ?? '')}${item.line ? `:${item.line}` : ''}</li>`).join('')}</ul></section></main></body></html>\n`;
  return { trace, html };
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
export function packSpecifications(site, output, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/u, 'Invalid source SHA');
  const report = JSON.parse(readFileSync(join(output, 'trace-report.json'), 'utf8'));
  assert.ok(report.source?.sourceSha === sourceSha && report.source.worktreeClean === true, 'StrictDoc source must match clean checkout');
  assert.equal(report.source.registerPath, 'docs/requirements/REQUIREMENT-REGISTER.md');
  assert.equal(report.toolchain?.strictdocVersion, '0.32.1');
  assert.equal(report.toolchain.requirementsLockSha256, hash(readFileSync('scripts/strictdoc/requirements.lock.txt')), 'StrictDoc lock mismatch');
  assert.equal(report.traceability?.TRC01?.status, 'LOCAL_PASS');
  assert.equal(report.traceability?.TRC02?.status, 'LOCAL_PASS');
  assert.equal(report.traceability?.TRC07?.staticStaging, 'PASSED');
  assert.equal(report.traceability?.TRC07?.browserAcceptance, 'PASSED');
  const { trace, html } = publicTraceability(report, sourceSha);
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
  const indexPath = join(dest, 'html/index.html');
  const index = readFileSync(indexPath, 'utf8');
  assert.match(index, /<body\b[^>]*>/iu, 'StrictDoc index has no body');
  writeFileSync(indexPath, index.replace(/<body\b[^>]*>/iu, '$&<nav aria-label="Development Portal"><a href="../../">Development Portal</a></nav>'));
  const entries = files(dest).map(name => { const data = readFileSync(join(dest, name)); return { name, bytes: data.length, sha256: hash(data) }; });
  assert.ok(entries.some(x => x.name === 'html/index.html') && entries.some(x => x.name === 'html/requirements/REQUIREMENT-REGISTER.md-TRACE.html') && entries.some(x => x.name === 'json/index.json'), 'Missing StrictDoc output');
  const traceRoot = join(dest, 'traceability');
  mkdirSync(traceRoot, { recursive: true });
  writeFileSync(join(traceRoot, 'index.html'), html);
  writeFileSync(join(traceRoot, 'traceability.json'), JSON.stringify(trace, null, 2) + '\n');
  const traceIndex = readFileSync(indexPath, 'utf8').replace(/<body\b[^>]*>/iu, '$&<nav aria-label="Traceability"><a href="../traceability/">Traceability status and gaps</a></nav>');
  writeFileSync(indexPath, traceIndex);
  const inputPaths = ['docs/architecture/DOCUMENTATION-AUTHORITY.md', 'docs/architecture/SPECIFICATION-IMPLEMENTATION-CONTRACT.md', 'docs/architecture/SPECIFICATION-TOOLCHAIN.md', 'docs/requirements/REQUIREMENT-REGISTER.md', 'docs/requirements/STRICTDOC-TRACEABILITY.md', 'docs/requirements/STRICTDOC-GRAMMAR.gra.md', 'docs/verification/TRACEABILITY-REGISTER.md', 'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.md', 'scripts/strictdoc/strictdoc_config.py', 'scripts/strictdoc/surface-inventory.json', 'scripts/strictdoc/requirements.lock.txt', 'scripts/strictdoc/verify.mjs', 'scripts/strictdoc/obligation-trace.mjs', 'scripts/strictdoc/reverse-trace.mjs', 'scripts/strictdoc/case-results.mjs', 'scripts/audit/specifications.mjs'];
  const updatedEntries = files(dest).map(name => { const data = readFileSync(join(dest, name)); return { name, bytes: data.length, sha256: hash(data) }; });
  const manifest = { schemaVersion: 1, sourceSha, generatedAt: new Date().toISOString(), publication: 'public', inputContracts: inputPaths.map(path => ({ path, sha256: hash(readFileSync(path)) })), generator: report.toolchain, outputs: updatedEntries };
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export function verifySpecifications(site, sourceSha) {
  const root = join(site, 'requirements');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sourceSha, sourceSha, 'Requirements source mismatch');
  assert.equal(manifest.publication, 'public');
  assert.equal(manifest.generator?.strictdocVersion, '0.32.1');
  const expectedInputs = ['docs/architecture/DOCUMENTATION-AUTHORITY.md', 'docs/architecture/SPECIFICATION-IMPLEMENTATION-CONTRACT.md', 'docs/architecture/SPECIFICATION-TOOLCHAIN.md', 'docs/requirements/REQUIREMENT-REGISTER.md', 'docs/requirements/STRICTDOC-TRACEABILITY.md', 'docs/requirements/STRICTDOC-GRAMMAR.gra.md', 'docs/verification/TRACEABILITY-REGISTER.md', 'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.md', 'scripts/strictdoc/strictdoc_config.py', 'scripts/strictdoc/surface-inventory.json', 'scripts/strictdoc/requirements.lock.txt', 'scripts/strictdoc/verify.mjs', 'scripts/strictdoc/obligation-trace.mjs', 'scripts/strictdoc/reverse-trace.mjs', 'scripts/strictdoc/case-results.mjs', 'scripts/audit/specifications.mjs'];
  assert.deepEqual(manifest.inputContracts, expectedInputs.map(path => ({ path, sha256: hash(readFileSync(path)) })), 'Requirements input digest mismatch');
  assert.equal(manifest.generator.requirementsLockSha256, hash(readFileSync('scripts/strictdoc/requirements.lock.txt')), 'Requirements lock mismatch');
  const actual = files(root).filter(name => name !== 'manifest.json');
  assert.deepEqual(actual, manifest.outputs.map(x => x.name), 'Requirements output inventory mismatch');
  for (const item of manifest.outputs) { const data = readFileSync(join(root, item.name)); assert.equal(data.length, item.bytes, 'Requirements size mismatch'); assert.equal(hash(data), item.sha256, 'Requirements digest mismatch'); }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const [site, output, sha] = process.argv.slice(2); packSpecifications(site, output, sha); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
