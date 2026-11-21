import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const recoveryScript = new URL('../deploy/ansible/push-deployment-recover.sh', import.meta.url);

function fixture({ phase = 'pending', health = 'healthy' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'codexia-push-recovery-'));
  const stateDir = path.join(root, 'state');
  const quadletDir = path.join(root, 'quadlets');
  const mockBin = path.join(root, 'bin');
  const logFile = path.join(root, 'commands.log');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(quadletDir, 'default.target.wants'), { recursive: true });
  mkdirSync(mockBin);
  writeFileSync(path.join(quadletDir, 'codexia-api.container'), 'candidate unit\n');
  writeFileSync(path.join(stateDir, 'rollback-api.container'), 'previous unit\n');
  writeFileSync(path.join(stateDir, 'deployed-release.json'), '{"image":"candidate"}\n');
  writeFileSync(path.join(stateDir, 'rollback-release.json'), '{"image":"previous"}\n');
  writeFileSync(path.join(stateDir, 'deploy-transaction.json'), JSON.stringify({
    format: 'codexia-deploy-transaction/v1',
    phase,
    hadUnit: true,
    tunnelWasActive: true,
    apiLinkCreated: false,
    tunnelLinkCreated: false,
    releasePresent: true,
  }));
  writeFileSync(path.join(mockBin, 'systemctl'), '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$CODEXIA_TEST_LOG"\nexit 0\n');
  writeFileSync(path.join(mockBin, 'podman'), '#!/bin/sh\nprintf "podman %s\\n" "$*" >> "$CODEXIA_TEST_LOG"\nprintf "%s\\n" "$CODEXIA_TEST_HEALTH"\n');
  writeFileSync(path.join(mockBin, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(mockBin, 'systemctl'), 0o755);
  chmodSync(path.join(mockBin, 'podman'), 0o755);
  chmodSync(path.join(mockBin, 'sleep'), 0o755);
  return {
    root,
    stateDir,
    quadletDir,
    mockBin,
    logFile,
    env: {
      ...process.env,
      CODEXIA_PUSH_STATE_DIR: stateDir,
      CODEXIA_PUSH_QUADLET_DIR: quadletDir,
      CODEXIA_TEST_LOG: logFile,
      CODEXIA_TEST_HEALTH: health,
      PATH: `${mockBin}:${process.env.PATH}`,
    },
  };
}

function runRecovery(target) {
  return spawnSync('bash', [recoveryScript.pathname], { encoding: 'utf8', env: target.env });
}

test('interrupted deployment restores the exact previous unit and release before retry', () => {
  const target = fixture();
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RECOVERED_PREVIOUS_RELEASE/u);
    assert.equal(readFileSync(path.join(target.quadletDir, 'codexia-api.container'), 'utf8'), 'previous unit\n');
    assert.equal(readFileSync(path.join(target.stateDir, 'deployed-release.json'), 'utf8'), '{"image":"previous"}\n');
    assert.equal(existsSync(path.join(target.stateDir, 'deploy-transaction.json')), false, 'pending intent must be removed only after recovery');
    const calls = readFileSync(target.logFile, 'utf8');
    assert.match(calls, /systemctl --user stop codexia-tunnel\.service/u);
    assert.match(calls, /systemctl --user start codexia-api\.service/u);
    assert.match(calls, /systemctl --user start codexia-tunnel\.service/u);
    assert.match(calls, /podman inspect/u);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('unhealthy prior release keeps the durable recovery record for another attempt', () => {
  const target = fixture({ health: 'unhealthy' });
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Prior API did not recover/u);
    assert.ok(readFileSync(path.join(target.stateDir, 'deploy-transaction.json'), 'utf8'));
    assert.equal(readFileSync(path.join(target.stateDir, 'rollback-api.container'), 'utf8'), 'previous unit\n');
    assert.equal(readFileSync(path.join(target.stateDir, 'deployed-release.json'), 'utf8'), '{"image":"candidate"}\n');
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('committed transaction only cleans snapshots and does not switch a healthy release', () => {
  const target = fixture({ phase: 'committed' });
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CLEANED_COMMITTED_TRANSACTION/u);
    assert.equal(readFileSync(path.join(target.quadletDir, 'codexia-api.container'), 'utf8'), 'candidate unit\n');
    assert.equal(readFileSync(path.join(target.stateDir, 'deployed-release.json'), 'utf8'), '{"image":"candidate"}\n');
    assert.equal(existsSync(target.logFile), false, 'a committed intent is cleanup only and must not touch systemd');
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});
