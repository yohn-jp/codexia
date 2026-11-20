import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 900000, maxBuffer: 4 * 1024 * 1024, ...options }).trim();
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed (${error.status ?? 'unknown'}): ${error.stderr ?? error.stdout ?? error.message}`);
  }
}

function imageId(image) {
  const value = run('podman', ['image', 'inspect', '--format', '{{.Id}}', image]);
  assert.match(value, /^sha256:[a-f0-9]{64}$/u);
  return value;
}

async function embeddedIdentity(image) {
  const value = run('podman', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'all',
    '--security-opt', 'no-new-privileges', '--entrypoint', 'cat', image, '/app/update-identity.json']);
  const identity = JSON.parse(value);
  assert.equal(identity.format, 'codexia-backend-identity/v1');
  assert.equal(identity.profile, 'core');
  assert.equal(identity.platform, 'linux/amd64');
  assert.match(identity.migrationFingerprint, /^sha256:[a-f0-9]{64}$/u);
  return identity;
}

async function main() {
  assert.notEqual(process.getuid(), 0, 'Schema fixture must run rootless');
  assert.notEqual(os.userInfo().username, 'codexia', 'Refusing the production Codexia service identity');
  assert.equal(process.env.CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE, 'yes');
  const markerStat = await lstat('/etc/codexia-iac-disposable-vm');
  assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.uid === 0 && (markerStat.mode & 0o777) === 0o444);
  const marker = await readFile('/etc/codexia-iac-disposable-vm', 'utf8');
  assert.equal(marker.trim(), 'codexia-iac-disposable-vm/v1');
  const [repoRootArg, workDirArg, nonce, sourceSha] = process.argv.slice(2);
  const repoRoot = path.resolve(repoRootArg);
  const workDir = path.resolve(workDirArg);
  assert.match(nonce ?? '', /^[a-f0-9]{32}$/u);
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(run('systemctl', ['--user', 'is-active', 'codexia-db.service']), 'active');
  const [db] = JSON.parse(run('podman', ['inspect', '--type', 'container', 'codexia-db']));
  assert.equal(db.State?.Running, true);
  assert.equal(db.Config?.Labels?.['codexia.runtime-contract-test'], nonce, 'PostgreSQL is not owned by this disposable fixture');
  assert.equal(run('podman', ['secret', 'exists', 'codexia-postgres-app-password']), '');

  const root = path.join(workDir, `schema-proof-${nonce}`);
  const baseContext = path.join(root, 'base');
  const targetContext = path.join(root, 'target');
  await mkdir(root, { mode: 0o700 });
  await cp(repoRoot, baseContext, { recursive: true, filter: source => !source.split(path.sep).includes('node_modules') });
  await cp(baseContext, targetContext, { recursive: true, filter: source => !source.split(path.sep).includes('node_modules') });
  const migration = '0004-ci-schema-maintenance.sql';
  const migrationSql = 'CREATE TABLE public.codexia_schema_maintenance_ci (id text PRIMARY KEY, note text NOT NULL);\n';
  await writeFile(path.join(targetContext, 'packages/persistence-postgres/migrations', migration), migrationSql, { mode: 0o600, flag: 'wx' });
  const targetSha = createHash('sha1').update(`schema-fixture:${nonce}`).digest('hex');
  const baseVersion = run('node', ['-e', "process.stdout.write(require('./packages/api/package.json').version)"], { cwd: repoRoot });
  const [major, minor, patch] = baseVersion.split('.').map(Number);
  const targetVersion = `${major}.${minor}.${patch + 1}`;
  const args = ['build', '--pull=always', '--file', 'Dockerfile.backend', '--build-arg', 'PROFILE=core',
    '--build-arg', `CODEXIA_RELEASE_VERSION=${baseVersion}`, '--build-arg', `CODEXIA_PRODUCER_REVISION=${sourceSha}`,
    '--label', `codexia.runtime-contract-test=${nonce}`,
    '--tag', `localhost/codexia-schema-base:${nonce}`, '.'];
  run('podman', args, { cwd: baseContext });
  const baseImage = `localhost/codexia-schema-base:${nonce}`;
  const baseId = imageId(baseImage);
  const baseIdentity = await embeddedIdentity(baseId);
  assert.equal(baseIdentity.sourceSha, sourceSha);
  assert.equal(baseIdentity.version, baseVersion);

  run('podman', ['build', '--pull=always', '--file', 'Dockerfile.backend', '--build-arg', 'PROFILE=core',
    '--build-arg', `CODEXIA_RELEASE_VERSION=${targetVersion}`, '--build-arg', `CODEXIA_PRODUCER_REVISION=${targetSha}`,
    '--label', `codexia.runtime-contract-test=${nonce}`,
    '--tag', `localhost/codexia-schema-target:${nonce}`, '.'], { cwd: targetContext });
  const targetImage = `localhost/codexia-schema-target:${nonce}`;
  const targetId = imageId(targetImage);
  assert.notEqual(targetId, baseId, 'Candidate OCI content did not change');
  const targetIdentity = await embeddedIdentity(targetId);
  assert.equal(targetIdentity.sourceSha, targetSha);
  assert.equal(targetIdentity.version, targetVersion);
  await writeFile(path.join(root, 'images.json'), JSON.stringify({
    format: 'codexia-schema-maintenance-ci-images/v1', nonce, baseId, targetId,
    baseIdentity, targetIdentity, migration,
  }) + '\n', { mode: 0o600, flag: 'wx' });

  const { PodmanStandaloneHost } = await import(pathToFileURL(path.join(repoRoot, 'deploy/updater/standalone-host.mjs')).href);
  const host = new PodmanStandaloneHost({
    browserAuth: { mode: 'token' }, frontendIdentityUrl: 'https://codexia.invalid/desktop/update-identity.json',
    routeFile: path.join(root, 'route'), quadletDirectory: path.join(root, 'quadlets'), githubTokenFile: path.join(root, 'token'),
    runtime: { format: 'codexia-runtime/v1', profile: 'core', modelCachePath: null,
      tmpfs: { tempSize: '64m', moduleCacheSize: '128m' },
      resources: { memoryMaxBytes: 2 * 1024 ** 3, cpuQuotaPercent: 100 } },
  });
  const priorRelease = { ...baseIdentity, image: baseId };
  const targetRelease = { ...targetIdentity, image: targetId };
  const beforeDatabase = await host.freshDatabaseIdentity();
  const initialized = await host.initializeFreshSchema(priorRelease);
  assert.equal(initialized.fingerprint, baseIdentity.migrationFingerprint);
  assert.ok(Array.isArray(initialized.applied) && initialized.applied.length >= 3,
    'Base schema initialized from the locally built OCI image');
  run('podman', ['exec', 'codexia-db', 'sh', '-ec',
    'export PGPASSWORD="$(cat /run/secrets/admin-password)"; psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "CREATE TABLE public.codexia_schema_maintenance_seed (id text PRIMARY KEY, value text NOT NULL); INSERT INTO public.codexia_schema_maintenance_seed VALUES (\'fixture-seed\', \'preserve-me\')"']);
  const applied = await host.applyAdditiveSchema(targetRelease, baseIdentity.migrationFingerprint, targetIdentity.migrationFingerprint);
  assert.ok(applied.applied.includes(migration), 'Candidate migration was not applied');
  assert.equal(applied.fingerprint, targetIdentity.migrationFingerprint);
  assert.equal(await host.freshDatabaseIdentity(), beforeDatabase, 'Schema migration replaced the PostgreSQL identity');
  const seed = run('podman', ['exec', 'codexia-db', 'sh', '-ec',
    'export PGPASSWORD="$(cat /run/secrets/admin-password)"; psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "SELECT value FROM public.codexia_schema_maintenance_seed WHERE id=\'fixture-seed\'"']);
  assert.equal(seed, 'preserve-me', 'Existing PostgreSQL seed data was not preserved');
  await assert.rejects(host.applyAdditiveSchema(targetRelease, baseIdentity.migrationFingerprint, targetIdentity.migrationFingerprint),
    /failed|differs|prior state/u, 'The old migration fingerprint was admitted after the commit');
  console.log(JSON.stringify({ format: 'codexia-schema-maintenance-postgres-proof/v1',
    databaseIdentityPreserved: true, seedPreserved: true, priorFingerprintRejected: true,
    baseImageId: baseId, candidateImageId: targetId, migration, fingerprint: targetIdentity.migrationFingerprint }));
}

await main();
