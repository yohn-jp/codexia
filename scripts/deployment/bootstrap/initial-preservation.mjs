import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLifecycleHost } from '../preflight/run.mjs';
import { digestEvidence } from '../preflight/evidence-digest.mjs';
import { initialBackupBinding } from '../preflight/preservation.mjs';

const env = process.env;
const privateFile = (path, data) => writeFile(path, data, { mode: 0o600, flag: 'wx' });
const run = (program, args, input) => execFileSync(program, args, {
  input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30 * 60_000,
});

async function main(operation) {
  assert.equal(env.GITHUB_REPOSITORY, 'yohn-jp/codexia');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  const scratch = join(env.RUNNER_TEMP, 'initial-preservation');
  const transfer = (args) => run(join(env.RUNNER_TEMP, 'bootstrap-s3/bin/python'),
    ['deploy/backup/s3_transfer.py', ...args, '--profile', join(scratch, 'profile'), '--credential-stdin'],
    env.CODEXIA_INITIAL_BACKUP_CREDENTIAL);
  const ageIdentity = join(scratch, 'identity');
  const receipt = join(scratch, 'transfer.json');
  const handoff = join(env.RUNNER_TEMP, 'initial-handoff');
  await mkdir(scratch, { mode: 0o700 });
  await privateFile(join(scratch, 'profile'), env.CODEXIA_INITIAL_BACKUP_PROFILE);
  const source = { sourceSha: env.GITHUB_SHA, runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) };

  if (operation === 'capture') {
    await mkdir(handoff, { mode: 0o700 });
    const sshConfig = join(env.RUNNER_TEMP, 'codexia-ssh/config');
    const inventory = join(scratch, 'inventory.json');
    await privateFile(inventory, JSON.stringify({ all: { hosts: { codexia: {
      ansible_host: 'codexia-target', ansible_user: 'codexia', ansible_ssh_use_tty: false,
      ansible_ssh_common_args: '-F "' + sshConfig + '"',
    } } } }));
    const observe = () => readLifecycleHost({ inventory, targetHost: env.CODEXIA_DEPLOY_HOST });
    const before = initialBackupBinding((await observe()).host);
    assert.ok(before, 'Requires a prepared owner and an inactive API slot');
    execFileSync('ansible-playbook', ['-i', inventory, 'deploy/ansible/verify-bootstrap-escrow.yml'], {
      env: { ...env, CODEXIA_BOOTSTRAP_ESCROW_HOST_ID: before.sourceHostId },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
    });
    const recipient = env.CODEXIA_BACKUP_AGE_RECIPIENT;
    assert.match(recipient, /^age1[0-9a-z]{58}$/u);
    const backupId = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '') + '-' + randomUUID();
    const remote = '/home/codexia/backups/codexia-' + backupId;
    // Only validated public identifiers enter the remote command. The reviewed
    // producer runs under the existing rootless lock and checks writer quiescence.
    const command = [
      'set -eu', 'umask 077', 'test "$(id -un)" = codexia', 'test "$HOME" = /home/codexia',
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"',
      'state="$HOME/.local/state/codexia-deploy"', 'test -f "$state/host.lock" && test ! -L "$state/host.lock" || exit 1',
      'exec 9<>"$state/host.lock"', 'flock -xn 9', 'test ! -L "$HOME/backups"', 'mkdir -p "$HOME/backups"',
      'exec bash -s -- backup-locked "$HOME/backups" ' + recipient +
        ' --approved --lock-file "$state/host.lock" --lock-fd 9 --artifact-id codexia-' + backupId,
    ].join('\n');
    run('ssh', ['-F', sshConfig, 'codexia-target', command], await readFile('deploy/backup/backup.sh'));
    const local = join(scratch, backupId);
    await mkdir(local, { mode: 0o700 });
    for (const file of ['database.dump.age', 'history.tar.age', 'manifest.age', 'SHA256SUMS']) {
      run('scp', ['-q', '-F', sshConfig, 'codexia-target:' + remote + '/' + file, local]);
    }
    assert.deepEqual(initialBackupBinding((await observe()).host), before, 'Prepared database changed during capture');
    transfer(['upload', '--backup-id', backupId, '--source-identity', source.sourceSha, '--artifact-dir', local, '--receipt', receipt]);
    const metadata = { ...source, ...before, backupId, transfer: JSON.parse(await readFile(receipt, 'utf8')) };
    run('age', ['-r', recipient, '-o', join(handoff, 'transfer.age')], JSON.stringify(metadata));
    return;
  }

  assert.equal(operation, 'verify');
  await privateFile(ageIdentity, env.CODEXIA_INITIAL_BACKUP_IDENTITY);
  const encryptedReceipt = await readFile(join(handoff, 'transfer.age'));
  const metadata = JSON.parse(run('age', ['-d', '-i', ageIdentity], encryptedReceipt));
  for (const [key, value] of Object.entries(source)) assert.equal(metadata[key], value);
  const { sourceHostId, databaseSha256, secretSetSha256, backupId } = metadata;
  assert.match(sourceHostId, /^[a-f0-9]{64}$/u);
  assert.match(secretSetSha256, /^[a-f0-9]{64}$/u);
  assert.match(databaseSha256, /^[a-f0-9]{64}$/u);
  await privateFile(receipt, JSON.stringify(metadata.transfer));
  const restored = join(scratch, 'restored');
  await mkdir(restored, { mode: 0o700 });
  transfer(['download', '--backup-id', backupId, '--receipt', receipt, '--output-dir', restored]);
  const directory = join(restored, 'codexia-' + backupId);
  const drill = run('bash', ['deploy/backup/backup.sh', 'drill', directory, ageIdentity, '--approved']);
  assert.ok(drill.split('\n').includes('Isolated restore verified: database and history fingerprints match'));
  const [format, databaseFingerprint, historyFingerprint] = run('age', ['-d', '-i', ageIdentity,
    join(directory, 'manifest.age')]).trimEnd().split('\n');
  assert.equal(format, 'codexia-backup/v2');
  assert.ok([databaseFingerprint, historyFingerprint].every(value => /^[a-f0-9]{64}$/u.test(value)));
  run(join(env.RUNNER_TEMP, 'bootstrap-s3/bin/python'), ['deploy/backup/bootstrap_escrow.py',
    'retain-v2-receipt', '--host-id', sourceHostId, '--backup-id', backupId], encryptedReceipt);
  const evidence = { format: 'codexia-initial-preservation/v1', ...source, sourceHostId, databaseSha256, secretSetSha256,
    databaseFingerprint, historyFingerprint, independentBackupEvidenceSha256: digestEvidence(metadata.transfer) };
  await privateFile(join(scratch, 'preservation.json'), JSON.stringify(evidence));
  await appendFile(env.GITHUB_OUTPUT, 'name=initial-preservation-' + sourceHostId + '-' + databaseSha256 + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(process.argv[2]); } catch {
    console.error('Initial preservation stopped during ' + (process.argv[2] === 'verify' ? 'independent restore' : 'capture and S3 readback'));
    process.exitCode = 1;
  }
}
