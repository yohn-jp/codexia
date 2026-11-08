import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
test('installed workspaces contain only PostgreSQL contracts, store, API and application', () => {
  const workspaces = JSON.parse(execFileSync('pnpm', ['--recursive', 'list', '--depth', '-1', '--json'], {encoding:'utf8'}));
  assert.deepEqual(workspaces.map(item => item.name).sort(), ['@codexia/api', '@codexia/app', '@codexia/persistence-contracts', '@codexia/persistence-postgres', 'codexia'].sort());
});
test('retired Git packages, browser authoring, public reader and Hosted build machinery are absent', async () => {
  for (const file of ['modules', 'packages/core', 'packages/contracts', 'packages/module-runtime', 'packages/migration', 'profiles', 'buildkit', 'app/src/application', 'app/src/contributions', 'scripts/hosted-build.mjs']) {
    await assert.rejects(access(file));
  }
  const api = await readFile('packages/api/src/server.ts', 'utf8');
  assert.doesNotMatch(api, /CoreStore|ModuleRuntime|@codexia\/core|createHostedGitCredentialProvider/);
});
