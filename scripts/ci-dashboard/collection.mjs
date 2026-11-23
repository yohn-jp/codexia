// Public Actions inventory is paged independently from on-demand job observations.
// Never hide revisions merely because a fixed telemetry budget was exhausted.
import { observeRun, summarizePR } from './analysis.mjs';

const PAGE_SIZE = 100;
const MAX_JOB_PAGES = 20;
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

export function selectRuns(runs) {
  const sorted = [...runs].filter(run => identity(run)).sort((a, b) =>
    Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const groups = new Map();
  for (const run of sorted) {
    const id = identity(run);
    const key = id.number + ':' + id.sha;
    if (!groups.has(key)) groups.set(key, { ...id, runs: new Map() });
    const group = groups.get(key);
    const workflow = Number.isSafeInteger(run.workflow_id) && run.workflow_id > 0
      ? String(run.workflow_id) : 'run:' + run.id;
    if (!group.runs.has(workflow)) group.runs.set(workflow, run);
  }
  return [...groups.values()].map(group => ({
    number: group.number, sha: group.sha, runs: [...group.runs.values()],
  }));
}

export async function collectInventoryPage(request, page = 1, createdBefore = null) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10) throw new Error('Invalid inventory page');
  if (createdBefore !== null && (typeof createdBefore !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(createdBefore))) {
    throw new Error('Invalid inventory cursor');
  }
  const cursor = createdBefore === null ? '' : '&created=' + encodeURIComponent('<=' + createdBefore);
  const data = await request('actions/runs?event=pull_request&per_page=' + PAGE_SIZE +
    '&page=' + page + cursor);
  if (!Array.isArray(data.workflow_runs) || data.workflow_runs.length > PAGE_SIZE) {
    throw new Error('Invalid workflow inventory');
  }
  return {
    runs: data.workflow_runs,
    hasMore: data.workflow_runs.length === PAGE_SIZE,
    reportedTotal: Number.isSafeInteger(data.total_count) && data.total_count >= 0
      ? data.total_count : null,
  };
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

export async function collectRevision(request, source, group) {
  if (!group || !Number.isSafeInteger(group.number) || !/^[a-f0-9]{40}$/iu.test(group.sha) ||
    !Array.isArray(group.runs)) throw new Error('Invalid PR revision');
  const observations = await parallel(group.runs, async run => {
    if (!Number.isSafeInteger(run.id) || run.id < 1 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
      throw new Error('Invalid workflow run identity');
    }
    const jobs = [];
    for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
      const data = await request('actions/runs/' + run.id + '/attempts/' + run.run_attempt +
        '/jobs?per_page=' + PAGE_SIZE + '&page=' + page);
      if (!Array.isArray(data.jobs) || data.jobs.length > PAGE_SIZE) {
        throw new Error('Invalid workflow job inventory');
      }
      jobs.push(...data.jobs);
      if (data.jobs.length < PAGE_SIZE) return observeRun(run, jobs, source);
    }
    throw new Error('Job inventory exceeds supported pagination');
  });
  return summarizePR(group.number, group.sha, observations);
}
