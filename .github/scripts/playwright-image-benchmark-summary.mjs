import { appendFileSync } from 'node:fs';

const { GITHUB_API_URL = 'https://api.github.com', GITHUB_REPOSITORY, GITHUB_RUN_ID, GH_TOKEN, GITHUB_STEP_SUMMARY } = process.env;
if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GH_TOKEN || !GITHUB_STEP_SUMMARY) {
  throw new Error('Missing GitHub Actions API environment');
}

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

const elapsed = (a, b) => a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null;
const format = (n) => n === null || !Number.isFinite(n) ? 'unavailable' : `${n.toFixed(1)}s`;

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
    throw new Error(`Job ${jobId}: logs unavailable (HTTP ${response.status})`);
  }
  const location = response.headers.get('location');
  if (!location || !location.startsWith('https://')) throw new Error(`Job ${jobId}: invalid log redirect`);
  // Signed log URLs are anonymous; never forward the GitHub API credential.
  const redirected = await fetch(location, { redirect: 'error' });
  if (!redirected.ok) throw new Error(`Job ${jobId}: signed log download HTTP ${redirected.status}`);
  return redirected.text();
}

function pullDuration(log, source) {
  const lines = log.split('\n');
  const needle = source === 'MCR official' ? 'mcr.microsoft.com/playwright' : 'ghcr.io/';
  const start = lines.findIndex(line => line.includes('docker pull ') && line.includes(needle));
  if (start < 0) return null;
  const startTime = lines[start].split(' ')[0];
  const endLine = lines.slice(start + 1).find(line =>
    /Status: (Downloaded newer image|Image is up to date) for /u.test(line) && line.includes(needle));
  if (!endLine) return null;
  return elapsed(startTime, endLine.split(' ')[0]);
}

const selected = (await listRunJobs()).filter(j => /^(MCR official|GHCR minimal) \/ (chromium|webkit)$/u.test(j.name));
const result = [];
for (const job of selected) {
  const [, source, browser] = /^(MCR official|GHCR minimal) \/ (chromium|webkit)$/u.exec(job.name);
  const init = job.steps?.find(s => s.name === 'Initialize containers');
  const test = job.steps?.find(s => s.name === 'Run real browser acceptance');
  let pull = null;
  let error = '';
  try { pull = pullDuration(await jobLog(job.id), source); }
  catch (cause) { error = String(cause.message); }
  result.push({ source, browser, conclusion: job.conclusion, pull, init: elapsed(init?.started_at, init?.completed_at), test: elapsed(test?.started_at, test?.completed_at), total: elapsed(job.started_at, job.completed_at), error });
}

const expected = ['chromium', 'webkit'].flatMap(browser => ['MCR official', 'GHCR minimal'].map(source => ({ browser, source })));
const complete = expected.every(item => result.some(r => r.browser === item.browser && r.source === item.source));
const lines = [
  '### Playwright image A/B (fresh ubuntu-24.04 runners)', '',
  '| Browser | Image | Pull | Initialize containers | Browser test | Job elapsed | Conclusion |',
  '| --- | --- | ---: | ---: | ---: | ---: | --- |',
];
for (const {browser, source} of expected) {
  const r = result.find(row => row.browser === browser && row.source === source);
  lines.push(`| ${browser} | ${source} | ${format(r?.pull ?? null)} | ${format(r?.init ?? null)} | ${format(r?.test ?? null)} | ${format(r?.total ?? null)} | ${r?.conclusion ?? 'missing'} |`);
}
lines.push('', 'Pull is measured from the Docker pull command to its completion in the job log; initialization and job elapsed come from the Actions jobs API. Execute multiple manual runs before judging runner variance.');
for (const r of result.filter(row => row.error)) lines.push(`- ${r.source}/${r.browser}: ${r.error}`);
appendFileSync(GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');

if (!complete || result.some(r => r.conclusion !== 'success' || r.pull === null || r.init === null || r.total === null)) {
  throw new Error('Benchmark incomplete: missing job, failing acceptance, or unavailable Pull/initialization evidence');
}
