import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function invokeBackup(fixture, { activeUnits = '', approved = true } = {}) {
  const args = [
    backupProgram,
    'backup-locked',
    fixture.backupDestination,
    'age1pushfixture',
    ...(approved ? ['--approved', '--lock-file', fixture.lockFile, '--lock-fd', '9'] : []),
  ].map(shellQuote).join(' ');
  const command = `exec 9>${shellQuote(fixture.lockFile)}; flock --exclusive --nonblock 9; exec ${args} 9>&9`;
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
