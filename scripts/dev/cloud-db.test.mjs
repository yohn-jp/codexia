import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('Cloud PostgreSQL receives a readable init script from a private checkout', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codexia-cloud-db-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  const invocation = join(root, 'docker-arguments');
  mkdirSync(checkout, { mode: 0o700 });
  mkdirSync(bin);
  for (const file of ['cloud-db.sh', 'compose.yaml']) {
    copyFileSync(new URL(file, import.meta.url), join(checkout, file));
  }
  const source = readFileSync(new URL('init.sql', import.meta.url));
  const init = join(checkout, 'init.sql');
  writeFileSync(init, source, { mode: 0o600 });
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nprintf "%s\\0" "$@" > "$CODEXIA_TEST_DOCKER_ARGUMENTS"\n', { mode: 0o755 });
  const run = () => execFileSync('bash', [join(checkout, 'cloud-db.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEXIA_CLOUD_STATE_DIR: state, CODEXIA_TEST_DOCKER_ARGUMENTS: invocation },
  });

  run();
  const credentials = readFileSync(join(state, 'runtime.env'));
  run();
  const args = readFileSync(invocation, 'utf8').split('\0');
  const projectDirectory = args.indexOf('--project-directory');
  assert.notEqual(projectDirectory, -1, 'Compose must use the directory containing the readable fixture');
  assert.equal(args[projectDirectory + 1], state);
  const staged = join(state, 'init.sql');
  assert.deepEqual(readFileSync(staged), source);
  assert.equal(statSync(staged).mode & 0o777, 0o444);
  assert.equal(statSync(init).mode & 0o777, 0o600);
  assert.equal(statSync(join(state, 'runtime.env')).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(join(state, 'runtime.env')), credentials);
});
