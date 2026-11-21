// Read-only CI observability. Neither a verification gate nor release authority.
import { summarizeCiTiming, seconds } from '../ci-timing.mjs';

const stamp = input => { const n = Date.parse(input ?? ''); return Number.isFinite(n) ? n : null; };
const value = input => String(input ?? '').slice(0, 180);
const elapsed = (a,b) => seconds(a,b);
const current = (run, job) =>
  job.conclusion !== 'skipped' &&
  (job.run_attempt === undefined || Number(job.run_attempt) === Number(run.run_attempt)) &&
  (Number(run.run_attempt) <= 1 || stamp(job.started_at) >= stamp(run.run_started_at));

export function readVerifyGraph(source) {
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
  if (!graph.some(j => j.id === 'plan') || !graph.some(j => j.id === 'certification') ||
    graph.some(j => !j.template || j.needs.some(id => !graph.some(p => p.id === id)))) {
    throw new Error('Unrecognized Verify dependency graph');
  }
  return graph;
}

export function nameMatches(template, name) {
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
      const parents = mapped.filter(p => at.spec.needs.includes(p.spec.id) &&
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

function phase(name) {
  if (/Set up job|Initialize containers|checkout|setup-node/iu.test(name)) return 'Setup';
  if (/cache|pnpm|Install frozen|Install workspace|Prepare exact/iu.test(name)) return 'Dependencies';
  if (/build|profile|pack|image/iu.test(name)) return 'Build';
  if (/upload-artifact|download-artifact|Restore exact/iu.test(name)) return 'Artifacts';
  if (/test|validat|typecheck|lint|certif|Run selected/iu.test(name)) return 'Validation';
  return 'Other';
}

export function observeRun(run, jobs, verifySource) {
  const relevant = jobs.filter(job => current(run, job));
  const timing = summarizeCiTiming(run, jobs);
  const chain = run.name === 'Verify Codexia' ? blockingChain(run, jobs, verifySource) : null;
  const path = new Set(chain?.names ?? []);
  const observedJobs = relevant.map(job => ({
    id: job.id, name: value(job.name), status: job.status, conclusion: job.conclusion,
    createdAt: job.created_at ?? null, startedAt: job.started_at ?? null, completedAt: job.completed_at ?? null,
    queueSeconds: elapsed(job.created_at, job.started_at), durationSeconds: elapsed(job.started_at, job.completed_at),
    runner: value(job.runner_name || job.runner_group_name || 'Not reported'),
    critical: path.has(job.name), url: job.html_url,
    steps: (job.steps ?? []).filter(step => step.started_at && step.completed_at).map(step => ({
      name: value(step.name), phase: phase(step.name),
      durationSeconds: elapsed(step.started_at, step.completed_at), conclusion: step.conclusion,
    })),
  }));
  return {
    id: run.id, name: value(run.name), sha: run.head_sha, attempt: run.run_attempt,
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
    chain, jobs: observedJobs,
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
