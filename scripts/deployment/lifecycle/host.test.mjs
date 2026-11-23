import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('push-host fixture is a manual, isolated Ansible bootstrap proof', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/push-host.yml'), 'utf8');
  const helper = await readFile(path.join(root, 'deploy/ansible/test-push-host.sh'), 'utf8');
  const hostHelper = await readFile(path.join(root, 'deploy/ansible/test-host-integration.sh'), 'utf8');
  const doc = await readFile(path.join(root, 'docs/deployment/PUSH-HOST-CI.md'), 'utf8');

  assert.match(workflow, /^on:\n  workflow_dispatch:\n  pull_request:/mu);
  assert.match(workflow, /\.github\/workflows\/push-host\.yml/u);
  assert.doesNotMatch(workflow, /^  (?:push|schedule|workflow_run):/mu);
  assert.match(workflow, /runs-on: ubuntu-26\.04/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /(?:contents|actions|packages):\s*write|codexia-production|CODEXIA_.*(?:TOKEN|KEY|SECRET)|legacy-updater/u);
  assert.match(workflow, /test-push-host\.sh/u);
  assert.match(workflow, /host-fixture-outcome\.json/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /if-no-files-found: warn/u);
  assert.match(helper, /service_user=codexia/u);
  assert.match(helper, /CODEXIA_HOST_FIXTURE_USER="\$service_user"/u);
  assert.match(helper, /refusing adoption/u);
  assert.match(helper, /loginctl show-user/u);
  assert.match(helper, /NOT_CHECKED: this runner was not rebooted/u);
  assert.match(helper, /accountCleanup: Number\(cleanupStatus\) === 0 \? 'PASS:/u);
  assert.match(helper, /sourceSha: process\.env\.GITHUB_SHA/u);
  assert.match(helper, /workflowRunId: process\.env\.GITHUB_RUN_ID/u);
  assert.match(helper, /host-convergence-bounded\.log/u);
  assert.match(helper, /tail -n 200/u);
  assert.match(helper, /outcome: Number\(exitStatus\) === 0 \? 'PASS' : 'FAIL'/u);
  assert.match(helper, /rootless\(\) \([\s\S]*?cd \/[\s\S]*?\/usr\/bin\/podman "\$@"/u);
  assert.match(helper, /grep -q 'Verified Ubuntu host first\/repeat convergence/u);
  assert.match(hostHelper, /CODEXIA_HOST_FIXTURE_USER:-codexia-ci-host/u);
  assert.match(hostHelper, /codexia_service_user: \$user/u);
  assert.match(hostHelper, /CODEXIA_HOST_CONVERGENCE/u);
  assert.match(hostHelper, /"\$CODEXIA_HOST_CONVERGENCE" "\$tmp\/inventory\.yml" host/u);
  for (const marker of ['pull requests', 'codexia', 'NOT_CHECKED', 'reboot', 'CODEXIA_HOST_CONVERGENCE']) {
    assert.ok(doc.toLowerCase().includes(marker.toLowerCase()), `Missing evidence boundary: ${marker}`);
  }
});

test('push-host refuses an unmarked runner before inspecting or changing the host', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-host-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observed = path.join(directory, 'host-inspected');
  await writeFile(path.join(directory, 'lsb_release'), '#!/bin/bash\n: > "$OBSERVED"\n', { mode: 0o755 });
  const script = path.join(root, 'deploy/ansible/test-push-host.sh');
  for (const env of [
    { GITHUB_ACTIONS: 'true', CODEXIA_DISPOSABLE_HOST: 'other-fixture' },
    { GITHUB_ACTIONS: 'false', CODEXIA_DISPOSABLE_HOST: 'push-host' },
  ]) {
    const result = spawnSync('/bin/bash', [script], {
      encoding: 'utf8',
      env: { PATH: directory, OBSERVED: observed, ...env },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Run only inside the dedicated disposable Push push-host workflow/u);
    await assert.rejects(readFile(observed), { code: 'ENOENT' });
  }
});
