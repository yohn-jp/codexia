import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const summaryScript = fileURLToPath(new URL('../.github/scripts/playwright-image-benchmark-summary.mjs', import.meta.url));

test('benchmark summary records fixed diagnostics instead of external error text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-playwright-summary-'));
  const preload = path.join(root, 'mock-fetch.mjs');
  const summary = path.join(root, 'summary.md');
  const marker = 'private-external-error-text';
  try {
    await writeFile(summary, '');
    await writeFile(preload, `
      globalThis.fetch = async (url) => {
        if (String(url).includes('/jobs?')) {
          return Response.json({ jobs: [{
            id: 1,
            name: 'MCR official / chromium',
            conclusion: 'failure',
            steps: [],
          }] });
        }
        throw new Error(process.env.RAW_ERROR);
      };
    `);
    const result = spawnSync(process.execPath, ['--import', preload, summaryScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'example/repository',
        GITHUB_RUN_ID: '123',
        GH_TOKEN: 'test-token',
        GITHUB_STEP_SUMMARY: summary,
        RAW_ERROR: marker,
      },
    });
    const output = `${result.stdout}\n${result.stderr}\n${await readFile(summary, 'utf8')}`;
    assert.notEqual(result.status, 0, 'the incomplete benchmark still fails');
    assert.match(output, /job-log-request-failed/u);
    assert.equal(output.includes(marker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
