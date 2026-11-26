import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const backupProgram = path.join(root, 'deploy/backup/backup.sh');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-push-backup-'));
  const home = path.join(directory, 'home');
  const stateDir = path.join(home, '.local/state/codexia-deploy');
  const backupDestination = path.join(directory, 'backup');
  const bin = path.join(directory, 'bin');
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(backupDestination), mkdir(bin)]);
  const lockFile = path.join(stateDir, 'host.lock');
  await writeFile(lockFile, '');
  const commands = {
    age: '#!/bin/sh\nexit 0\n',
    findmnt: '#!/bin/sh\nfor format do :; done\ncase "$format" in FSTYPE) printf nfs;; SOURCE) printf 192.0.2.55:/backup;; *) exit 2;; esac\n',
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

test('fingerprint-locked returns canonical hashes only with the quiesced host lock', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(path.join(fixture.bin, 'podman'), '#!/bin/sh\ncase "$1" in\n  exec) printf database;;\n  run) printf history;;\n  volume) exit 0;;\n  *) exit 1;;\nesac\n');
    const args = [backupProgram, 'fingerprint-locked', '--approved', '--lock-file', fixture.lockFile, '--lock-fd', '9'];
    const launch = `exec 9>${shellQuote(fixture.lockFile)}; flock --exclusive --nonblock 9; exec ${args.map(shellQuote).join(' ')}`;
    const env = { ...process.env, HOME: fixture.home, XDG_STATE_HOME: path.join(fixture.home, '.local/state'), PATH: `${fixture.bin}:${process.env.PATH}` };
    const verified = spawnSync('bash', ['-c', launch], { encoding: 'utf8', env });
    assert.equal(verified.status, 0, verified.stderr);
    const digest = input => createHash('sha256').update(input).digest('hex');
    assert.deepEqual(JSON.parse(verified.stdout), { databaseFingerprint: digest('database'), historyFingerprint: digest('history') });
    const missingLock = spawnSync('bash', args, { encoding: 'utf8', env });
    assert.notEqual(missingLock.status, 0);
    assert.match(missingLock.stderr, /lock descriptor/u);
    const activeApi = spawnSync('bash', ['-c', launch], { encoding: 'utf8', env: { ...env, CODEXIA_TEST_ACTIVE_UNITS: 'codexia-api.service' } });
    assert.notEqual(activeApi.status, 0);
    assert.match(activeApi.stderr, /inactive systemd unit/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('restore drill verifies fingerprints before success evidence or candidate-ledger proof', async () => {
  const fixture = await createFixture();
  try {
    const archive = fixture.backupDestination;
    const identity = path.join(fixture.directory, 'identity');
    const commands = path.join(fixture.directory, 'commands.jsonl');
    const scratch = path.join(fixture.directory, 'resources.json');
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
fs.appendFileSync(process.env.DRILL_FIXTURE_COMMANDS, JSON.stringify(args) + '\\n');
if (args.includes('-i') || verb === 'volume' && action === 'import') fs.readFileSync(0);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const id = value => value.split('=')[1];
if (['container', 'volume'].includes(verb) && action === 'exists') process.exit(subject in state.resources ? 0 : 1);
if (verb === 'volume' && action === 'create') state.resources[args.at(-1)] = id(args[3]);
else if (verb === 'volume' && action === 'inspect' || verb === 'inspect') {
  process.stdout.write(args.includes('{{.HostConfig.NetworkMode}}') ? 'none' : state.resources[args.at(-1)]);
} else if (verb === 'run' && action === '-d') state.resources[args[args.indexOf('--name') + 1]] = id(args[args.indexOf('--label') + 1]);
else if (verb === 'run' && args.includes('/bin/bash')) {
  if (process.env.DRILL_FIXTURE_FAIL_HISTORY_FINGERPRINT) process.exit(125);
  if (!process.env.DRILL_FIXTURE_EMPTY_HISTORY) {
    process.stdout.write(process.env.DRILL_FIXTURE_WRONG_HISTORY ? 'wrong history' : 'restored history');
  }
}
else if (verb === 'run' && args.at(-1).includes('verifyPostgresSchema')) process.stdout.write(process.env.DRILL_FIXTURE_LEDGER + '\\n');
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
      failDatabaseFingerprint = false, failHistoryFingerprint = false, ledgerResult = ledger,
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
