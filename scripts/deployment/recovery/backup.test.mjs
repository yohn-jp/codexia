import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const backupProgram = path.join(root, 'deploy/backup/backup.sh');
const backupRunner = path.join(root, 'deploy/backup/backup-runner.sh');
const backupControl = path.join(root, 'deploy/backup/backup-control.sh');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-push-backup-'));
  const home = path.join(directory, 'home');
  const stateDir = path.join(home, '.local/state/codexia-deploy');
  const backupDestination = path.join(directory, 'backup');
  const bin = path.join(directory, 'bin');
  await Promise.all([mkdir(stateDir, { recursive: true, mode: 0o700 }), mkdir(backupDestination), mkdir(bin)]);
  const lockFile = path.join(stateDir, 'host.lock');
  await writeFile(lockFile, '');
  const commands = {
    age: '#!/bin/sh\nexit 0\n',
    findmnt: '#!/bin/sh\nfor format do :; done\ncase "$format" in ID) printf 123;; FSTYPE) printf nfs;; SOURCE) printf 192.0.2.55:/backup;; *) exit 2;; esac\n',
    getent: '#!/bin/sh\nprintf "192.0.2.55 STREAM backup.example 192.0.2.55\\n"\n',
    ip: '#!/bin/sh\nprintf "2: lo inet 127.0.0.1/8 scope host lo\\n"\n',
    podman: '#!/bin/sh\nexit 1\n',
    systemctl: '#!/usr/bin/env bash\ncase "$*" in\n  *codexia-api.service*) unit=codexia-api.service;;\n  *codexia-tunnel.service*) unit=codexia-tunnel.service;;\n  *) exit 4;;\nesac\ncase ",${CODEXIA_TEST_ACTIVE_UNITS:-}," in *",$unit,"*) exit 0;; esac\nexit 3\n',
  };
  for (const [name, contents] of Object.entries(commands)) {
    const commandPath = path.join(bin, name);
    await writeFile(commandPath, contents);
    await chmod(commandPath, 0o700);
  }
  return { directory, home, stateDir, backupDestination, bin, lockFile };
}

function invokeBackup(fixture, { activeUnits = '', approved = true, lockFile = fixture.lockFile } = {}) {
  const args = [
    backupProgram,
    'backup-locked',
    fixture.backupDestination,
    'age1pushfixture',
    ...(approved ? ['--approved', '--lock-file', lockFile, '--lock-fd', '9'] : []),
  ].map(shellQuote).join(' ');
  const command = `exec 9>${shellQuote(lockFile)}; flock --exclusive --nonblock 9; exec ${args} 9>&9`;
  return spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.home,
      XDG_STATE_HOME: path.join(fixture.home, '.local/state'),
      PATH: `${fixture.bin}:${process.env.PATH}`,
      CODEXIA_TEST_ACTIVE_UNITS: activeUnits,
    },
  });
}

test('restored target fingerprints are read-only and require quiescence under the inherited lock', async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await writeFile(path.join(fixture.bin, 'podman'), [
    '#!/bin/sh',
    'case "$*" in',
    '  "volume exists codexia-history") exit 0;;',
    '  "container exists codexia-api") exit 1;;',
    '  exec*) cat >/dev/null; printf "restored database\\n";;',
    '  run*) printf "restored history\\n";;',
    '  *) exit 2;;',
    'esac',
  ].join('\n') + '\n');
  const command = [backupProgram, 'fingerprint-restored-target', '--lock-file', fixture.lockFile,
    '--lock-fd', '9'].map(shellQuote).join(' ');
  const lock = 'exec 9>' + shellQuote(fixture.lockFile) + '; flock -nx 9 && ';
  const invoke = (line, activeUnits = '') => spawnSync('bash', ['-c', line], {
    encoding: 'utf8', env: { ...process.env, CODEXIA_PUSH_STATE_DIR: fixture.stateDir,
      PATH: fixture.bin + ':' + process.env.PATH, CODEXIA_TEST_ACTIVE_UNITS: activeUnits },
  });
  assert.match(invoke(command).stderr, /lock descriptor was not inherited/u);
  for (const service of ['codexia-api.service', 'codexia-tunnel.service']) {
    const blocked = invoke(lock + command, service);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /inactive systemd unit/u);
  }
  const verified = invoke(lock + command);
  assert.equal(verified.status, 0, verified.stderr);
  const sha = content => createHash('sha256').update(content + '\n').digest('hex');
  assert.deepEqual(JSON.parse(verified.stdout), {
    databaseFingerprint: sha('restored database'), historyFingerprint: sha('restored history'),
  });
  assert.deepEqual(await readdir(fixture.backupDestination), []);
});

test('update backup uses the private executor settings and inherited deployment lock', async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const config = path.join(fixture.home, '.config', 'codexia-backup');
  const localBin = path.join(fixture.home, '.local/bin');
  const release = path.join(fixture.home, '.local/share/codexia-backup/current');
  const entrypoint = path.join(release, 'app/node_modules/@codexia/api/dist/backup-console-control.js');
  const settings = path.join(config, 'executor.env');
  const runId = '1485f702-eb68-4854-979d-fad9fd12d90d';
  const digest = 'a'.repeat(64);
  await mkdir(config, { recursive: true, mode: 0o700 });
  await mkdir(localBin, { recursive: true });
  await symlink(backupRunner, path.join(localBin, 'codexia-backup-runner'));
  const nodeBin = path.join(fixture.home, '.local/share/codexia-backup/current/bin');
  await mkdir(nodeBin, { recursive: true });
  await symlink(process.execPath, path.join(nodeBin, 'node'));
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, 'throw new Error("Unexpected control command");\n');
  await writeFile(settings, [
    'CODEXIA_BACKUP_DESTINATION=' + fixture.backupDestination,
    'CODEXIA_BACKUP_AGE_RECIPIENT=age1private',
  ].join('\n') + '\n', { mode: 0o600 });
  await writeFile(path.join(localBin, 'codexia-backup'), [
    '#!/bin/bash',
    'set -eu',
    'case "$1" in',
    '  validate-destination) [[ "$2" == ' + shellQuote(fixture.backupDestination) + ' ]];;',
    '  backup-locked)',
    '    [[ "$2" == ' + shellQuote(fixture.backupDestination) + ' && "$3" == age1private ]]',
    '    [[ "$4 $5 $6 $7 $8" == ' + shellQuote('--approved --lock-file ' + fixture.lockFile + ' --lock-fd 9') + ' ]]',
    '    test -e /proc/self/fd/9 || exit 1',
    '    flock --exclusive --nonblock 9',
    '    [[ "${10}" == *-' + runId + ' ]]',
    '    printf "Encrypted backup committed: %s/%s\nPublished checksum manifest sha256: %s\n" "$2" "${10}" ' + digest,
    '    ;;',
    '  validate-artifact) printf "%s\n" ' + digest + ';;',
    '  *) exit 2;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o700 });
  const env = {
    ...process.env, HOME: fixture.home, PATH: fixture.bin + ':' + process.env.PATH,
    CODEXIA_BACKUP_DESTINATION: '/untrusted', CODEXIA_BACKUP_AGE_RECIPIENT: 'age1untrusted',
  };
  const invoke = command => spawnSync('bash', ['-c', command], { encoding: 'utf8', env });
  const launcher = shellQuote(backupControl);
  const validate = invoke(launcher + ' deploy-check');
  assert.equal(validate.status, 0, validate.stderr);
  assert.notEqual(invoke(launcher + ' deploy-backup ' + runId).status, 0);
  const locked = invoke('exec 9>' + shellQuote(fixture.lockFile) + '; flock -nx 9 && ' + launcher + ' deploy-backup ' + runId);
  assert.equal(locked.status, 0, locked.stderr);
  const [artifact, manifest, end] = locked.stdout.split('\n');
  assert.equal(path.dirname(artifact), fixture.backupDestination);
  assert.match(path.basename(artifact), new RegExp('^codexia-[0-9]{8}T[0-9]{6}Z-' + runId + '$', 'u'));
  assert.equal(manifest, digest);
  assert.equal(end, '');
  await chmod(settings, 0o644);
  assert.notEqual(invoke(launcher + ' deploy-check').status, 0);
});

test('the protected run shares the deploy lock and recovers both services after SIGKILL', async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const run = '1485f702-eb68-4854-979d-fad9fd12d90d';
  const publishedRun = '1485f702-eb68-4854-979d-fad9fd12d90e';
  const transferRun = '1485f702-eb68-4854-979d-fad9fd12d90f';
  const source = 'a'.repeat(40);
  const digest = 'sha256:' + 'b'.repeat(64);
  const manifest = 'c'.repeat(64);
  const trace = path.join(fixture.directory, 'trace');
  const localBin = path.join(fixture.home, '.local/bin');
  const launcher = path.join(fixture.bin, 'run-backup-fixture');
  await mkdir(localBin, { recursive: true });
  await writeFile(path.join(fixture.stateDir, 'deployed-release.json'), JSON.stringify({
    image: 'ghcr.io/yohn-jp/codexia-backend@' + digest,
    identity: { format: 'codexia-backend-identity/v1', profile: 'full', sourceSha: source },
  }), { mode: 0o600 });
  await Promise.all(['trace', 'api', 'tunnel'].map(name => writeFile(path.join(fixture.directory, name), '')));
  const scripts = {
    [launcher]: [
      'if [[ "$1" == lock ]]; then exec 8>>"$CODEXIA_PUSH_STATE_DIR/host.lock"; /usr/bin/flock -n 8 || exit; fi',
      'shift',
      'export RUNNER_PID=$$',
      'exec /bin/bash "$@"',
    ],
    [path.join(fixture.bin, 'systemctl')]: [
      'for unit; do :; done',
      'case "$unit" in codexia-api.service) state="$FIXTURE/api";; codexia-tunnel.service) state="$FIXTURE/tunnel";; *) exit 4;; esac',
      'case "$2" in is-active) [[ -f "$state" ]] || exit 3;; start) touch "$state";; stop) rm -f "$state";; reset-failed) :;; *) exit 4;; esac',
    ],
    [path.join(fixture.bin, 'podman')]: [
      'case "$*" in',
      '*update-identity.json) echo \'{"format":"codexia-backend-identity/v1","profile":"full","sourceSha":"' + source + '"}\';;',
      '*{{.Id}}*|*{{.Image}}*) echo ' + digest + ';;',
      '*Health.Status*) [[ -f "$FIXTURE/api" ]] && echo healthy;;',
      '*) exit 4;; esac',
    ],
    [path.join(localBin, 'codexia-backup')]: [
      'case "$1" in validate-destination) exit 0;; validate-artifact) echo ' + manifest + '; exit 0;; backup-locked) :;; *) exit 2;; esac',
      '[[ ! -e "$FIXTURE/api" && ! -e "$FIXTURE/tunnel" ]] || exit 2',
      'echo backup >> "$FIXTURE/trace"',
      'if [[ "$KILL_RUNNER" == 1 ]]; then kill -KILL "$RUNNER_PID"; exit 137; fi',
      'for artifact_id; do :; done',
      'archive="$2/$artifact_id"',
      'mkdir -p "$archive"',
      'if [[ "$KILL_PUBLISHED" == 1 ]]; then kill -KILL "$RUNNER_PID"; exit 137; fi',
      'printf "Encrypted backup committed: %s\\nPublished checksum manifest sha256: %s\\n" "$archive" ' + manifest,
    ],
    [path.join(localBin, 'codexia-backup-control')]: [
      'echo "$*" >> "$FIXTURE/trace"',
      'if [[ "$1" == manual-finish ]]; then',
      '  [[ -f "$FIXTURE/api" && -f "$FIXTURE/tunnel" ]] || exit 2',
      '  if [[ "$KILL_UPLOAD" == 1 ]]; then kill -KILL "$RUNNER_PID"; fi',
      'fi',
    ],
  };
  for (const [file, lines] of Object.entries(scripts)) {
    await writeFile(file, '#!/bin/bash\n' + lines.join('\n') + '\n');
    await chmod(file, 0o700);
  }
  const env = {
    HOME: fixture.home,
    CODEXIA_PUSH_STATE_DIR: fixture.stateDir,
    CODEXIA_BACKUP_DESTINATION: fixture.backupDestination,
    CODEXIA_BACKUP_AGE_RECIPIENT: 'age1test',
    FIXTURE: fixture.directory,
    PATH: `${fixture.bin}:/usr/bin:/bin`,
  };
  const invoke = (mode, ...args) => spawnSync('/bin/bash', [launcher, mode, backupRunner, ...args], {
    encoding: 'utf8',
    env: {
      ...env,
      KILL_RUNNER: mode === 'before-publication' ? '1' : '0',
      KILL_PUBLISHED: mode === 'after-publication' ? '1' : '0',
      KILL_UPLOAD: mode === 'during-upload' ? '1' : '0',
    },
    timeout: 10_000,
  });
  const contention = invoke('lock', run);
  assert.equal(contention.status, 75, contention.stderr);
  assert.equal(await readFile(trace, 'utf8'), '');

  const killed = invoke('before-publication', run);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n'), ['manual-start ' + run + ' ' + source + ' ' + digest, 'backup']);
  const recovered = invoke('recover', 'recover');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(await readFile(trace, 'utf8'), new RegExp('manual-interrupted ' + run));
  await Promise.all(['api', 'tunnel'].map(name => readFile(path.join(fixture.directory, name))));

  const publicationKilled = invoke('after-publication', publishedRun);
  assert.equal(publicationKilled.signal, 'SIGKILL', publicationKilled.stderr);
  const publicationRecovered = invoke('recover', 'recover');
  assert.equal(publicationRecovered.status, 0, publicationRecovered.stderr);
  assert.match(await readFile(trace, 'utf8'), new RegExp('manual-finish ' + publishedRun + ' .+ ' + manifest));

  const transferKilled = invoke('during-upload', transferRun);
  assert.equal(transferKilled.signal, 'SIGKILL', transferKilled.stderr);
  const completed = invoke('recover', 'recover');
  assert.equal(completed.status, 0, completed.stderr);
  const transfers = (await readFile(trace, 'utf8')).split('\n').filter(line => line.startsWith('manual-finish ' + transferRun));
  assert.equal(transfers.length, 2, 'recovery must retry the same run after local publication');
  assert.equal(transfers[0], transfers[1], 'the run UUID, artifact path and manifest digest remain fixed');
});

async function installFingerprintBackupCommands(fixture, { database, history }) {
  const dbCalls = path.join(fixture.directory, 'database-fingerprint-calls');
  const historyCalls = path.join(fixture.directory, 'history-fingerprint-calls');
  await writeFile(path.join(fixture.bin, 'podman'), String.raw`#!/usr/bin/env bash
set -u
next_count() {
  local file="$1" count=0
  if [[ -f "$file" ]]; then read -r count < "$file"; fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$file"
  printf '%s' "$count"
}
case "$1" in
  volume)
    case "$2" in
      exists) exit 0;;
      export) printf 'history archive';;
      *) exit 1;;
    esac
    ;;
  container) exit 1;;
  exec)
    if [[ "$*" == *"exec psql"* ]]; then
      count="$(next_count ${shellQuote(dbCalls)})"
      case ${shellQuote(database)} in
        empty) :;;
        nonempty) printf 'database';;
        mismatch) if (( count == 1 )); then printf 'database'; else printf 'changed database'; fi;;
        fail-second) if (( count == 2 )); then exit 125; fi;;
        *) exit 2;;
      esac
    else
      printf 'database dump'
    fi
    ;;
  run)
    count="$(next_count ${shellQuote(historyCalls)})"
    case ${shellQuote(history)} in
      empty) :;;
      nonempty) printf 'file\n';;
      mismatch) if (( count == 1 )); then printf 'file\n'; else printf 'changed-file\n'; fi;;
      fail-second) if (( count == 2 )); then exit 125; fi;;
      *) exit 2;;
    esac
    ;;
  *) exit 1;;
esac
`);
  await writeFile(path.join(fixture.bin, 'age'), String.raw`#!/usr/bin/env bash
set -euo pipefail
output=
while (($#)); do
  if [[ "$1" == -o ]]; then output="$2"; shift 2; else shift; fi
done
[[ -n "$output" ]]
cat > "$output"
`);
  await chmod(path.join(fixture.bin, 'podman'), 0o700);
  await chmod(path.join(fixture.bin, 'age'), 0o700);
}

function invokeValidation(fixture, operation, artifactPath) {
  return spawnSync('bash', [backupProgram, operation, artifactPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.home,
      XDG_STATE_HOME: path.join(fixture.home, '.local/state'),
      PATH: `${fixture.bin}:${process.env.PATH}`,
    },
  });
}

test('S3 transfer checks canonical checksums, direct HTTPS, and exact-version retention', () => {
  const result = spawnSync('python3', [
    '-B', '-m', 'unittest', 'deploy.backup.test_s3_admission', 'deploy.backup.test_s3_retention', '-v',
  ], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('encrypted backup verification accepts read-only artifacts without weakening destination writes', async () => {
  const fixture = await createFixture();
  const archive = path.join(fixture.backupDestination, 'read-only-archive');
  await mkdir(archive);
  try {
    const items = [
      ['database.dump.age', 'ciphertext-database'],
      ['history.tar.age', 'ciphertext-history'],
      ['manifest.age', 'ciphertext-manifest'],
    ];
    for (const [name, contents] of items) await writeFile(path.join(archive, name), contents);
    await writeFile(path.join(archive, 'SHA256SUMS'), items.map(([name, contents]) =>
      `${createHash('sha256').update(contents).digest('hex')}  ${name}\n`).join(''));
    await chmod(archive, 0o500);
    const verified = invokeValidation(fixture, 'validate-artifact', archive);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /^[a-f0-9]{64}\n$/u);
    const independent = () => spawnSync('bash', [
      backupProgram, 'validate-independent-artifact', fixture.backupDestination, archive,
    ], { encoding: 'utf8', env: { ...process.env, PATH: fixture.bin + ':' + process.env.PATH } });
    const onRemoteMount = independent();
    assert.equal(onRemoteMount.status, 0, onRemoteMount.stderr);
    assert.equal(onRemoteMount.stdout, verified.stdout);
    await writeFile(path.join(fixture.bin, 'findmnt'), '#!/bin/sh\nfor format do :; done\ncase "$format" in ID) printf 123;; FSTYPE) printf ext4;; *) exit 2;; esac\n');
    assert.notEqual(independent().status, 0, 'a local filesystem cannot satisfy secondary preservation');
    if (process.getuid?.() !== 0) {
      const unwritable = invokeValidation(fixture, 'validate-destination', archive);
      assert.notEqual(unwritable.status, 0, 'Creating a backup still requires a writable destination');
      assert.match(unwritable.stderr, /not writable/u);
    }
  } finally {
    await chmod(archive, 0o700);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('push backup requires a quiesced API and Tunnel', async () => {
  const fixture = await createFixture();
  try {
    const inactive = invokeBackup(fixture);
    assert.notEqual(inactive.status, 0);
    assert.match(inactive.stderr, /History volume absent/u,
      'the push-specific quiescence checks must pass before the disposable fixture reaches the missing-volume stop');

    for (const unit of [
      'codexia-api.service',
      'codexia-tunnel.service',
    ]) {
      const active = invokeBackup(fixture, { activeUnits: unit });
      assert.notEqual(active.status, 0);
      assert.ok(active.stderr.includes(`Push deployment requires inactive systemd unit: ${unit}`),
        `expected active ${unit} to reject backup; received: ${active.stderr}`);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('backup publication accepts successful empty and non-empty history fingerprints', async () => {
  for (const historyMode of ['empty', 'nonempty']) {
    const fixture = await createFixture();
    try {
      await installFingerprintBackupCommands(fixture, { database: 'nonempty', history: historyMode });
      const result = invokeBackup(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Encrypted backup committed:/u);
      const artifacts = await readdir(fixture.backupDestination);
      assert.equal(artifacts.length, 1);
      assert.match(artifacts[0], /^codexia-/u);
      assert.deepEqual((await readdir(path.join(fixture.backupDestination, artifacts[0]))).sort(), [
        'SHA256SUMS', 'database.dump.age', 'history.tar.age', 'manifest.age',
      ]);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('backup publication rejects database and history fingerprint mismatches', async () => {
  for (const scenario of [
    { database: 'mismatch', history: 'empty', error: /Database changed during backup/u },
    { database: 'empty', history: 'mismatch', error: /History changed during backup/u },
  ]) {
    const fixture = await createFixture();
    try {
      await installFingerprintBackupCommands(fixture, { database: scenario.database, history: scenario.history });
      const result = invokeBackup(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, scenario.error);
      assert.doesNotMatch(result.stdout, /Encrypted backup committed:/u);
      assert.deepEqual(await readdir(fixture.backupDestination), []);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('backup publication rejects exit-125 fingerprint rereads with no output', async () => {
  const results = [];
  const fixtures = [];
  try {
    for (const scenario of [
      { database: 'fail-second', history: 'empty', error: /database fingerprint/u },
      { database: 'empty', history: 'fail-second', error: /history fingerprint/u },
    ]) {
      const fixture = await createFixture();
      fixtures.push(fixture);
      await installFingerprintBackupCommands(fixture, { database: scenario.database, history: scenario.history });
      const result = invokeBackup(fixture);
      results.push({ result, fixture, expectedError: scenario.error });
    }
    assert.deepEqual(results.map(({ result }) => result.status), [1, 1]);
    for (const { result, fixture, expectedError } of results) {
      assert.match(result.stderr, expectedError);
      assert.doesNotMatch(result.stdout, /Encrypted backup committed:|Published checksum manifest sha256:/u);
      assert.deepEqual(await readdir(fixture.backupDestination), []);
    }
  } finally {
    await Promise.all(fixtures.map(fixture => rm(fixture.directory, { recursive: true, force: true })));
  }
});

test('backup rejects calls without explicit host-lock approval', async () => {
  const fixture = await createFixture();
  try {
    const rejected = invokeBackup(fixture, { approved: false });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /explicit approval/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('push backup rejects a locked file other than the canonical host lock', async () => {
  const fixture = await createFixture();
  const alternateLock = path.join(fixture.directory, 'alternate.lock');
  try {
    await writeFile(alternateLock, '');
    const rejected = invokeBackup(fixture, { lockFile: alternateLock });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /canonical host lock/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});


test('[TEST-OPS-003-001] restore drill verifies fingerprints before success evidence or candidate-ledger proof', async () => {
  const fixture = await createFixture();
  try {
    const archive = fixture.backupDestination;
    const identity = path.join(fixture.directory, 'identity');
    const commands = path.join(fixture.directory, 'commands.jsonl');
    const scratch = path.join(fixture.directory, 'resources.json');
    const runtimeSettings = path.join(fixture.directory, 'runtime.env');
    const introspectionSecret = path.join(fixture.directory, 'introspection-secret');
    const digest = contents => createHash('sha256').update(contents).digest('hex');
    const originalContents = [
      ['database.dump.age', 'database dump'], ['history.tar.age', 'history archive'],
      ['manifest.age', ['codexia-backup/v2', digest('restored database'), digest('restored history')].join('\n')],
    ];
    await writeFile(identity, 'fixture recovery identity', { mode: 0o600 });
    await writeFile(path.join(fixture.bin, 'age'), '#!/bin/sh\nexec cat -- "$4"\n');
    await writeFile(path.join(fixture.bin, 'podman'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const [verb, action, subject] = args;
const statePath = process.env.DRILL_FIXTURE_RESOURCES;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.images ||= {};
fs.appendFileSync(process.env.DRILL_FIXTURE_COMMANDS, JSON.stringify(args) + '\\n');
const input = args.includes('-i') || verb === 'volume' && action === 'import' ? fs.readFileSync(0, 'utf8') : '';
if (args.some(value => value.startsWith('auth_password=')) && !input.startsWith('DO $$ BEGIN\\n')) process.exit(2);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const id = value => value.split('=')[1];
if (['container', 'volume'].includes(verb) && action === 'exists') process.exit(subject in state.resources ? 0 : 1);
if (verb === 'volume' && action === 'create') state.resources[args.at(-1)] = id(args[3]);
else if (verb === 'volume' && action === 'inspect' || verb === 'inspect') {
  process.stdout.write(args.includes('{{.HostConfig.NetworkMode}}') ? (state.images[args.at(-1)] ? 'container:' + 'd'.repeat(64) : 'none') : args.includes('{{.Id}}') ? 'd'.repeat(64) : args.includes('{{.State.Running}}') ? (process.env.DRILL_FIXTURE_API_EXITED ? 'false' : 'true') : args.includes('{{.Config.Image}}') ? state.images[args.at(-1)] : state.resources[args.at(-1)]);
} else if (verb === 'run' && action === '-d') {
  const name = args[args.indexOf('--name') + 1];
  state.resources[name] = id(args[args.indexOf('--label') + 1]);
  if (args.at(-1).startsWith('ghcr.io/')) state.images[name] = args.at(-1);
}
else if (verb === 'run' && args.includes('--name')) state.resources[args[args.indexOf('--name') + 1]] = id(args[args.indexOf('--label') + 1]);
else if (verb === 'run' && args.includes('/bin/bash')) {
  if (process.env.DRILL_FIXTURE_FAIL_HISTORY_FINGERPRINT) process.exit(125);
  if (!process.env.DRILL_FIXTURE_EMPTY_HISTORY) {
    process.stdout.write(process.env.DRILL_FIXTURE_WRONG_HISTORY ? 'wrong history' : 'restored history');
  }
}
else if (verb === 'run' && args.at(-1).includes('verifyPostgresSchema')) process.stdout.write(process.env.DRILL_FIXTURE_LEDGER + '\\n');
else if (verb === 'exec' && args.some(value => value.includes('/health/ready'))) {
  if (process.env.DRILL_FIXTURE_FAIL_API_READINESS) process.exit(125);
}
else if (verb === 'exec' && args.includes('sh')) {
  if (process.env.DRILL_FIXTURE_FAIL_DATABASE_FINGERPRINT) process.exit(125);
  if (!process.env.DRILL_FIXTURE_EMPTY_DATABASE) {
    process.stdout.write(process.env.DRILL_FIXTURE_BAD_RESTORE ? 'wrong database' : 'restored database');
  }
}
else if (verb === 'rm' || verb === 'volume' && action === 'rm') delete state.resources[args.at(-1)];
save();
`);
    const candidate = `ghcr.io/yohn-jp/codexia-backend@sha256:${'a'.repeat(64)}`;
    const ledger = 'sha256:' + 'b'.repeat(64);
    const run = async (options, {
      wrongDatabase = false, wrongHistory = false, emptyDatabase = false, emptyHistory = false,
      failDatabaseFingerprint = false, failHistoryFingerprint = false, failApiReadiness = false, ledgerResult = ledger,
    } = {}) => {
      await writeFile(scratch, JSON.stringify({ resources: {} }));
      await writeFile(commands, '');
      const manifest = ['codexia-backup/v2', digest(emptyDatabase ? '' : 'restored database'),
        digest(emptyHistory ? '' : 'restored history')].join('\n');
      const contents = [
        ['database.dump.age', 'database dump'], ['history.tar.age', 'history archive'], ['manifest.age', manifest],
      ];
      for (const [name, bytes] of contents) await writeFile(path.join(archive, name), bytes);
      await writeFile(path.join(archive, 'SHA256SUMS'), contents.map(([name, bytes]) => `${digest(bytes)}  ${name}\n`).join(''));
      const result = spawnSync('bash', [backupProgram, 'drill', archive, identity, '--approved', ...options], {
        encoding: 'utf8',
        env: {
          ...process.env, HOME: fixture.home, CODEXIA_PUSH_STATE_DIR: fixture.stateDir,
          PATH: `${fixture.bin}:${process.env.PATH}`,
          DRILL_FIXTURE_RESOURCES: scratch, DRILL_FIXTURE_COMMANDS: commands,
          DRILL_FIXTURE_LEDGER: ledgerResult, DRILL_FIXTURE_BAD_RESTORE: wrongDatabase ? '1' : '',
          DRILL_FIXTURE_WRONG_HISTORY: wrongHistory ? '1' : '',
          DRILL_FIXTURE_EMPTY_DATABASE: emptyDatabase ? '1' : '',
          DRILL_FIXTURE_EMPTY_HISTORY: emptyHistory ? '1' : '',
          DRILL_FIXTURE_FAIL_DATABASE_FINGERPRINT: failDatabaseFingerprint ? '1' : '',
          DRILL_FIXTURE_FAIL_HISTORY_FINGERPRINT: failHistoryFingerprint ? '1' : '',
          DRILL_FIXTURE_FAIL_API_READINESS: failApiReadiness ? '1' : '',
          DRILL_FIXTURE_API_EXITED: failApiReadiness ? '1' : '',
        },
      });
      assert.deepEqual(JSON.parse(await readFile(scratch, 'utf8')).resources, {});
      const calls = (await readFile(commands, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      return { ...result, calls };
    };

    const basic = await run([]);
    assert.equal(basic.status, 0, basic.stderr);
    assert.match(basic.stdout, /Verified checksum manifest sha256: [a-f0-9]{64}/u);
    assert.doesNotMatch(basic.stdout, /maintenance rehearsal/u);
    assert.equal(basic.calls.filter(call => call.includes('--entrypoint') && call.includes('node')).length, 0);

    const readOnlyArgs = ['--candidate-full-image', candidate, '--candidate-ledger', ledger];
    const readOnly = await run(readOnlyArgs);
    assert.equal(readOnly.status, 0, readOnly.stderr);
    assert.ok(readOnly.stdout.includes(`Isolated candidate ledger verified: ${ledger}`));
    assert.doesNotMatch(readOnly.stdout, /maintenance rehearsal/u);
    const candidateChecks = readOnly.calls.filter(call => call[0] === 'run' && call.includes(candidate));
    assert.equal(candidateChecks.length, 2);
    assert.ok(candidateChecks[1].at(-1).includes('verifyPostgresSchema'));
    assert.ok(candidateChecks[1].some(argument => argument.includes('default_transaction_read_only')));
    assert.ok(candidateChecks.every(call => call.includes('--read-only') && call.includes('--pull=never')));
    assert.ok(candidateChecks.every(call => !call.includes('--apply') && !call.includes('--volume')));
    await writeFile(runtimeSettings, [
      'CODEXIA_PUBLIC_ORIGIN=https://fixture.example.test',
      'CODEXIA_OIDC_ISSUER=https://identity.example.test',
      'CODEXIA_OIDC_CLIENT_ID=fixture-web',
      'CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID=fixture-introspection',
      'CODEXIA_OAUTH_OWNER_SUBJECT=fixture-owner',
      'CODEXIA_OAUTH_OWNER_CLIENT_IDS=fixture-web,fixture-ios',
      '',
    ].join('\n'), { mode: 0o600 });
    await writeFile(introspectionSecret, 'fixture-introspection-secret-with-enough-length', { mode: 0o600 });
    const apiReadyArgs = [
      ...readOnlyArgs, '--candidate-api-ready', '--candidate-runtime-settings', runtimeSettings,
      '--candidate-introspection-secret-file', introspectionSecret,
    ];
    const apiReady = await run(apiReadyArgs);
    assert.equal(apiReady.status, 0, apiReady.stderr);
    assert.ok(apiReady.stdout.includes('Isolated candidate API readiness verified'));
    const apiStart = apiReady.calls.find(call => call[0] === 'run' && call.includes('--name') && call.includes(candidate));
    assert.ok(apiStart);
    const restoredDatabase = apiReady.calls.find(call => call[0] === 'run' && call[1] === '-d');
    const apiDatabaseName = restoredDatabase[restoredDatabase.indexOf('--name') + 1];
    assert.equal(apiStart[apiStart.indexOf('--network') + 1], `container:${apiDatabaseName}`);
    assert.ok(apiStart.includes('--read-only') && apiStart.includes('--pull=never'));
    assert.ok(apiStart.some(argument => argument.startsWith('--env-file')));
    assert.ok(apiReady.calls.filter(call => call[0] === 'exec').length >= 2);
    await writeFile(runtimeSettings, [
      'CODEXIA_PUBLIC_ORIGIN=https://fixture.example.test',
      'CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID=fixture-introspection',
      'CODEXIA_OAUTH_OWNER_SUBJECT=fixture-owner',
      'CODEXIA_OAUTH_OWNER_CLIENT_IDS=fixture-web,fixture-ios',
      '',
    ].join('\n'), { mode: 0o600 });
    const passkeyOnly = await run(apiReadyArgs);
    assert.equal(passkeyOnly.status, 0, passkeyOnly.stderr);
    assert.ok(passkeyOnly.stdout.includes('Isolated candidate API readiness verified'));
    await writeFile(runtimeSettings, [
      'CODEXIA_PUBLIC_ORIGIN=https://fixture.example.test',
      'CODEXIA_OIDC_ISSUER=https://identity.example.test',
      'CODEXIA_OIDC_CLIENT_ID=fixture-web',
      'CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID=fixture-introspection',
      'CODEXIA_OAUTH_OWNER_SUBJECT=fixture-owner',
      'CODEXIA_OAUTH_OWNER_CLIENT_IDS=fixture-web,fixture-ios',
      '',
    ].join('\n'), { mode: 0o600 });
    const unhealthyApi = await run(apiReadyArgs, { failApiReadiness: true });
    assert.equal(unhealthyApi.status, 1);
    assert.match(unhealthyApi.stderr, /candidate API readiness/u);
    assert.doesNotMatch(unhealthyApi.stdout, /Isolated candidate API readiness verified/u);
    const wrongLedger = await run(readOnlyArgs, { ledgerResult: 'sha256:' + 'c'.repeat(64) });
    assert.equal(wrongLedger.status, 1);
    assert.doesNotMatch(wrongLedger.stdout, /verified/u);
    const unknownMigration = await run([...readOnlyArgs, '--migration', 'arbitrary-command']);
    assert.equal(unknownMigration.status, 1);
    assert.deepEqual(unknownMigration.calls, []);

    const tagged = await run(['--candidate-full-image', 'ghcr.io/yohn-jp/codexia-backend:latest', '--candidate-ledger', ledger]);
    assert.equal(tagged.status, 1);
    assert.deepEqual(tagged.calls, []);

    const wrongDatabase = await run(readOnlyArgs, { wrongDatabase: true });
    assert.equal(wrongDatabase.status, 1);
    assert.match(wrongDatabase.stderr, /Restored database logical fingerprint mismatch/u);
    assert.equal(wrongDatabase.calls.filter(call => call.includes(candidate)).length, 0);

    const wrongHistory = await run([], { wrongHistory: true });
    assert.equal(wrongHistory.status, 1);
    assert.match(wrongHistory.stderr, /Restored history fingerprint mismatch/u);
    assert.doesNotMatch(wrongHistory.stdout,
      /Isolated restore verified:|Verified checksum manifest sha256:|Verified database logical sha256:|Verified history logical sha256:|Isolated candidate ledger verified:/u);

    const emptyRestore = await run([], { emptyDatabase: true, emptyHistory: true });
    assert.equal(emptyRestore.status, 0, emptyRestore.stderr);
    assert.match(emptyRestore.stdout, /Isolated restore verified: database and history fingerprints match/u);

    const failedDatabaseRead = await run([], {
      emptyDatabase: true, emptyHistory: true, failDatabaseFingerprint: true,
    });
    const failedHistoryRead = await run([], {
      emptyDatabase: true, emptyHistory: true, failHistoryFingerprint: true,
    });
    assert.deepEqual([failedDatabaseRead.status, failedHistoryRead.status], [1, 1]);
    assert.match(failedDatabaseRead.stderr, /database fingerprint/u);
    assert.doesNotMatch(failedDatabaseRead.stdout,
      /Isolated restore verified:|Verified checksum manifest sha256:|Verified database logical sha256:|Verified history logical sha256:|Isolated candidate ledger verified:/u);
    assert.match(failedHistoryRead.stderr, /history fingerprint/u);
    assert.doesNotMatch(failedHistoryRead.stdout,
      /Isolated restore verified:|Verified checksum manifest sha256:|Verified database logical sha256:|Verified history logical sha256:|Isolated candidate ledger verified:/u);

    assert.ok(readOnly.stdout.includes(`Verified database logical sha256: ${digest('restored database')}`));
    assert.ok(readOnly.stdout.includes(`Verified history logical sha256: ${digest('restored history')}`));
    const restoredDb = readOnly.calls.find(call => call[0] === 'run' && call[1] === '-d');
    const dbName = restoredDb[restoredDb.indexOf('--name') + 1];
    assert.match(dbName, /^codexia-restore-drill-[a-f0-9-]+$/u);
    assert.equal(restoredDb[restoredDb.indexOf('--network') + 1], 'none');
    const scratchHistory = readOnly.calls.find(call => call[0] === 'volume' && call[1] === 'import')[2];
    assert.equal(scratchHistory, `${dbName}-history`);
    const historyImport = readOnly.calls.findIndex(call => call[0] === 'volume' && call[1] === 'import');
    const privateMountRoot = readOnly.calls.findIndex(call => call.at(-1) === 'chmod 0700 /history; chown 1000:1000 /history');
    assert.ok(privateMountRoot > historyImport && privateMountRoot < readOnly.calls.indexOf(candidateChecks[0]));
    const mountSetup = readOnly.calls[privateMountRoot];
    assert.equal(mountSetup[mountSetup.indexOf('--volume') + 1], `${scratchHistory}:/history:rw,nocopy`);
    assert.equal(mountSetup[mountSetup.indexOf('--network') + 1], 'none');

    for (const [name, bytes] of originalContents) {
      await writeFile(path.join(archive, name), bytes);
      assert.equal(await readFile(path.join(archive, name), 'utf8'), bytes);
    }
    await writeFile(path.join(archive, 'SHA256SUMS'),
      originalContents.map(([name, bytes]) => `${digest(bytes)}  ${name}\n`).join(''));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
