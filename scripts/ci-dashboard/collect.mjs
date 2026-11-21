#!/usr/bin/env node
// Build read-only public CI telemetry inside the existing Repository Audit Pages artifact.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeRun, summarizePR } from './analysis.mjs';

const SOURCE = fileURLToPath(new URL('./site/', import.meta.url));
const MAX_PAGES = 4;
const MAX_PRS = 24;
const MAX_RUNS = 90;
const CONCURRENCY = 4;

export function identity(run) {
  const pr = (run.pull_requests ?? []).find(p => Number.isInteger(p.number) &&
    /^[a-f0-9]{40}$/u.test(p.head?.sha ?? ''));
  return pr ? { number: pr.number, sha: pr.head.sha } : null;
}

export function selectRuns(runs, maxPRs = MAX_PRS, maxRuns = MAX_RUNS) {
  const sorted = [...runs].filter(run => identity(run)).sort((a,b) =>
    Date.parse(b.created_at) - Date.parse(a.created_at));
  // Key by PR and exact head SHA; never blend another revision's CI.
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
  return eligible.map(group => ({
    number: group.number, sha: group.sha,
    runs: [...group.runs.values()].filter(() => count++ < maxRuns),
  })).filter(group => group.runs.length);
}

async function parallel(items, callback, count = CONCURRENCY) {
  const output = Array(items.length);
  let index = 0;
  await Promise.all(Array.from({length: Math.min(count, items.length)}, async () => {
    while (index < items.length) {
      const i = index++;
      output[i] = await callback(items[i]);
    }
  }));
  return output;
}

function github(repository, token) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !token) {
    throw new Error('Authenticated GitHub repository access required');
  }
  return async endpoint => {
    const res = await fetch('https://api.github.com/repos/' + repository + '/' + endpoint, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(25000), redirect: 'error',
    });
    if (!res.ok) throw new Error('GitHub Actions metadata unavailable: HTTP ' + res.status);
    return res.json();
  };
}

export async function collect(request, source) {
  const runs = [];
  let pages = 0, limited = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await request('actions/runs?event=pull_request&per_page=100&page=' + page);
    if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid workflow inventory');
    pages++;
    runs.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) break;
    if (page === MAX_PAGES) limited = true;
  }
  const groups = selectRuns(runs);
  const selected = groups.flatMap(group => group.runs.map(run => ({ run, number: group.number, sha: group.sha })));
  const records = await parallel(selected, async record => {
    const run = record.run;
    const jobs = [];
    for (let page = 1; page <= 2; page++) {
      const data = await request('actions/runs/' + run.id + '/attempts/' + run.run_attempt +
        '/jobs?per_page=100&page=' + page);
      if (!Array.isArray(data.jobs)) throw new Error('Invalid workflow job inventory');
      jobs.push(...data.jobs);
      if (data.jobs.length < 100) break;
      if (page === 2) throw new Error('Job inventory exceeds supported pagination');
    }
    return { number: record.number, sha: record.sha, observed: observeRun(run, jobs, source) };
  });
  const prs = groups.map(group =>
    summarizePR(group.number, group.sha, records.filter(item => item.number === group.number &&
      item.sha === group.sha).map(item => item.observed)));
  return {
    schema: 'codexia-ci-dashboard/v1', observedAt: new Date().toISOString(),
    coverage: { scannedRuns: runs.length, selectedRuns: selected.length, selectedPRs: prs.length,
      scannedPages: pages, historyTruncated: limited || groups.length >= MAX_PRS || selected.length >= MAX_RUNS,
      note: 'Bounded recent pull_request workflow sample. Other checks, missing PR associations and unscanned history may be absent. Not merge certification.' },
    prs,
  };
}

async function main() {
  const directory = process.argv[2];
  if (!directory || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== '--preview')) {
    throw new Error('Usage: collect.mjs AUDIT_SITE [--preview]');
  }
  const dest = join(resolve(directory), 'ci');
  await mkdir(dest, { recursive: true });
  await cp(SOURCE, dest, { recursive: true });
  let result;
  if (process.argv[3] === '--preview') {
    result = { schema: 'codexia-ci-dashboard/v1', observedAt: null, coverage: {
      note: 'PR preview. Live CI metadata is collected only for trusted main Pages publishing.' }, prs: [] };
  } else {
    try {
      result = await collect(github(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN),
        await readFile(new URL('../../.github/workflows/verify.yml', import.meta.url), 'utf8'));
    } catch (error) {
      // A transient Actions API error must not erase the independent source audit portal.
      result = { schema: 'codexia-ci-dashboard/v1', observedAt: null,
        error: error instanceof Error ? error.message : 'Metadata unavailable', prs: [] };
      console.error('CI dashboard unavailable: ' + result.error);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_STEP_SUMMARY, 'CI dashboard data unavailable: ' + result.error + '\n');
      }
    }
  }
  await writeFile(join(dest, 'data.json'), JSON.stringify(result) + '\n');
  console.log('CI dashboard: ' + result.prs.length + ' observed PR revision(s)');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
