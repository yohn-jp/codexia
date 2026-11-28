import { createHash } from 'node:crypto';
import path from 'node:path';

const OBLIGATION_ID = /^OBL-(REQ-[A-Z]+-\d{3})-O(\d{2})$/u;
const REQUIREMENT_ID = /^REQ-[A-Z]+-\d{3}$/u;
export const TEST_ID = /^TEST-(?:[A-Z0-9]+-)+\d{3}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/u;

export function testIdReferences(node) {
  return String(node.TEST_IDS ?? '').split(/[\s,;]+/u)
    .filter(value => value.startsWith('TEST-') && value !== 'TEST-ID');
}

function deterministicMid(uid) {
  return createHash('sha256').update(uid, 'utf8').digest('hex').slice(0, 32);
}

function exactRunIsSourceBound(evidence, testId, { expectedRepository, expectedSourceSha }) {
  return evidence.testId === testId && RUN_URL.test(evidence.url ?? '') && SHA.test(evidence.sourceSha ?? '') &&
    /^\d+$/u.test(String(evidence.runId ?? '')) && Number.isInteger(evidence.attempt) && evidence.attempt > 0 &&
    typeof evidence.repository === 'string' && evidence.repository.length > 0 &&
    typeof evidence.job === 'string' && evidence.job.length > 0 &&
    typeof evidence.task === 'string' && evidence.task.length > 0 &&
    ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(evidence.result) &&
    (!expectedRepository || evidence.repository === expectedRepository) &&
    (!expectedSourceSha || evidence.sourceSha === expectedSourceSha) &&
    evidence.url === `https://github.com/${evidence.repository}/actions/runs/${evidence.runId}`;
}

/**
 * Build a forward requirement → obligation → design/source → TEST-ID → exact-run view.
 * This is a projection of explicit StrictDoc nodes and supplied run metadata; it does not
 * infer coverage from file presence, test titles, JUnit, symbols, or a run URL alone.
 */
export function buildObligationTrace({ requirements = [], obligations = [], scenarios = [], runEvidence = [], repositoryRoot, expectedRepository, expectedSourceSha }) {
  const violations = [];
  const gaps = [];
  if (runEvidence.length > 0 && (!expectedRepository || !SHA.test(expectedSourceSha ?? ''))) {
    violations.push('Expected repository and source SHA are required to validate exact-source run evidence');
  }
  const requirementById = new Map();
  for (const requirement of requirements) {
    if (!REQUIREMENT_ID.test(requirement.UID ?? '')) violations.push(`Invalid requirement UID ${String(requirement.UID)}`);
    if (requirementById.has(requirement.UID)) violations.push(`Duplicate requirement UID ${requirement.UID}`);
    requirementById.set(requirement.UID, requirement);
  }
  const scenarioById = new Map();
  for (const scenario of scenarios) {
    if (!TEST_ID.test(scenario.UID ?? '')) violations.push(`Invalid TEST-ID ${String(scenario.UID)}`);
    if (scenarioById.has(scenario.UID)) violations.push(`Duplicate TEST-ID ${scenario.UID}`);
    scenarioById.set(scenario.UID, scenario);
  }
  const seenRunEvidence = new Set();
  for (const evidence of runEvidence) {
    if (!scenarioById.has(evidence.testId)) violations.push(`Exact-source evidence refers to unknown TEST-ID ${String(evidence.testId)}`);
    const identity = [evidence.testId, evidence.repository, evidence.sourceSha, evidence.runId, evidence.attempt, evidence.job, evidence.task].join('\0');
    if (seenRunEvidence.has(identity)) violations.push(`Duplicate exact-source run evidence for ${String(evidence.testId)}`);
    seenRunEvidence.add(identity);
  }
  const obligationIds = new Set();
  const rows = [];
  for (const obligation of obligations) {
    const match = OBLIGATION_ID.exec(obligation.UID ?? '');
    if (!match) { violations.push(`Invalid obligation UID ${String(obligation.UID)}`); continue; }
    if (obligationIds.has(obligation.UID)) violations.push(`Duplicate obligation UID ${obligation.UID}`);
    obligationIds.add(obligation.UID);
    const requirementId = match[1];
    const requirement = requirementById.get(requirementId);
    if (!requirement) violations.push(`${obligation.UID} refers to unknown requirement ${requirementId}`);
    if (obligation.MID !== deterministicMid(obligation.UID)) violations.push(`MID for ${obligation.UID} is not deterministic`);
    if (obligation.EXACT_RUN_REFERENCE !== 'NOT_RUN') {
      violations.push(`${obligation.UID} authored Exact-run reference must be NOT_RUN; observed runs are attached in Verify evidence`);
    }
    const parents = (obligation.RELATIONS ?? []).filter((item) => item.TYPE === 'Parent').map((item) => item.VALUE);
    if (parents.length !== 1 || parents[0] !== requirementId) violations.push(`${obligation.UID} must have exactly one Parent relation to ${requirementId}`);
    const designRefs = String(obligation.DESIGN_REFERENCE ?? '').split(/\s*;\s*/u).filter(Boolean);
    const sourceRefs = (obligation.RELATIONS ?? []).filter(item => item.TYPE === 'File').map(item => {
      const sourcePath = item.VALUE ?? item.PATH;
      return { path: sourcePath, identifier: sourcePath };
    });
    const requirementImplementationIdentifiers = String(requirement?.IMPLEMENTATION_IDENTIFIERS ?? '').split(/\s*;\s*/u).filter(Boolean);
    const requirementComment = String(requirement?.COMMENT ?? '').trim();
    const surfaceIdentifiers = String(obligation.SURFACE_IDENTIFIERS ?? '').split(/\s*;\s*/u).filter(Boolean).map((item) => {
      const separator = item.indexOf('=');
      const kind = separator > 0 ? item.slice(0, separator) : '';
      const id = separator > 0 ? item.slice(separator + 1) : '';
      if (!['httpOperation', 'routeId', 'toolName', 'objectId', 'controlId', 'nativeIosView', 'iacResource', 'ansibleSource', 'ciWorkflow', 'surfaceId', 'identifier'].includes(kind) || !id) {
        violations.push(`${obligation.UID} has invalid surface identifier ${item}`);
        return null;
      }
      return { kind, id };
    }).filter(Boolean);
    const rawTestIds = testIdReferences(obligation);
    const testIds = rawTestIds.filter((value) => TEST_ID.test(value));
    for (const id of rawTestIds.filter((value) => !TEST_ID.test(value))) violations.push(`${obligation.UID} has invalid TEST-ID ${id}`);
    for (const id of testIds) {
      const scenario = scenarioById.get(id);
      if (!scenario) {
        violations.push(`${obligation.UID} refers to missing TEST-ID ${id}`);
        continue;
      }
      const scenarioParents = (scenario.RELATIONS ?? []).filter((item) => item.TYPE === 'Parent').map((item) => item.VALUE);
      if (!scenarioParents.includes(requirementId)) violations.push(`${obligation.UID} TEST-ID ${id} is not parented by ${requirementId}`);
      if (requirement && !testIdReferences(requirement).includes(id)) violations.push(`${obligation.UID} TEST-ID ${id} is not declared by ${requirementId}`);
    }
    if (new Set(testIds).size !== testIds.length) violations.push(`${obligation.UID} contains duplicate TEST-ID references`);
    const exactRuns = runEvidence.filter((evidence) => testIds.includes(evidence.testId) && exactRunIsSourceBound(evidence, evidence.testId, { expectedRepository, expectedSourceSha }));
    for (const evidence of runEvidence.filter((item) => testIds.includes(item.testId) && !exactRunIsSourceBound(item, item.testId, { expectedRepository, expectedSourceSha }))) {
      violations.push(`${obligation.UID} has incomplete or invalid exact-source run evidence for ${evidence.testId}`);
    }
    let status = 'MAPPED_UNVERIFIED';
    if (designRefs.length === 0 || sourceRefs.length === 0 || testIds.length === 0) status = 'PARTIAL';
    if (testIds.some((id) => !scenarioById.has(id))) status = 'BLOCKED';
    if (designRefs.length === 0) gaps.push(`${obligation.UID}: no design reference`);
    if (sourceRefs.length === 0) gaps.push(`${obligation.UID}: no source file reference`);
    if (testIds.length === 0) gaps.push(`${obligation.UID}: no TEST-ID`);
    for (const id of testIds) if (!exactRuns.some(evidence => evidence.testId === id)) gaps.push(`${obligation.UID}: no exact-source run evidence for ${id}`);
    for (const source of sourceRefs) {
      if (repositoryRoot && (typeof source.path !== 'string' || path.isAbsolute(source.path) || source.path.split(/[\\/]/u).includes('..'))) {
        violations.push(`${obligation.UID} source path must be repository-relative: ${String(source.path)}`);
      }
    }
    rows.push({
      requirementId, obligationId: obligation.UID, obligationText: obligation.STATEMENT ?? obligation.TITLE ?? '',
      decisionStatus: requirement?.DECISION_STATUS ?? 'UNKNOWN',
      conformanceStatus: requirement?.CONFORMANCE_STATUS ?? 'UNMAPPED',
      applicability: requirement?.APPLICABILITY ?? 'UNKNOWN',
      requirementImplementationIdentifiers, requirementComment,
      designRefs, sourceRefs,
      implementationIdentifiers: String(obligation.IMPLEMENTATION_IDENTIFIERS ?? '').split(/\s*;\s*/u).filter(Boolean),
      surfaceIdentifiers, testIds, exactRuns, status,
    });
  }
  for (const requirement of requirements) {
    const mapped = rows.filter((row) => row.requirementId === requirement.UID);
    if (mapped.length === 0) gaps.push(`${requirement.UID}: no individual obligation mapping`);
    for (const testId of testIdReferences(requirement)) {
      if (!scenarioById.has(testId)) violations.push(`${requirement.UID} declares missing TEST-ID ${testId}`);
    }
  }
  return { rows, gaps, violations: [...new Set(violations)] };
}
