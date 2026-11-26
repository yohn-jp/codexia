import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initialBackupBinding, trustedInitialBackupRun } from '../preflight/preservation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = '3'.repeat(40), hash = 'a'.repeat(64);
const host = { hostId: hash, H: 'ready', backend: { state: 'absent' }, transaction: null,
  topology: { secretHashes: { 'codexia-auth-secret': hash } },
  database: { state: 'initialized', authState: 'ready', settingsSha256: hash, ownerBindingSha256: 'sha256:' + hash } };
const repo = { full_name: 'yohn-jp/codexia' };
test('initial preservation binds the prepared database, immutable secrets and trusted protected producer', () => {
  const run = { head_sha: sha, head_branch: 'main', event: 'workflow_dispatch', repository: repo, head_repository: repo,
    path: '.github/workflows/initial-preservation.yml', status: 'completed', conclusion: 'success', run_attempt: 1 };
  assert.ok(trustedInitialBackupRun(run, sha));
  for (const change of [{ event: 'pull_request' }, { head_repository: { full_name: 'other/codexia' } },
    { path: '.github/workflows/verify.yml' }, { run_attempt: 2 }, { conclusion: 'failure' }]) {
    assert.equal(trustedInitialBackupRun({ ...run, ...change }, sha), false);
  }
  for (const change of [{ H: 'partial' }, { transaction: {} }, { backend: { state: 'running' } }]) {
    assert.equal(initialBackupBinding({ ...host, ...change }), null);
  }
  const binding = initialBackupBinding(host);
  assert.ok(binding);
  assert.notEqual(binding.secretSetSha256, initialBackupBinding({ ...host,
    topology: { secretHashes: { 'codexia-auth-secret': 'b'.repeat(64) } } }).secretSetSha256);
});

const ageAvailable = spawnSync('age', ['--version']).status === 0 && spawnSync('age-keygen', ['--version']).status === 0;
test('capture and independent restore pass an encrypted transfer receipt and publish proof only after the drill', { skip: !ageAvailable }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'initial-preservation-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), storage = join(dir, 'private-s3');
  mkdirSync(bin); mkdirSync(storage);
  const executable = (path, script) => writeFileSync(path, '#!/usr/bin/env python3\n' + script, { mode: 0o700 });
  const key = join(dir, 'age-key');
  execFileSync('age-keygen', ['-o', key], { stdio: 'ignore' });
  const recipient = execFileSync('age-keygen', ['-y', key], { encoding: 'utf8' }).trim();
  execFileSync('age', ['-r', recipient, '-o', join(storage, 'manifest.age')],
    { input: 'codexia-backup/v2\n' + hash + '\n' + hash + '\n' });
  for (const file of ['database.dump.age', 'history.tar.age', 'SHA256SUMS']) writeFileSync(join(storage, file), 'sample');
  executable(join(bin, 'ansible-playbook'), `import json,os,sys
if 'deploy/ansible/verify-bootstrap-escrow.yml' in sys.argv:
 assert os.environ['CODEXIA_BOOTSTRAP_ESCROW_HOST_ID']==os.environ['HOST_ID']
else:
 with open(json.load(open(sys.argv[-1][1:]))['codexia_preflight_observation_file'],'w') as f: f.write(os.environ['HOST'])
`);
  executable(join(bin, 'ssh'), `import sys
assert 'flock -xn 9' in sys.argv[-1] and '--lock-fd 9' in sys.argv[-1]
assert 'codexia-backup/v2' in sys.stdin.read()
`);
  executable(join(bin, 'scp'), `import shutil, pathlib, os, sys
shutil.copy(pathlib.Path(os.environ['STORAGE']) / pathlib.Path(sys.argv[-2]).name, sys.argv[-1])
`);
  executable(join(bin, 'bash'), `import sys,os
assert sys.argv[1:3] == ['deploy/backup/backup.sh','drill'] and sys.argv[-1]=='--approved'
assert os.path.isfile(os.path.join(sys.argv[3],'manifest.age'))
assert os.stat(sys.argv[4]).st_mode & 0o777 == 0o600
if 'BROKEN_DRILL' in os.environ: sys.exit(1)
print('Isolated restore verified: database and history fingerprints match')
`);
  function runner(name) {
    const temp = join(dir, name);
    mkdirSync(join(temp, 'bootstrap-s3/bin'), { recursive: true });
    mkdirSync(join(temp, 'codexia-ssh')); writeFileSync(join(temp, 'codexia-ssh/known_hosts'), 'fixture');
    executable(join(temp, 'bootstrap-s3/bin/python'), `import sys,pathlib,json,shutil,os
opt=lambda name: sys.argv[sys.argv.index(name)+1]
if sys.argv[1]=='deploy/backup/bootstrap_escrow.py':
 assert sys.argv[2]=='retain-v2-receipt' and opt('--host-id')==os.environ['HOST_ID']
 assert json.loads(os.environ['CODEXIA_BOOTSTRAP_ESCROW_CREDENTIAL'])=={'recovery':True}
 sealed=sys.stdin.buffer.read()
 assert sealed==(pathlib.Path(os.environ['RUNNER_TEMP'])/'initial-handoff/transfer.age').read_bytes()
 assert opt('--backup-id')==json.loads((pathlib.Path(os.environ['RUNNER_TEMP'])/'initial-preservation/transfer.json').read_text())['backupId']
 if 'BROKEN_RETENTION' in os.environ: sys.exit(1)
 (pathlib.Path(os.environ['STORAGE'])/'retained.age').write_bytes(sealed)
 sys.exit(0)
assert sys.argv[1]=='deploy/backup/s3_transfer.py' and json.load(sys.stdin)=={'disposable':True}
receipt=pathlib.Path(opt('--receipt')); storage=pathlib.Path(os.environ['STORAGE'])
if sys.argv[2]=='upload':
 assert (pathlib.Path(opt('--artifact-dir'))/'SHA256SUMS').is_file()
 receipt.write_text(json.dumps({'backupId':opt('--backup-id'),'sourceIdentity':opt('--source-identity')}))
else:
 assert json.loads(receipt.read_text())['backupId']==opt('--backup-id')
 shutil.copytree(storage,pathlib.Path(opt('--output-dir'))/('codexia-'+opt('--backup-id')))
`);
    return { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, 'out'), GITHUB_SHA: sha,
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: repo.full_name, GITHUB_REF: 'refs/heads/main',
      GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '23', CODEXIA_DEPLOY_HOST: 'fixture.invalid',
      CODEXIA_INITIAL_BACKUP_PROFILE: '{}', CODEXIA_INITIAL_BACKUP_CREDENTIAL: '{"disposable":true}',
      CODEXIA_BACKUP_AGE_RECIPIENT: recipient, HOST: JSON.stringify(host), HOST_ID: hash, STORAGE: storage,
      PATH: bin + ':' + process.env.PATH };
  }
  const capture = runner('capture');
  function execute(op, env) {
    return spawnSync(process.execPath, ['scripts/deployment/bootstrap/initial-preservation.mjs', op], {
      cwd: root, env, encoding: 'utf8',
    });
  }
  const first = execute('capture', capture);
  assert.equal(first.status, 0, first.stderr);
  for (const scenario of ['BROKEN_DRILL', 'BROKEN_RETENTION', 'success']) {
    const recovery = runner(scenario);
    recovery.CODEXIA_BOOTSTRAP_ESCROW_CREDENTIAL = '{"recovery":true}';
    recovery.CODEXIA_INITIAL_BACKUP_IDENTITY = readFileSync(key, 'utf8');
    delete recovery.CODEXIA_BACKUP_AGE_RECIPIENT;
    if (scenario !== 'success') recovery[scenario] = '1';
    cpSync(join(capture.RUNNER_TEMP, 'initial-handoff'), join(recovery.RUNNER_TEMP, 'initial-handoff'), { recursive: true });
    const result = execute('verify', recovery);
    const output = join(recovery.RUNNER_TEMP, 'initial-preservation/preservation.json');
    if (scenario !== 'success') {
      assert.notEqual(result.status, 0);
      assert.throws(() => readFileSync(join(storage, 'retained.age')), { code: 'ENOENT' });
      assert.throws(() => readFileSync(output), { code: 'ENOENT' });
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(join(storage, 'retained.age')), readFileSync(join(capture.RUNNER_TEMP, 'initial-handoff/transfer.age')));
      const proof = JSON.parse(readFileSync(output));
      assert.equal(proof.databaseFingerprint, hash);
      assert.equal(proof.secretSetSha256, initialBackupBinding(host).secretSetSha256);
    }
  }
});
