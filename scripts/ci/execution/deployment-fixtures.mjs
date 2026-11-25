import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deploymentFixturesForCheckout } from '../impact/migration-contracts.mjs';

const fixtures = await deploymentFixturesForCheckout();
assert.ok(fixtures.length > 0, 'No deployment fixtures selected');
assert.deepEqual(fixtures, JSON.parse(process.env.CODEXIA_CI_DEPLOYMENT_FIXTURES ?? 'null'),
  'Deployment fixture request does not match the exact-source selection');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, stdio: 'inherit' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}

function rootless(fixture) {
  const temporary = path.join(process.env.RUNNER_TEMP, 'cutover-fixtures', fixture.id);
  const evidence = path.join(temporary, 'codexia-epoch-cutover-evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'outcome.json'), JSON.stringify({
    sourceSha: process.env.CODEXIA_EXPECTED_SHA, runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, status: 'NOT_CHECKED',
  }) + '\n');
  run('bash', ['-n', fixture.fixture]);
  run('bash', [fixture.fixture], { ...process.env, RUNNER_TEMP: temporary,
    EPOCH_FIXTURE_SOURCE_SHA: process.env.CODEXIA_EXPECTED_SHA,
  });
}

const failures = [];
for (const fixture of fixtures) {
  console.log('Verifying deployment fixture ' + fixture.id);
  try {
    if (fixture.kind === 'shared') {
      run(process.execPath, ['--test', 'scripts/deployment/cutover/*.test.mjs',
        'scripts/deployment/preflight/*.test.mjs', 'scripts/release/cutover/*.test.mjs',
        'scripts/deployment/recovery/epoch-cutover.test.mjs']);
      run('bash', ['deploy/ansible/test-cutover-observe.sh']);
      run('python3', ['-B', 'deploy/ansible/test_cutover_host.py']);
      run('python3', ['-B', 'deploy/ansible/test_preflight_observe.py']);
    } else if (fixture.kind === 'node') {
      run(process.execPath, ['--test', fixture.fixture]);
    } else {
      assert.equal(fixture.kind, 'rootless');
      rootless(fixture);
    }
  } catch (error) {
    failures.push(new Error('Deployment fixture failed: ' + fixture.id, { cause: error }));
  }
}
if (failures.length) throw new AggregateError(failures, 'Deployment verification did not pass');
