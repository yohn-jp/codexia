import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Phase F VM fixture requires a real guest reboot and durable PostgreSQL evidence', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/phase-f-push-vm-reboot.yml'), 'utf8');
  const fixture = await readFile(path.join(root, 'deploy/ansible/test-phase-f-push-vm-reboot.sh'), 'utf8');
  const doc = await readFile(path.join(root, 'docs/deployment/PHASE-F-PUSH-VM-REBOOT-CI.md'), 'utf8');
  const inventoryBuilder = fixture.match(/python3 - "\$inventory" "\$private_key" "\$known_hosts" <<'PY'\n([\s\S]*?)\nPY/u)?.[1];
  assert.ok(inventoryBuilder, 'Missing guest inventory builder');
  const inventorySyntax = spawnSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<guest-inventory>", "exec")'], {
    input: inventoryBuilder, encoding: 'utf8',
  });
  assert.equal(inventorySyntax.status, 0, inventorySyntax.stderr);

  assert.match(workflow, /^on:\n  workflow_dispatch:\n  pull_request:/mu);
  assert.doesNotMatch(workflow, /^  (?:push|schedule|workflow_run):/mu);
  assert.match(workflow, /runs-on: ubuntu-26\.04/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /(?:contents|actions|packages):\s*write|codexia-production|CODEXIA_.*(?:TOKEN|KEY|SECRET)|tailscale|standalone-updater/u);
  assert.match(workflow, /cloud-image-utils qemu-system-x86 qemu-utils/u);
  assert.match(workflow, /phase-f-push-vm-reboot\.sh/u);
  assert.match(workflow, /deploy\/ansible\/host-contract\.py/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /if-no-files-found: warn/u);

  assert.match(fixture, /-machine type=q35 -accel tcg,thread=multi/u);
  assert.match(fixture, /-cpu max/u);
  assert.match(fixture, /qemuAcceleration: 'tcg-threaded'/u);
  assert.match(fixture, /journalctl --user --boot --no-pager --lines=40 --unit=phase-f-vm-reboot-postgres-volume\.service/u);
  assert.match(fixture, /redacted-digest/u);
  assert.match(fixture, /release-20261108/u);
  assert.match(fixture, /7b90593f5532b49b7e3fe3d2743f0d1f0d822e5b07cebcd8e00c0df8069ecab9/u);
  assert.match(fixture, /Image=docker\.io\/library\/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536/u);
  assert.match(fixture, /CODEXIA_HOST_CONVERGENCE/u);
  assert.match(fixture, /codexia_service_uid.*22001/u);
  assert.match(fixture, /install -d -o codexia -g codexia -m 0700 \/home\/codexia\/\.local\/share/u);
  assert.match(fixture, /install -d -o codexia -g codexia -m 0700 \/home\/codexia\/\.config\n/u);
  assert.match(fixture, /test "\$\(stat -c '%U:%G' \/home\/codexia\/\.config\)" = codexia:codexia/u);
  assert.match(fixture, /pg_control_system\(\)/u);
  assert.match(fixture, /Pre-reboot fixture state \(nonsecret run-local values\)/u);
  assert.match(fixture, /Pre-reboot field presence/u);
  assert.match(fixture, /systemctl reboot/u);
  assert.match(fixture, /random\/boot_id/u);
  assert.match(fixture, /current_boot.*!=.*boot_id_before/u);
  assert.match(fixture, /identity_after.*identity_before/u);
  assert.match(fixture, /volume_after.*volume_before/u);
  assert.match(fixture, /marker.*persisted-before-real-guest-reboot/u);
  assert.match(fixture, /outcome === 'PASS'.*bootBefore === bootAfter/u);
  assert.doesNotMatch(fixture, /CODEXIA_PUSH_DEPLOYMENT_ENABLED|100\.100\.1\.68|codexia-production|api\.github\.com\/repos\/yohn-jp/u);
  for (const marker of ['TCG', 'changed boot ID', 'NOT_CHECKED', 'rollback', 'production acceptance']) {
    assert.ok(doc.toLowerCase().includes(marker.toLowerCase()), `Missing VM reboot evidence boundary: ${marker}`);
  }
});
