import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const recoveryScript = new URL('../../../deploy/ansible/push-deployment-recover.sh', import.meta.url);

function fixture({ phase = 'pending', health = 'healthy' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'codexia-push-recovery-'));
  const stateDir = path.join(root, 'state');
  const quadletDir = path.join(root, 'quadlets');
  const mockBin = path.join(root, 'bin');
  const logFile = path.join(root, 'commands.log');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(quadletDir, 'default.target.wants'), { recursive: true });
  mkdirSync(mockBin);
  const previousImage = `ghcr.io/yohn-jp/codexia-backend@sha256:${'a'.repeat(64)}`;
  const candidateImage = `ghcr.io/yohn-jp/codexia-backend@sha256:${'b'.repeat(64)}`;
  const settingsDirectory = path.join(root, '.config', 'codexia-auth');
  mkdirSync(settingsDirectory, { recursive: true });
  const releaseFixture = (image, publicOrigin) => {
    const settings = `CODEXIA_PUBLIC_ORIGIN=${publicOrigin}\n`;
    const authSettingsSha256 = createHash('sha256').update(settings).digest('hex');
    const settingsFile = path.join(settingsDirectory, `runtime-${authSettingsSha256}.env`);
    writeFileSync(settingsFile, settings, { mode: 0o600 });
    const unit = [
      `Image=${image}`,
      'Environment=CODEXIA_AUTH_MODE=better-auth',
      `Environment=CODEXIA_AUTH_SETTINGS_SHA256=${authSettingsSha256}`,
      `EnvironmentFile=${settingsFile}`,
      '',
    ].join('\n');
    return { unit, settingsFile, record: { format: 'codexia-push-deployment/v1', image, authMode: 'better-auth', authSettingsSha256 } };
  };
  const previous = releaseFixture(previousImage, 'https://codexia.example.test');
  const candidate = releaseFixture(candidateImage, 'https://candidate.example.test');
  writeFileSync(path.join(quadletDir, 'codexia-api.container'), candidate.unit, { mode: 0o600 });
  writeFileSync(path.join(stateDir, 'rollback-api.container'), previous.unit);
  writeFileSync(path.join(stateDir, 'deployed-release.json'), JSON.stringify(candidate.record) + '\n', { mode: 0o600 });
  writeFileSync(path.join(stateDir, 'rollback-release.json'), JSON.stringify(previous.record) + '\n');
  writeFileSync(path.join(stateDir, 'host.lock'), '');
  writeFileSync(path.join(stateDir, 'deploy-transaction.json'), JSON.stringify({
    format: 'codexia-deploy-transaction/v1',
    phase,
    hadUnit: true,
    tunnelWasActive: true,
    apiLinkCreated: false,
    tunnelLinkCreated: false,
    releasePresent: true,
  }));
  writeFileSync(path.join(mockBin, 'systemctl'), `#!/bin/sh
printf "systemctl %s\\n" "$*" >> "$CODEXIA_TEST_LOG"
case "$*" in
  "--user show --property=LoadState --value codexia-api.service")
    [ "${'$'}{CODEXIA_TEST_SHOW_FAIL:-false}" = false ] || exit 1
    printf "%s\\n" "$CODEXIA_TEST_API_LOAD_STATE" ;;
  "--user show --property=LoadState --value codexia-tunnel.service")
    [ "${'$'}{CODEXIA_TEST_SHOW_FAIL:-false}" = false ] || exit 1
    printf "%s\\n" "$CODEXIA_TEST_TUNNEL_LOAD_STATE" ;;
  "--user show --property=SourcePath --value codexia-api.service")
    printf "%s\\n" "$CODEXIA_TEST_API_SOURCE_PATH" ;;
  "--user is-active --quiet codexia-api.service")
    [ "$CODEXIA_TEST_API_ACTIVE" = true ] || exit 3 ;;
  "--user is-active --quiet "*)
    exit 3 ;;
  "--user stop codexia-api.service")
    [ "${'$'}{CODEXIA_TEST_STOP_FAIL:-false}" = false ] || exit 1 ;;
esac
`);
  writeFileSync(path.join(mockBin, 'podman'), `#!/bin/sh
printf "podman %s\\n" "$*" >> "$CODEXIA_TEST_LOG"
case "$*" in
  "container exists codexia-api") [ "$CODEXIA_TEST_API_CONTAINER" = present ] ;;
  *State.Running*ImageName*) printf "%s %s %s\\n" "$CODEXIA_TEST_API_RUNNING" "$CODEXIA_TEST_HEALTH" "$CODEXIA_TEST_RUNNING_IMAGE" ;;
  *State.Running*) printf "%s\\n" "$CODEXIA_TEST_API_RUNNING" ;;
  *ImageName*) printf "%s\\n" "$CODEXIA_TEST_RUNNING_IMAGE" ;;
  *) printf "%s\\n" "$CODEXIA_TEST_HEALTH" ;;
esac
`);
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
    previous,
    candidate,
    env: {
      ...process.env,
      CODEXIA_PUSH_STATE_DIR: stateDir,
      CODEXIA_PUSH_QUADLET_DIR: quadletDir,
      CODEXIA_TEST_LOG: logFile,
      CODEXIA_TEST_HEALTH: health,
      CODEXIA_TEST_RUNNING_IMAGE: phase === 'committed' ? candidateImage : previousImage,
      CODEXIA_TEST_API_SOURCE_PATH: path.join(quadletDir, 'codexia-api.container'),
      CODEXIA_TEST_API_ACTIVE: String(phase === 'committed'),
      CODEXIA_TEST_API_LOAD_STATE: 'loaded',
      CODEXIA_TEST_TUNNEL_LOAD_STATE: 'loaded',
      CODEXIA_TEST_API_CONTAINER: 'present',
      CODEXIA_TEST_API_RUNNING: String(phase === 'committed'),
      CODEXIA_TEST_PREVIOUS_IMAGE: previousImage,
      CODEXIA_TEST_CANDIDATE_IMAGE: candidateImage,
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
    assert.equal(readFileSync(path.join(target.quadletDir, 'codexia-api.container'), 'utf8'), target.previous.unit);
    assert.deepEqual(JSON.parse(readFileSync(path.join(target.stateDir, 'deployed-release.json'), 'utf8')), target.previous.record);
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
    assert.equal(readFileSync(path.join(target.stateDir, 'rollback-api.container'), 'utf8'), target.previous.unit);
    assert.deepEqual(JSON.parse(readFileSync(path.join(target.stateDir, 'deployed-release.json'), 'utf8')), target.candidate.record);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('failed API stop keeps the interrupted transaction and does not claim recovery', () => {
  const target = fixture();
  target.env.CODEXIA_TEST_STOP_FAIL = 'true';
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not stop and verify the active API/u);
    assert.ok(existsSync(path.join(target.stateDir, 'deploy-transaction.json')));
    assert.equal(readFileSync(path.join(target.quadletDir, 'codexia-api.container'), 'utf8').includes(target.env.CODEXIA_TEST_CANDIDATE_IMAGE), true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(target.stateDir, 'deployed-release.json'), 'utf8')), target.candidate.record);
    assert.doesNotMatch(readFileSync(target.logFile, 'utf8'), /start codexia-tunnel\.service/u);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('recovery before first API unit installation does not require a nonexistent service stop', () => {
  const target = fixture();
  const intentPath = path.join(target.stateDir, 'deploy-transaction.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  writeFileSync(intentPath, JSON.stringify({ ...intent, hadUnit: false, tunnelWasActive: false, releasePresent: false }));
  writeFileSync(path.join(target.stateDir, 'deployed-release.json.tmp'), 'partial');
  rmSync(path.join(target.stateDir, 'rollback-api.container'));
  rmSync(path.join(target.stateDir, 'rollback-release.json'));
  target.env.CODEXIA_TEST_API_LOAD_STATE = 'not-found';
  target.env.CODEXIA_TEST_TUNNEL_LOAD_STATE = 'not-found';
  target.env.CODEXIA_TEST_API_CONTAINER = 'absent';
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RECOVERED_PREVIOUS_RELEASE/u);
    assert.equal(existsSync(intentPath), false);
    assert.equal(existsSync(path.join(target.stateDir, 'deployed-release.json.tmp')), false);
    assert.equal(existsSync(path.join(target.quadletDir, 'codexia-api.container')), false);
    assert.doesNotMatch(readFileSync(target.logFile, 'utf8'), /stop codexia-api\.service/u);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('missing API unit with a running container keeps recovery intent and does not remove its Quadlet', () => {
  const target = fixture();
  const intentPath = path.join(target.stateDir, 'deploy-transaction.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  writeFileSync(intentPath, JSON.stringify({ ...intent, hadUnit: false, tunnelWasActive: false, releasePresent: false }));
  rmSync(path.join(target.stateDir, 'rollback-api.container'));
  rmSync(path.join(target.stateDir, 'rollback-release.json'));
  target.env.CODEXIA_TEST_API_LOAD_STATE = 'not-found';
  target.env.CODEXIA_TEST_TUNNEL_LOAD_STATE = 'not-found';
  target.env.CODEXIA_TEST_API_RUNNING = 'true';
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /API container may still be running/u);
    assert.ok(existsSync(intentPath));
    assert.equal(existsSync(path.join(target.quadletDir, 'codexia-api.container')), true);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('systemd load-state lookup failure keeps recovery intent', () => {
  const target = fixture();
  target.env.CODEXIA_TEST_SHOW_FAIL = 'true';
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not stop and verify the application Tunnel/u);
    assert.ok(existsSync(path.join(target.stateDir, 'deploy-transaction.json')));
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('healthy candidate image cannot satisfy prior release recovery', () => {
  const target = fixture();
  target.env.CODEXIA_TEST_RUNNING_IMAGE = target.env.CODEXIA_TEST_CANDIDATE_IMAGE;
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match the recorded prior release/u);
    assert.ok(existsSync(path.join(target.stateDir, 'deploy-transaction.json')));
    assert.deepEqual(JSON.parse(readFileSync(path.join(target.stateDir, 'deployed-release.json'), 'utf8')), target.candidate.record);
    assert.doesNotMatch(readFileSync(target.logFile, 'utf8'), /start codexia-tunnel\.service/u);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('recovery refuses a release record that disagrees with its prior Quadlet', () => {
  const target = fixture();
  writeFileSync(path.join(target.stateDir, 'rollback-release.json'), JSON.stringify(target.candidate.record) + '\n');
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid deployment transaction or prior release snapshot/u);
    assert.ok(existsSync(path.join(target.stateDir, 'deploy-transaction.json')));
    assert.equal(readFileSync(path.join(target.quadletDir, 'codexia-api.container'), 'utf8'), target.candidate.unit);
    assert.equal(existsSync(target.logFile), false, 'recovery must validate snapshots before changing services');
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('older pending token deployment is preserved for recovery with its original release', () => {
  const target = fixture();
  try {
    const priorUnit = path.join(target.stateDir, 'rollback-api.container');
    const priorRelease = path.join(target.stateDir, 'rollback-release.json');
    writeFileSync(priorUnit, [
      `Image=${target.env.CODEXIA_TEST_PREVIOUS_IMAGE}`,
      'Environment=CODEXIA_AUTH_MODE=token',
      'Environment=CODEXIA_AUTH_TOKEN_FILE=/run/secrets/codexia-auth-token',
      '',
    ].join('\n'));
    writeFileSync(priorRelease, JSON.stringify({ image: target.env.CODEXIA_TEST_PREVIOUS_IMAGE, authMode: 'token' }));
    const files = [priorUnit, priorRelease, path.join(target.stateDir, 'host.lock'),
      path.join(target.stateDir, 'deploy-transaction.json'), path.join(target.stateDir, 'deployed-release.json'),
      path.join(target.quadletDir, 'codexia-api.container'), target.candidate.settingsFile, target.previous.settingsFile];
    const before = files.map(file => readFileSync(file));
    const result = runRecovery(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Recover older deployments using their recording release/u);
    assert.deepEqual(files.map(file => readFileSync(file)), before);
    assert.equal(existsSync(target.logFile), false, 'no service or container command may run');
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('recovery rejects changed Better Auth settings before stopping services', () => {
  const target = fixture();
  try {
    writeFileSync(target.previous.settingsFile, 'CODEXIA_PUBLIC_ORIGIN=https://other.example.test\n');
    const result = runRecovery(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid deployment transaction or prior release snapshot/u);
    assert.ok(existsSync(path.join(target.stateDir, 'deploy-transaction.json')));
    assert.equal(existsSync(target.logFile), false);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('recovery rejects a Better Auth release whose settings digest differs from its Quadlet', () => {
  const target = fixture();
  writeFileSync(path.join(target.stateDir, 'rollback-release.json'), JSON.stringify({
    ...target.previous.record,
    authSettingsSha256: target.candidate.record.authSettingsSha256,
  }) + '\n');
  try {
    const result = runRecovery(target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid deployment transaction or prior release snapshot/u);
    assert.ok(existsSync(path.join(target.stateDir, 'deploy-transaction.json')));
    assert.equal(existsSync(target.logFile), false, 'recovery validates auth identity before changing services');
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
    assert.equal(readFileSync(path.join(target.quadletDir, 'codexia-api.container'), 'utf8'), target.candidate.unit);
    assert.deepEqual(JSON.parse(readFileSync(path.join(target.stateDir, 'deployed-release.json'), 'utf8')), target.candidate.record);
    assert.equal(existsSync(path.join(target.stateDir, 'deploy-transaction.json')), false);
    assert.equal(existsSync(path.join(target.stateDir, 'rollback-api.container')), false);
    assert.equal(existsSync(path.join(target.stateDir, 'rollback-release.json')), false);
    assert.doesNotMatch(readFileSync(target.logFile, 'utf8'), /systemctl --user (?:start|stop|reset-failed|daemon-reload)/u);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('committed recovery retains its evidence when the live release cannot be reconciled', async t => {
  const cases = {
    'live image is the prior release': ({ env }) => { env.CODEXIA_TEST_RUNNING_IMAGE = env.CODEXIA_TEST_PREVIOUS_IMAGE; },
    'live image is unhealthy': ({ env }) => { env.CODEXIA_TEST_HEALTH = 'unhealthy'; },
    'API service is inactive': ({ env }) => { env.CODEXIA_TEST_API_ACTIVE = 'false'; },
    'loaded API uses another Quadlet': ({ env, quadletDir }) => { env.CODEXIA_TEST_API_SOURCE_PATH = path.join(quadletDir, 'other.container'); },
    'release record disagrees with the Quadlet': ({ stateDir, previous }) => {
      writeFileSync(path.join(stateDir, 'deployed-release.json'), JSON.stringify(previous.record));
    },
    'runtime settings changed': ({ candidate }) => { writeFileSync(candidate.settingsFile, 'CODEXIA_PUBLIC_ORIGIN=https://other.example.test\n'); },
  };
  for (const [scenario, change] of Object.entries(cases)) {
    await t.test(scenario, () => {
      const target = fixture({ phase: 'committed' });
      try {
        change(target);
        const files = [
          'deploy-transaction.json', 'deployed-release.json', 'rollback-api.container', 'rollback-release.json',
        ].map(name => path.join(target.stateDir, name));
        files.push(path.join(target.quadletDir, 'codexia-api.container'), target.candidate.settingsFile);
        const before = files.map(file => readFileSync(file));
        const result = runRecovery(target);
        assert.equal(result.status, 1, result.stderr);
        assert.doesNotMatch(result.stdout, /CLEANED_COMMITTED_TRANSACTION/u);
        assert.deepEqual(files.map(file => readFileSync(file)), before);
        if (existsSync(target.logFile)) {
          assert.doesNotMatch(readFileSync(target.logFile, 'utf8'), /systemctl --user (?:start|stop|reset-failed|daemon-reload)/u);
        }
      } finally {
        rmSync(target.root, { recursive: true, force: true });
      }
    });
  }
});
