import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('push-host fixture is a manual, isolated Ansible bootstrap proof', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/phase-f-push-host.yml'), 'utf8');
  const helper = await readFile(path.join(root, 'deploy/ansible/test-phase-f-push-host.sh'), 'utf8');
  const hostHelper = await readFile(path.join(root, 'deploy/ansible/test-host-integration.sh'), 'utf8');
  const doc = await readFile(path.join(root, 'docs/deployment/PHASE-F-PUSH-HOST-CI.md'), 'utf8');

  assert.match(workflow, /^on:\n  workflow_dispatch:\n  pull_request:/mu);
  assert.match(workflow, /\.github\/workflows\/phase-f-push-host\.yml/u);
  assert.doesNotMatch(workflow, /^  (?:push|schedule|workflow_run):/mu);
  assert.match(workflow, /runs-on: ubuntu-26\.04/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /(?:contents|actions|packages):\s*write|codexia-production|CODEXIA_.*(?:TOKEN|KEY|SECRET)|standalone-updater/u);
  assert.match(workflow, /test-phase-f-push-host\.sh/u);
  assert.match(workflow, /host-bootstrap-results\.json/u);
  assert.match(helper, /CODEXIA_DISPOSABLE_HOST.*phase-f-push-host/u);
  assert.match(helper, /service_user=codexia/u);
  assert.match(helper, /CODEXIA_HOST_FIXTURE_USER="\$service_user"/u);
  assert.match(helper, /refusing adoption/u);
  assert.match(helper, /loginctl show-user/u);
  assert.match(helper, /podman info --format/u);
  assert.match(helper, /NOT_CHECKED: this runner was not rebooted/u);
  assert.match(helper, /accountCleanup: 'PASS/u);
  assert.match(helper, /sourceSha: process\.env\.GITHUB_SHA/u);
  assert.match(helper, /workflowRunId: process\.env\.GITHUB_RUN_ID/u);
  assert.match(helper, /host stage.*repeat apply reported changed=0/u);
  assert.match(hostHelper, /CODEXIA_HOST_FIXTURE_USER:-codexia-ci-host/u);
  assert.match(hostHelper, /codexia_service_user: \$user/u);
  assert.match(hostHelper, /CODEXIA_HOST_CONVERGENCE/u);
  assert.match(hostHelper, /"\$CODEXIA_HOST_CONVERGENCE" "\$tmp\/inventory\.yml" host/u);
  for (const marker of ['pull requests', 'codexia', 'NOT_CHECKED', 'reboot', 'updater', 'CODEXIA_HOST_CONVERGENCE']) {
    assert.ok(doc.toLowerCase().includes(marker.toLowerCase()), `Missing evidence boundary: ${marker}`);
  }
});
