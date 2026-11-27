// Read-only CI observability. Neither a verification gate nor release authority.
import { summarizeCiTiming, seconds } from './timing.mjs';
import { VERIFICATION_GROUPS, VERIFICATION_LEAF_JOBS } from '../impact/contract.mjs';
import { normalizeVerificationJobName } from '../evidence/job-name.mjs';

const stamp = input => { const n = Date.parse(input ?? ''); return Number.isFinite(n) ? n : null; };
const value = input => String(input ?? '').slice(0, 180);
const elapsed = (a,b) => seconds(a,b);
const currentAttempt = (run, job) =>
  (job.run_attempt === undefined || Number(job.run_attempt) === Number(run.run_attempt)) &&
  (Number(run.run_attempt) <= 1 || stamp(job.started_at) >= stamp(run.run_started_at));
const current = (run, job) => job.conclusion !== 'skipped' && currentAttempt(run, job);

function parseWorkflowGraph(source) {
  const graph = [];
  let inJobs = false, active = null, readingNeeds = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^jobs:\s*$/u.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^[^\s#]/u.test(line)) break;
    const job = /^  ([\w-]+):\s*$/u.exec(line);
    if (job) { active = { id: job[1], template: null, needs: [] }; graph.push(active); readingNeeds = false; continue; }
    if (!active) continue;
    const name = /^    name:\s*(.*?)\s*$/u.exec(line);
    if (name) { active.template = name[1].replace(/^['"]|['"]$/gu, ''); readingNeeds = false; continue; }
    const needs = /^    needs:\s*(.*?)\s*$/u.exec(line);
    if (needs) {
      readingNeeds = !needs[1];
      if (needs[1]) active.needs.push(...needs[1].replace(/^\[|\]$/gu, '').split(/\s*,\s*|\s+/u).filter(Boolean));
      continue;
    }
    if (readingNeeds && /^      - ([\w-]+)\s*$/u.test(line)) {
      active.needs.push(/^      - ([\w-]+)\s*$/u.exec(line)[1]); continue;
    }
    if (/^    [^\s#]/u.test(line)) readingNeeds = false;
  }
  return graph;
}

export function readVerifyGraph(source, profileSource) {
  const mainSource = typeof source === 'object' && source !== null ? source.verify : source;
  const nestedSource = profileSource ?? (typeof source === 'object' && source !== null ? source.profile : null);
  const graph = parseWorkflowGraph(mainSource);
  if (nestedSource) {
    const nested = parseWorkflowGraph(nestedSource);
    const build = nested.find(job => job.id === 'build');
    const browser = nested.find(job => job.id === 'browser');
    if (!build?.template || !browser?.template || !browser.needs.includes('build')) {
      throw new Error('Unrecognized Verify profile dependency graph');
    }
    const callers = ['core', 'full'].map(profile => ({
      id: `profile_${profile}`, template: `profile-${profile}`, needs: ['plan'],
    }));
    if (callers.some(caller => !graph.some(job => job.id === caller.id && job.template === caller.template))) {
      throw new Error('Verify profile callers are unavailable');
    }
    for (const caller of callers) {
      const profile = caller.id.slice('profile_'.length);
      const callerNeeds = graph.find(job => job.id === caller.id).needs;
      const nestedName = value => value.replace(/\$\{\{\s*inputs\.profile\s*\}\}/gu, profile);
      const prefix = `profile-${profile} / `;
      graph.push({ id: `${caller.id}_build`, family: caller.id,
        template: prefix + nestedName(build.template), needs: [...callerNeeds] });
      graph.push({ id: `${caller.id}_browser`, family: caller.id,
        template: prefix + nestedName(browser.template), needs: [`${caller.id}_build`] });
      graph.push({ id: `${caller.id}_legacy_build`, family: caller.id,
        template: `build-${profile}`, needs: ['plan'] });
      for (const group of Object.keys(VERIFICATION_GROUPS).filter(name => name.startsWith(`browser-${profile}-`))) {
        graph.push({ id: `${caller.id}_legacy_${group}`, family: caller.id, template: group, needs: ['plan'] });
      }
    }
    for (let index = graph.length - 1; index >= 0; index--) {
      if (callers.some(caller => graph[index].id === caller.id)) graph.splice(index, 1);
    }
  }
  if (!graph.some(j => j.id === 'plan') || !graph.some(j => j.id === 'certification') ||
    graph.some(j => !j.template || j.needs.some(id => !graph.some(p => p.id === id || p.family === id)))) {
    throw new Error('Unrecognized Verify dependency graph');
  }
  return graph;
}

export function nameMatches(template, name) {
  const wrappedTemplate = /^profile-(?:core|full) \/ /u.test(template);
  const canonicalTemplate = normalizeVerificationJobName(template);
  const canonicalName = normalizeVerificationJobName(name);
  if (canonicalTemplate !== null && !template.includes('${{')) return name === template;
  if (/^profile-(?:core|full) \/ /u.test(name) && canonicalName === null) return false;
  if (/^profile-(?:core|full) \/ /u.test(name) && !wrappedTemplate) return false;
  const parts = template.split(/\$\{\{[^}]*\}\}/u);
  const quote = part => part.replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&');
  return new RegExp('^' + parts.map(quote).join('.+') + '$', 'u').test(name);
}

export function blockingChain(run, jobs, workflowSource) {
  try {
    const graph = readVerifyGraph(workflowSource);
    const nodes = jobs.filter(job => current(run, job) && stamp(job.completed_at) !== null).map(job => {
      const matched = graph.filter(spec => nameMatches(spec.template, job.name));
      return { job, spec: matched.length === 1 ? matched[0] : null };
    });
    const mapped = nodes.filter(node => node.spec);
    const finish = mapped.find(node => node.spec.id === 'certification' && node.job.conclusion === 'success');
    if (!finish) {
      return { names: [], verified: false, reason: 'Certification or job-to-DAG mapping unavailable' };
    }
    const names = [], seen = new Set();
    let at = finish;
    while (at) {
      if (seen.has(at.job.id)) return { names: [], verified: false, reason: 'Dependency cycle' };
      seen.add(at.job.id);
      names.unshift(at.job.name);
      if (!at.spec.needs.length) break;
      const parents = mapped.filter(p => (at.spec.needs.includes(p.spec.id) || at.spec.needs.includes(p.spec.family)) &&
        stamp(p.job.completed_at) <= stamp(at.job.started_at));
      if (!parents.length) return { names: [], verified: false, reason: 'Predecessor timing unavailable' };
      parents.sort((a,b) => stamp(b.job.completed_at) - stamp(a.job.completed_at));
      at = parents[0];
    }
    return { names, verified: true,
      reason: 'Observed latest-finishing dependency chain; not a counterfactual CPM speedup',
      certificationSeconds: elapsed(run.run_attempt > 1 ? run.run_started_at : run.created_at, finish.job.completed_at) };
  } catch (error) {
    return { names: [], verified: false, reason: error instanceof Error ? error.message : 'Graph unavailable' };
  }
}

// Attribute the observed certification tail, not a counterfactual speedup.
export function diagnoseVerifyBottleneck(run, jobs, chain) {
  const unavailable = reason => ({ available: false, reason });
  if (run.name !== 'Verify Codexia' || run.status !== 'completed' ||
      run.conclusion !== 'success' || Number(run.run_attempt) !== 1 || !chain?.verified) {
    return unavailable('A completed, successful first-attempt Verify chain is required');
  }
  const certification = jobs.find(job => current(run, job) && job.name === 'certification' &&
    job.conclusion === 'success');
  const leafName = chain.names.at(-2);
  const leaf = jobs.find(job => current(run, job) && job.name === leafName && job.conclusion === 'success');
  if (!certification || !leaf || stamp(certification.started_at) === null ||
      stamp(certification.completed_at) === null || stamp(leaf.completed_at) === null ||
      stamp(leaf.started_at) === null) return unavailable('Certification or leaf timestamps unavailable');

  // Only jobs eligible to gate certification may compete for the last leaf.
  const candidates = jobs.filter(job => current(run, job) && job.name !== 'certification' &&
    VERIFICATION_LEAF_JOBS.includes(job.name) && job.conclusion === 'success' &&
    stamp(job.completed_at) !== null &&
    stamp(job.completed_at) <= stamp(certification.started_at))
    .sort((a, b) => stamp(b.completed_at) - stamp(a.completed_at));
  if (!candidates.length || candidates[0].name !== leaf.name) {
    return unavailable('Last canonical leaf does not match the observed dependency chain');
  }
  const runnerUp = candidates.find(job => job.id !== leaf.id);
  const validation = (leaf.steps ?? []).find(step => step.name === 'Run selected validations' &&
    step.started_at && step.completed_at);
  const container = (leaf.steps ?? []).find(step => step.name === 'Initialize containers' &&
    step.started_at && step.completed_at);
  return {
    available: true, leafName: leaf.name, leafSeconds: elapsed(leaf.started_at, leaf.completed_at),
    leafQueueSeconds: elapsed(leaf.created_at, leaf.started_at),
    beforeValidationSeconds: validation ? elapsed(leaf.started_at, validation.started_at) : null,
    validationSeconds: validation ? elapsed(validation.started_at, validation.completed_at) : null,
    afterValidationSeconds: validation ? elapsed(validation.completed_at, leaf.completed_at) : null,
    containerSeconds: container ? elapsed(container.started_at, container.completed_at) : null,
    certificationTailSeconds: elapsed(leaf.completed_at, certification.completed_at),
    runnerUpName: runnerUp?.name ?? null,
    runnerUpGapSeconds: runnerUp ? elapsed(runnerUp.completed_at, leaf.completed_at) : null,
    nearFinish: candidates.filter(job => elapsed(job.completed_at, leaf.completed_at) <= 15)
      .slice(0, 8).map(job => ({
        name: job.name, behindSeconds: elapsed(job.completed_at, leaf.completed_at),
      })),
  };
}

function phase(name) {
  if (/Set up job|Initialize containers|checkout|setup-node/iu.test(name)) return 'Setup';
  if (/cache|pnpm|Install frozen|Install workspace|Prepare exact/iu.test(name)) return 'Dependencies';
  if (/upload-artifact|download-artifact|Restore exact/iu.test(name)) return 'Artifacts';
  if (/build|profile|pack|image/iu.test(name)) return 'Build';
  if (/test|validat|typecheck|lint|certif|Run selected/iu.test(name)) return 'Validation';
  return 'Other';
}

export function observeRun(run, jobs, verifySource) {
  const relevant = jobs.filter(job => current(run, job));
  const visibleJobs = jobs.filter(job => currentAttempt(run, job));
  const timing = summarizeCiTiming(run, jobs);
  const chain = run.name === 'Verify Codexia' ? blockingChain(run, jobs, verifySource) : null;
  const path = new Set(chain?.names ?? []);
  const observedJobs = visibleJobs.map(job => ({
    id: job.id, name: value(job.name), status: job.status, conclusion: job.conclusion,
    createdAt: job.created_at ?? null, startedAt: job.started_at ?? null, completedAt: job.completed_at ?? null,
    queueSeconds: elapsed(job.created_at, job.started_at), durationSeconds: elapsed(job.started_at, job.completed_at),
    runner: value(job.runner_name || job.runner_group_name || 'Not reported'),
    runnerLabels: Array.isArray(job.labels) ? job.labels.filter(item => typeof item === 'string').slice(0,12).map(value) : [],
    critical: path.has(job.name), url: job.html_url,
    steps: (job.steps ?? []).map(step => ({
      number: Number.isSafeInteger(step.number) ? step.number : null,
      name: value(step.name), phase: phase(step.name),
      startedAt: step.started_at ?? null, completedAt: step.completed_at ?? null,
      durationSeconds: elapsed(step.started_at, step.completed_at), conclusion: step.conclusion,
    })),
  }));
  return {
    id: run.id, workflowId: run.workflow_id ?? null, event: run.event ?? null,
    name: value(run.name), sha: run.head_sha, attempt: run.run_attempt,
    conclusion: run.conclusion, status: run.status, url: run.html_url,
    createdAt: run.created_at, startedAt: run.run_started_at,
    completedAt: run.status === 'completed'
      ? relevant.map(job => job.completed_at).filter(Boolean).sort().at(-1) ?? run.updated_at : null,
    timing: {
      wallClockSeconds: timing.wallClockSeconds, runnerSeconds: timing.runnerSeconds,
      queueSeconds: timing.queueSeconds, certificationSeconds: timing.certificationElapsedSeconds,
      carriedJobCount: timing.carriedJobCount, skippedJobCount: timing.skippedJobCount,
      comparable: run.status === 'completed' && run.run_attempt === 1 && timing.carriedJobCount === 0,
    },
    chain, bottleneck: run.name === 'Verify Codexia'
      ? diagnoseVerifyBottleneck(run, jobs, chain) : null,
    jobs: observedJobs,
  };
}

export function summarizePR(number, sha, runs, { sampleTruncated = false } = {}) {
  const ordered = [...runs].sort((a,b) => stamp(a.createdAt) - stamp(b.createdAt));
  const starts = ordered.map(r => stamp(r.createdAt)).filter(v => v !== null);
  const ends = ordered.map(r => stamp(r.completedAt)).filter(v => v !== null);
  const verify = ordered.find(r => r.name === 'Verify Codexia') ?? null;
  const complete = ordered.length > 0 && verify !== null && !sampleTruncated &&
    ordered.every(r => r.status === 'completed');
  const elapsedSeconds = complete && starts.length === ordered.length && ends.length === ordered.length
    ? (Math.max(...ends) - Math.min(...starts)) / 1000 : null;
  return {
    number, sha, createdAt: ordered.at(0)?.createdAt ?? null,
    complete, sampleTruncated, elapsedSeconds,
    runnerSeconds: complete && ordered.every(r => r.timing.runnerSeconds !== null)
      ? ordered.reduce((sum,r) => sum + r.timing.runnerSeconds, 0) : null,
    verifyId: verify?.id ?? null, runs: ordered,
  };
}

export function comparableHistory(items) {
  return items.filter(item => item.complete === true && item.sampleTruncated !== true &&
    item.verifyId !== null && item.verifyId !== undefined && item.elapsedSeconds !== null &&
    Array.isArray(item.runs) && item.runs.length > 0 &&
    item.runs.every(run => run.timing.comparable));
}
