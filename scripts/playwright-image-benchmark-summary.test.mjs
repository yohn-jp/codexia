import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const summaryScript = fileURLToPath(new URL('../.github/scripts/playwright-image-benchmark-summary.mjs', import.meta.url));
const lanes = [
  ['MCR official / chromium', 'mcr.microsoft.com/playwright'],
  ['MCR official / webkit', 'mcr.microsoft.com/playwright'],
  ['GHCR minimal / chromium', 'ghcr.io/example/repository/playwright-chromium'],
  ['GHCR minimal / webkit', 'ghcr.io/example/repository/playwright-webkit'],
  ['GHCR mirror / chromium', 'ghcr.io/example/repository/playwright-mirror-all'],
  ['GHCR mirror / webkit', 'ghcr.io/example/repository/playwright-mirror-all'],
  ['GHCR Ubuntu / chromium', 'ghcr.io/example/repository/playwright-ubuntu-chromium'],
  ['GHCR Ubuntu / webkit', 'ghcr.io/example/repository/playwright-ubuntu-webkit'],
];

const timestamp = value => '2026-01-01T00:00:' + value + 'Z';
const jobs = lanes.map(([name], index) => ({
  id: index + 1,
  name,
  conclusion: 'success',
  started_at: timestamp('00.000'),
  completed_at: timestamp('17.000'),
  steps: [
    { name: 'Initialize containers', started_at: timestamp('02.000'), completed_at: timestamp('08.000') },
    { name: 'Run real browser acceptance', started_at: timestamp('09.000'), completed_at: timestamp('14.000') },
  ],
}));
const logFor = image => [
  timestamp('02.000') + ' docker pull postgres:17',
  timestamp('02.500') + ' Status: Downloaded newer image for postgres:17',
  timestamp('03.000') + ' docker --config /tmp/fixture pull ' + image,
  timestamp('05.500') + ' Status: Image is up to date for ' + image,
].join('\n');

async function runSummary(t, sourceJobs, { logError = '', unavailableLog = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-playwright-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preload = path.join(root, 'mock-fetch.mjs');
  const summary = path.join(root, 'summary.md');
  await writeFile(summary, 'previous summary\n');
  const logs = Object.fromEntries(lanes.map(([, image], index) => [index + 1, logFor(image)]));
  await writeFile(preload, `
    const jobs = ${JSON.stringify(sourceJobs)};
    const logs = ${JSON.stringify(logs)};
    const logError = ${JSON.stringify(logError)};
    const unavailableLog = ${JSON.stringify(unavailableLog)};
    globalThis.fetch = async (value, options) => {
      const url = new URL(value);
      if (url.origin === 'https://logs.example.test') {
        if (new Headers(options?.headers).has('Authorization')) throw new Error('anonymous log fetch received credentials');
        return new Response(logs[url.pathname.slice(1)]);
      }
      if (url.origin !== 'https://api.example.test' ||
          new Headers(options?.headers).get('Authorization') !== 'Bearer fixture-token') {
        throw new Error('unexpected fixture request');
      }
      if (url.pathname.endsWith('/jobs')) return Response.json({ jobs });
      const id = Number(url.pathname.split('/').at(-2));
      if (logError) throw new Error(logError);
      if (id === unavailableLog) return new Response(null, { status: 503 });
      if (id === 1) return new Response(null, { status: 302, headers: { Location: 'https://logs.example.test/1' } });
      return new Response(logs[id]);
    };
  `);
  const result = spawnSync(process.execPath, ['--import', preload, summaryScript], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      GITHUB_API_URL: 'https://api.example.test',
      GITHUB_REPOSITORY: 'example/repository',
      GITHUB_RUN_ID: '123',
      GH_TOKEN: 'fixture-token',
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  assert.ifError(result.error);
  return { result, report: await readFile(summary, 'utf8') };
}

test('benchmark summary reports observed image pull and job phases for each browser lane', async t => {
  const { result, report } = await runSummary(t, jobs);
  assert.equal(result.status, 0, result.stderr);
  assert.match(report, /^previous summary\n/u);
  const rows = report.split('\n').filter(line => /^\| (?:chromium|webkit) /u.test(line));
  assert.equal(rows.length, 8);
  assert.match(report, /^\| chromium \| MCR official \| 2\.5s \| 6\.0s \| 5\.0s \| 17\.0s \| success \|$/mu);
  assert.match(report, /^\| webkit \| GHCR Ubuntu \| 2\.5s \| 6\.0s \| 5\.0s \| 17\.0s \| success \|$/mu);
});

test('benchmark summary refuses ambiguous duplicate browser lanes', async t => {
  const duplicate = { ...jobs[0], id: 90, conclusion: 'failure' };
  const { result, report } = await runSummary(t, [...jobs, duplicate]);
  assert.notEqual(result.status, 0);
  assert.match(report, /MCR official\/chromium: duplicate jobs/u);
  assert.doesNotMatch(report, /^\| chromium \| MCR official \|.*\| success \|$/mu);
});

test('benchmark summary records fixed diagnostics instead of external error text', async t => {
  const marker = 'private-external-error-text';
  const { result, report } = await runSummary(t, [jobs[0]], { logError: marker });
  const output = result.stdout + result.stderr + report;
  assert.notEqual(result.status, 0, 'the incomplete benchmark still fails');
  assert.match(report, /job-log-request-failed/u);
  assert.equal(output.includes(marker), false);
  assert.match(report, /GHCR minimal\/webkit: job missing/u);
});

test('an unavailable matching image log leaves pull time unknown', async t => {
  const { result, report } = await runSummary(t, jobs, { unavailableLog: 1 });
  assert.notEqual(result.status, 0);
  assert.match(report, /^\| chromium \| MCR official \| unavailable \| 6\.0s \| 5\.0s \| 17\.0s \| success \|$/mu);
  assert.match(report, /MCR official\/chromium: job-log-response-unavailable/u);
});
