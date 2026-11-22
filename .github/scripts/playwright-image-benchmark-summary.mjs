import { constants, fstatSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const { GITHUB_API_URL = 'https://api.github.com', GITHUB_REPOSITORY, GITHUB_RUN_ID, GH_TOKEN, GITHUB_STEP_SUMMARY } = process.env;
if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GH_TOKEN || !GITHUB_STEP_SUMMARY) {
  throw new Error('Missing GitHub Actions API environment');
}
if (!isAbsolute(GITHUB_STEP_SUMMARY)) throw new Error('GITHUB_STEP_SUMMARY must be an absolute runner-provided path');

const auth = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
const request = async (url) => {
  const response = await fetch(url, { headers: auth, redirect: 'manual' });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${new URL(url).pathname}`);
  return response;
};

const elapsed = (a, b) => {
  const seconds = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};
const format = (n) => n === null ? 'unavailable' : `${n.toFixed(1)}s`;
const logDiagnostic = (error) => {
  if (error?.code === 'BENCHMARK_LOG_HTTP') return 'job-log-response-unavailable';
  if (error?.code === 'BENCHMARK_LOG_REDIRECT') return 'job-log-redirect-invalid';
  if (error?.code === 'BENCHMARK_SIGNED_LOG_HTTP') return 'signed-log-response-unavailable';
  return 'job-log-request-failed';
};
const logFailure = (code) => Object.assign(new Error(), { code });

async function listRunJobs() {
  const jobs = [];
  for (let page = 1; ; page++) {
    const url = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?per_page=100&page=${page}`;
    const payload = await (await request(url)).json();
    jobs.push(...payload.jobs);
    if (payload.jobs.length < 100) return jobs;
  }
}

async function jobLog(jobId) {
  const url = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/jobs/${jobId}/logs`;
  const response = await fetch(url, { headers: auth, redirect: 'manual' });
  if (response.status === 200) return response.text();
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    throw logFailure('BENCHMARK_LOG_HTTP');
  }
  const location = response.headers.get('location');
  if (!location || !location.startsWith('https://')) throw logFailure('BENCHMARK_LOG_REDIRECT');
  // Signed log URLs are anonymous; never forward the GitHub API credential.
  const redirected = await fetch(location, { redirect: 'error' });
  if (!redirected.ok) throw logFailure('BENCHMARK_SIGNED_LOG_HTTP');
  return redirected.text();
}

function pullDuration(log, source, browser) {
  const suffix = source === 'GHCR mirror' ? 'mirror-all' : source === 'GHCR Ubuntu' ? `ubuntu-${browser}` : browser;
  const repository = source === 'MCR official' ? 'mcr.microsoft.com/playwright' : `ghcr.io/${GITHUB_REPOSITORY.toLowerCase()}/playwright-${suffix}`;
  let startTime;
  let image;
  for (const line of log.split('\n')) {
    const command = /\bdocker(?: --config .+?)? pull (\S+)\s*$/u.exec(line);
    if (command && command[1].split('@')[0] === repository) {
      [, image] = command;
      [startTime] = line.split(' ');
    }
    const status = /Status: (?:Downloaded newer image|Image is up to date) for (\S+)\s*$/u.exec(line);
    if (image && status?.[1] === image) return elapsed(startTime, line.split(' ')[0]);
  }
  return null;
}

const selected = (await listRunJobs()).filter(j => /^(MCR official|GHCR minimal|GHCR mirror|GHCR Ubuntu) \/ (chromium|webkit)$/u.test(j.name));
const result = [];
for (const job of selected) {
  const [, source, browser] = /^(MCR official|GHCR minimal|GHCR mirror|GHCR Ubuntu) \/ (chromium|webkit)$/u.exec(job.name);
  const init = job.steps?.find(s => s.name === 'Initialize containers');
  const test = job.steps?.find(s => s.name === 'Run real browser acceptance');
  let pull = null;
  let error = '';
  try { pull = pullDuration(await jobLog(job.id), source, browser); }
  catch (cause) { error = logDiagnostic(cause); }
  const conclusion = ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale'].includes(job.conclusion)
    ? job.conclusion : 'unknown';
  result.push({ source, browser, conclusion, pull, init: elapsed(init?.started_at, init?.completed_at), test: elapsed(test?.started_at, test?.completed_at), total: elapsed(job.started_at, job.completed_at), error });
}

const expected = ['chromium', 'webkit'].flatMap(browser => ['MCR official', 'GHCR mirror', 'GHCR minimal', 'GHCR Ubuntu'].map(source => ({ browser, source })));
const lines = [
  '### Playwright image A/B (fresh ubuntu-24.04 runners)', '',
  '| Browser | Image | Pull | Initialize containers | Browser test | Job elapsed | Conclusion |',
  '| --- | --- | ---: | ---: | ---: | ---: | --- |',
];
const problems = [];
for (const {browser, source} of expected) {
  const matches = result.filter(row => row.browser === browser && row.source === source);
  const r = matches.length === 1 ? matches[0] : null;
  const conclusion = r?.conclusion ?? (matches.length > 1 ? 'ambiguous' : 'missing');
  lines.push(`| ${browser} | ${source} | ${format(r?.pull ?? null)} | ${format(r?.init ?? null)} | ${format(r?.test ?? null)} | ${format(r?.total ?? null)} | ${conclusion} |`);
  if (!r) {
    problems.push(`${source}/${browser}: ${matches.length > 1 ? 'duplicate jobs' : 'job missing'}`);
    continue;
  }
  const missing = [['Pull', r.pull], ['Initialize containers', r.init], ['Browser test', r.test], ['Job elapsed', r.total]]
    .filter(([, value]) => value === null).map(([name]) => name);
  if (missing.length) problems.push(`${source}/${browser}: unavailable ${missing.join(', ')}`);
  if (r.conclusion !== 'success') problems.push(`${source}/${browser}: job ${r.conclusion}`);
  if (r.error) problems.push(`${source}/${browser}: ${r.error}`);
}
lines.push('', 'Pull is measured from the Docker pull command to its completion in the job log; initialization and job elapsed come from the Actions jobs API. Execute multiple manual runs before judging runner variance.');
for (const problem of problems) lines.push(`- ${problem.replace(/[|\r\n]/gu, ' ')}`);
const summary = lines.join('\n') + '\n';
const summaryFd = openSync(GITHUB_STEP_SUMMARY,
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0), 0o600);
try {
  if (!fstatSync(summaryFd).isFile()) throw new Error('GITHUB_STEP_SUMMARY must reference an open regular runner summary file');
  writeFileSync(summaryFd, summary);
} finally { closeSync(summaryFd); }

if (problems.length) throw new Error(`Benchmark incomplete: ${problems.join('; ')}`);
