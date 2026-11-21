// Bounded, read-only public Actions telemetry. The caller owns the transport.
import { observeRun, summarizePR } from './analysis.mjs';

const MAX_PAGES = 2;
const MAX_PRS = 20;
const MAX_RUNS = 20;
const CONCURRENCY = 4;

export function identity(run) {
  const associations = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  if (!associations.length || associations.some(value =>
    !Number.isSafeInteger(value?.number) || value.number < 1)) return null;
  const numbers = [...new Set(associations.map(value => value.number))];
  const sha = typeof run.head_sha === 'string' && /^[a-f0-9]{40}$/iu.test(run.head_sha)
    ? run.head_sha.toLowerCase() : null;
  return numbers.length === 1 && sha ? { number: numbers[0], sha } : null;
}

export function selectRuns(runs, maxPRs = MAX_PRS, maxRuns = MAX_RUNS) {
  const sorted = [...runs].filter(run => identity(run)).sort((a, b) =>
    Date.parse(b.created_at) - Date.parse(a.created_at));
  const groups = new Map();
  for (const run of sorted) {
    const id = identity(run);
    const key = id.number + ':' + id.sha;
    if (!groups.has(key)) groups.set(key, { ...id, runs: new Map() });
    const group = groups.get(key);
    const workflow = String(run.workflow_id);
    if (!group.runs.has(workflow)) group.runs.set(workflow, run);
  }
  const eligible = [...groups.values()].filter(group =>
    [...group.runs.values()].some(run => run.name === 'Verify Codexia')).slice(0, maxPRs);
  let count = 0;
  const selected = [];
  for (const group of eligible) {
    const remaining = maxRuns - count;
    if (remaining <= 0) break;
    const candidates = [...group.runs.values()];
    const sampleTruncated = candidates.length > remaining;
    const selectedRuns = candidates.slice(0, remaining);
    if (sampleTruncated && !selectedRuns.some(run => run.name === 'Verify Codexia')) {
      selectedRuns[selectedRuns.length - 1] = candidates.find(run => run.name === 'Verify Codexia');
    }
    selected.push({
      number: group.number,
      sha: group.sha,
      runs: selectedRuns,
      sampleTruncated,
    });
    count += selectedRuns.length;
    if (sampleTruncated) break;
  }
  return selected;
}

async function parallel(items, callback) {
  const output = Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      output[current] = await callback(items[current]);
    }
  }));
  return output;
}

export async function collect(request, source) {
  const runs = [];
  let pages = 0;
  let limited = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await request('actions/runs?event=pull_request&per_page=100&page=' + page);
    if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid workflow inventory');
    pages += 1;
    runs.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) break;
    if (page === MAX_PAGES) limited = true;
  }
  const unresolvedRunCount = runs.filter(run => identity(run) === null).length;
  const groups = selectRuns(runs);
  const selected = groups.flatMap(group => group.runs.map(run => ({ run, number: group.number, sha: group.sha })));
  const records = await parallel(selected, async record => {
    const run = record.run;
    if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
      throw new Error('Invalid workflow run identity');
    }
    const jobs = [];
    for (let page = 1; page <= 2; page += 1) {
      const data = await request('actions/runs/' + run.id + '/attempts/' + run.run_attempt +
        '/jobs?per_page=100&page=' + page);
      if (!Array.isArray(data.jobs)) throw new Error('Invalid workflow job inventory');
      jobs.push(...data.jobs);
      if (data.jobs.length < 100) break;
      if (page === 2) throw new Error('Job inventory exceeds supported pagination');
    }
    return { number: record.number, sha: record.sha, observed: observeRun(run, jobs, source) };
  });
  const prs = groups.map(group => summarizePR(group.number, group.sha, records.filter(item =>
    item.number === group.number && item.sha === group.sha).map(item => item.observed), {
    sampleTruncated: group.sampleTruncated,
  }));
  return {
    schema: 'codexia-ci-dashboard/v1',
    observedAt: new Date().toISOString(),
    coverage: {
      scannedRuns: runs.length,
      selectedRuns: selected.length,
      selectedPRs: prs.length,
      scannedPages: pages,
      unresolvedRunCount,
      historyTruncated: limited || groups.length >= MAX_PRS || selected.length >= MAX_RUNS ||
        groups.some(group => group.sampleTruncated),
      note: 'Bounded recent pull_request workflow sample. Runs without one unambiguous PR number and a valid executed head SHA are excluded and counted as unresolved. Other checks and unscanned history may be absent. Not merge certification.',
    },
    prs,
  };
}
