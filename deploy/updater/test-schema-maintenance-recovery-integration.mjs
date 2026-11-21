import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signUpdateChannel } from '../../scripts/update-channel.mjs';
import { initialControllerState, atomicWrite, loadControllerState } from '../../scripts/standalone-update-controller.mjs';
import { runSchemaMaintenance, recoverSchemaMaintenance } from '../../scripts/standalone-schema-maintenance.mjs';
import { imageConfig, runtimeContainerArgs, validateRuntimeContract } from './standalone-host.mjs';

function run(command, args, options = {}) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options }).trim(); }
  catch (error) { throw new Error(`${command} ${args.join(' ')} failed (${error.status ?? 'unknown'}): ${error.stderr ?? error.stdout ?? error.message}`); }
}

function canonicalLocalImageId(value) {
  assert.match(value ?? '', /^(?:sha256:)?[a-f0-9]{64}$/u, 'Podman did not return a canonical local image ID');
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function release(identity, image) {
  return { format: 'codexia-update-release/v1', channel: 'stable', state: 'published',
    version: identity.version, sourceSha: identity.sourceSha, image, platform: identity.platform,
    profile: identity.profile, migrationFingerprint: identity.migrationFingerprint,
    persistenceFormat: identity.persistenceFormat, apiEpoch: identity.apiEpoch };
}

async function fixtureFromArgs() {
  assert.notEqual(os.userInfo().username, 'codexia');
  assert.notEqual(process.getuid(), 0);
  assert.equal(process.env.CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE, 'yes');
  const marker = await lstat('/etc/codexia-iac-disposable-vm');
  assert.ok(marker.isFile() && !marker.isSymbolicLink() && marker.uid === 0);
  assert.equal((await readFile('/etc/codexia-iac-disposable-vm', 'utf8')).trim(), 'codexia-iac-disposable-vm/v1');
  const offset = process.argv[2]?.startsWith('--schema-') ? 3 : 2;
  const [repoRootArg, workDirArg, nonce] = process.argv.slice(offset, offset + 3);
  const repoRoot = path.resolve(repoRootArg);
  const workDir = path.resolve(workDirArg);
  assert.match(nonce ?? '', /^[a-f0-9]{32}$/u);
  const fixtureRoot = path.join(workDir, `schema-proof-${nonce}`);
  const images = JSON.parse(await readFile(path.join(fixtureRoot, 'images.json'), 'utf8'));
  assert.equal(images.format, 'codexia-schema-maintenance-ci-images/v1');
  assert.equal(images.nonce, nonce);
  for (const id of [images.baseId, images.targetId]) assert.match(id, /^sha256:[a-f0-9]{64}$/u);
  const baseRelease = release(images.baseIdentity, `ghcr.io/yohn-jp/codexia-backend@${images.baseId}`);
  const targetRelease = release(images.targetIdentity, `ghcr.io/yohn-jp/codexia-backend@${images.targetId}`);
  const runtime = validateRuntimeContract(JSON.parse(await readFile(path.join(workDir, 'codexia-runtime-blue.json'), 'utf8')));
  const quadletDirectory = path.join(os.homedir(), '.config', 'containers', 'systemd');
  const root = path.join(fixtureRoot, 'recovery');
  await mkdir(root, { recursive: true, mode: 0o700 });
  return { repoRoot, workDir, fixtureRoot, root, nonce, images, baseRelease, targetRelease, runtime, quadletDirectory };
}

async function adapters(fixture) {
  const { PodmanStandaloneHost } = await import(pathToFileURL(path.join(fixture.repoRoot, 'deploy/updater/standalone-host.mjs')).href);
  const { imageConfig: makeImageConfig } = await import(pathToFileURL(path.join(fixture.repoRoot, 'deploy/updater/standalone-host.mjs')).href);
  const keyFile = path.join(fixture.root, 'ephemeral-channel-private.pem');
  const publicKeyFile = path.join(fixture.root, 'ephemeral-channel-public.pem');
  let publicKeyPem, privateKeyPem;
  try {
    privateKeyPem = await readFile(keyFile, 'utf8');
    publicKeyPem = await readFile(publicKeyFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const pair = generateKeyPairSync('ed25519');
    privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await writeFile(keyFile, privateKeyPem, { mode: 0o600, flag: 'wx' });
    await writeFile(publicKeyFile, publicKeyPem, { mode: 0o644, flag: 'wx' });
  }
  const routeDirectory = path.join(fixture.root, 'proxy-state');
  await mkdir(routeDirectory, { recursive: true, mode: 0o700 });
  const routeFile = path.join(routeDirectory, 'route');
  const stateFile = path.join(fixture.root, 'controller.json');
  const markerFile = path.join(fixture.root, 'maintenance', 'in-progress.json');
  const config = { browserAuth: { mode: 'token' }, frontendIdentityUrl: 'https://codexia.invalid/desktop/update-identity.json',
    routeFile, stateFile, quadletDirectory: fixture.quadletDirectory,
    githubTokenFile: path.join(fixture.root, 'github-read-token'), runtime: fixture.runtime };
  const host = new PodmanStandaloneHost(config);
  const original = Object.fromEntries(['observe', 'initializeFreshSchema', 'applyAdditiveSchema', 'schemaFingerprint', 'stopWriter'].map(name => [name, host[name].bind(host)]));
  const idFor = item => {
    if (item.image === fixture.baseRelease.image) return fixture.images.baseId;
    if (item.image === fixture.targetRelease.image) return fixture.images.targetId;
    throw new Error('Schema fixture adapter rejected an unpinned release image');
  };
  const readIdentity = imageId => JSON.parse(run('podman', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'all',
    '--security-opt', 'no-new-privileges', '--entrypoint', 'cat', imageId, '/app/update-identity.json']));
  host.pullAndVerify = async item => {
    const id = idFor(item);
    assert.equal(canonicalLocalImageId(run('podman', ['image', 'inspect', '--format', '{{.Id}}', id])), id);
    const identity = readIdentity(id);
    for (const key of ['version', 'sourceSha', 'platform', 'profile', 'migrationFingerprint', 'persistenceFormat', 'apiEpoch']) {
      assert.equal(identity[key], item[key], `Fixture OCI embedded ${key} differs from the release record`);
    }
  };
  host.fetchChannel = async () => {
    const now = Date.now();
    const prior = JSON.parse(await readFile(stateFile, 'utf8'));
    const sequence = (prior.journal.checkpoint?.sequence ?? 0) + 1;
    return signUpdateChannel({ format: 'codexia-update-channel/v1', sequence,
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
      releases: [fixture.baseRelease, fixture.targetRelease] }, privateKeyPem, now);
  };
  host.observe = async () => {
    const result = await original.observe();
    return { ...result, writers: result.writers.map(writer => ({ ...writer,
      image: canonicalLocalImageId(writer.image) === fixture.images.baseId ? fixture.baseRelease.image :
        canonicalLocalImageId(writer.image) === fixture.images.targetId ? fixture.targetRelease.image : writer.image })) };
  };
  host.applyAdditiveSchema = async (item, priorFingerprint, targetFingerprint) =>
    original.applyAdditiveSchema({ ...item, image: idFor(item) }, priorFingerprint, targetFingerprint);
  host.initializeFreshSchema = async (item, options) => original.initializeFreshSchema({ ...item, image: idFor(item) }, options);
  host.schemaFingerprint = async item => original.schemaFingerprint({ ...item, image: idFor(item) });
  host.backupArtifactIdentity = async directory => {
    assert.match(path.basename(directory), /^codexia-\d{8}T\d{6}Z-[a-f0-9-]{36}$/u);
    return 'b'.repeat(64); // Only the unavailable off-VM backup publication is simulated.
  };

  // The fixture adapter maps exactly two locally built, inspected OCI IDs to the
  // release references accepted by the production validator. Quadlet generation,
  // Podman execution, systemd ownership, PostgreSQL commands and recovery remain real.
  host.startWriter = async (slot, item) => {
    assert.equal(slot, 'blue');
    const image = idFor(item);
    assert.deepEqual((await host.observe()).writers, [], 'Fixture refuses to start a second writer');
    await host.assertNoWriterContainers();
    await host.assertNoPreflight();
    await mkdir(fixture.quadletDirectory, { recursive: true, mode: 0o700 });
    const source = makeImageConfig({ image, profile: item.profile }, host.authEnvironment, fixture.runtime)
      .replace('PLACEHOLDER', 'codexia-slot-blue')
      .replace('[Service]\n', `Label=codexia.runtime-contract-test=${fixture.nonce}\n[Service]\n`);
    await atomicWrite(path.join(fixture.quadletDirectory, 'codexia-slot-blue.container'), source);
    run('systemctl', ['--user', 'daemon-reload']);
    await host.assertCommittedWriterUnitSource(slot);
    run('systemctl', ['--user', 'start', 'codexia-slot-blue.service'], { timeout: 120000 });
    await host.waitReady('codexia-slot-blue', item);
    assert.deepEqual((await host.observe()).writers, [{ slot, image: item.image }]);
  };
  host.prepare = async (slot, item, owner) => {
    assert.equal(slot, 'blue');
    assert.deepEqual(owner.release, item);
    assert.deepEqual((await host.observe()).writers, []);
    assert.equal(await host.routeState(), 'blocked', 'Recovery preflight requires the route held closed');
    await host.convergePreflightSchemaGrants();
    const preflightPassword = (await readFile(path.join(fixture.workDir, 'postgres-preflight-password'), 'utf8')).trim();
    assert.match(preflightPassword, /^[a-fA-F0-9]{64}$/u);
    const preflightRead = run('podman', ['exec', '-i', 'codexia-db', 'sh', '-ec',
      'IFS= read -r PGPASSWORD; export PGPASSWORD; psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_preflight -d codexia -c "SELECT count(*) FROM public.codexia_schema_maintenance_ci"'],
    { input: preflightPassword + '\n' });
    assert.equal(preflightRead, '0', 'Canonical read-only preflight did not receive SELECT on the new migration table');
    const auth = randomBytes(32).toString('hex');
    const label = 'io.codexia.initial-activation=' + owner.operationId;
    run('podman', ['run', '--detach', '--name', 'codexia-preflight-blue', '--label', label,
      '--network', 'codexia-data', '--read-only', ...runtimeContainerArgs(fixture.runtime),
      '--tmpfs', '/data:rw,nosuid,nodev,noexec,size=128m,mode=1777',
      '--tmpfs', '/history:rw,nosuid,nodev,noexec,size=64m,mode=1777',
      '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
      '--secret', 'codexia-postgres-preflight-password,type=mount,target=/run/secrets/app-password',
      '--env', 'CODEXIA_AUTH_TOKEN', '--env', 'CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password',
      '--env', 'CODEXIA_DATABASE_USER=codexia_preflight', '--env', 'CODEXIA_DATABASE_HOST=codexia-db',
      '--env', 'CODEXIA_DATABASE_NAME=codexia', '--env', 'PGOPTIONS=-c default_transaction_read_only=on',
      '--env', 'CODEXIA_DATABASE_MIGRATE_ON_START=0', '--env', 'CODEXIA_HOSTED_MODE=0',
      '--env', 'CODEXIA_PROFILE=' + item.profile, '--env', 'CODEXIA_TRUST_PROXY=1',
      ...Object.entries(host.authEnvironment).flatMap(([key, value]) => ['--env', key + '=' + value]),
      idFor(item)], { env: { ...process.env, CODEXIA_AUTH_TOKEN: auth } });
    await host.waitReady('codexia-preflight-blue', item);
  };
  host.stopInitialPreflight = async (slot, owner) => {
    assert.equal(slot, 'blue');
    const exists = spawnSync('podman', ['container', 'exists', 'codexia-preflight-blue'], { stdio: 'ignore' });
    if (exists.status === 1) return;
    assert.equal(exists.status, 0, 'Unable to observe the preflight container');
    const found = spawnSync('podman', ['inspect', '--type', 'container', 'codexia-preflight-blue'], { encoding: 'utf8' });
    assert.equal(found.status, 0, `Unable to observe preflight container: ${found.stderr}`);
    const [container] = JSON.parse(found.stdout);
    assert.equal(container.Config?.Labels?.['io.codexia.initial-activation'], owner.operationId);
    assert.equal(canonicalLocalImageId(container.ImageName ?? container.Config?.Image), idFor(owner.release));
    run('podman', ['rm', '--force', container.Id]);
  };
  // The private proxy uses the real route file and container network. This adapter
  // verifies only its fixture-owned transient unit and local base image identity.
  host.assertProxyRuntime = async () => {
    assert.equal(await host.unitActive('codexia-api-proxy.service'), true);
    const [container] = JSON.parse(run('podman', ['inspect', '--type', 'container', 'codexia-api-proxy']));
    assert.equal(container.State?.Running, true);
    assert.equal(container.Config?.Labels?.['codexia.runtime-contract-test'], fixture.nonce);
    assert.equal(canonicalLocalImageId(container.Image), fixture.images.baseId);
  };
  let state;
  try { state = await loadControllerState(stateFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = initialControllerState(fixture.baseRelease, 'blue', null);
    await atomicWrite(stateFile, JSON.stringify(state) + '\n');
  }
  try { await lstat(routeFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await atomicWrite(routeFile, 'blue\n');
  }
  const controller = {
    host, publicKey: publicKeyPem, now: () => Date.now(),
    uiEpoch: async item => { assert.equal(item.apiEpoch, fixture.baseRelease.apiEpoch); },
    save: async value => atomicWrite(stateFile, JSON.stringify(value) + '\n'),
  };
  const source = { format: 'codexia-controller-backup-proof/v1', release: fixture.baseRelease,
    artifactDirectory: `/var/tmp/codexia-${new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '')}-${randomUUID()}`,
    checksumManifestSha256: 'b'.repeat(64), databaseId: await host.freshDatabaseIdentity(), journalGeneration: state.journal.generation };
  const restore = { format: 'codexia-restore-receipt/v1', checksumManifestSha256: source.checksumManifestSha256 };
  const markerStore = {
    load: async () => JSON.parse(await readFile(markerFile, 'utf8')),
    save: async marker => atomicWrite(markerFile, JSON.stringify(marker) + '\n'),
    clear: async () => rm(markerFile, { force: true }),
  };
  const markerDirectory = path.dirname(markerFile);
  await mkdir(markerDirectory, { recursive: true, mode: 0o700 });
  const uiIdentity = { format: 'codexia-frontend-identity/v1', apiEpoch: fixture.baseRelease.apiEpoch };
  return { host, controller, state, source, restore, markerStore, markerDirectory, markerFile, stateFile, routeFile,
    publicKeyPem, privateKeyPem, keyFile, config, images: fixture.images, baseRelease: fixture.baseRelease,
    targetRelease: fixture.targetRelease, uiIdentity, originalStopWriter: original.stopWriter };
}

async function proxyStatus(host, expected) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const status = run('podman', ['exec', 'codexia-api-proxy', 'node', '--input-type=module', '-e',
        'const response=await fetch("http://127.0.0.1:3000/api/version",{signal:AbortSignal.timeout(3000)});process.stdout.write(String(response.status));']);
      if (status === String(expected)) return;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`Disposable proxy did not return HTTP ${expected}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function startProxy(fixture, host) {
  const proxySource = path.join(fixture.root, 'proxy.mjs');
  await writeFile(proxySource, await readFile(path.join(fixture.repoRoot, 'deploy/updater/proxy.mjs')), { mode: 0o644, flag: 'wx' });
  await chmod(proxySource, 0o644);
  await chmod(host.config.routeFile, 0o644);
  const existing = spawnSync('podman', ['container', 'exists', 'codexia-api-proxy'], { stdio: 'ignore' });
  assert.equal(existing.status, 1, 'Refusing an existing non-fixture proxy container');
  run('systemd-run', ['--user', '--unit=codexia-api-proxy.service', '--collect', '--property=Restart=on-failure',
    '/usr/bin/podman', 'run', '--rm', '--name', 'codexia-api-proxy', '--network', 'codexia',
    '--label', `codexia.runtime-contract-test=${fixture.nonce}`, '--user', '0', '--read-only', '--cap-drop', 'all',
    '--security-opt', 'no-new-privileges', '--volume', `${path.dirname(host.config.routeFile)}:/config/state:ro`,
    '--volume', `${proxySource}:/config/proxy.mjs:ro`, '--entrypoint', 'node', fixture.images.baseId, '/config/proxy.mjs']);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { await host.assertProxyRuntime(); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('Fixture proxy service did not start');
}

async function resetSchema(host, release) {
  run('podman', ['exec', 'codexia-db', 'sh', '-ec',
    'export PGPASSWORD="$(cat /run/secrets/admin-password)"; psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC"']);
  const initialized = await host.initializeFreshSchema(release);
  assert.equal(initialized.fingerprint, release.migrationFingerprint);
  run('podman', ['exec', 'codexia-db', 'sh', '-ec',
    'export PGPASSWORD="$(cat /run/secrets/admin-password)"; psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "CREATE TABLE public.codexia_schema_maintenance_seed (id text PRIMARY KEY, value text NOT NULL); INSERT INTO public.codexia_schema_maintenance_seed VALUES (\'fixture-seed\', \'preserve-me\')"']);
}

async function launch(fixture, mode, scenario) {
  const entry = fileURLToPath(import.meta.url);
  const lock = path.join(path.dirname(fixture.root), 'schema-maintenance.lock');
  const command = mode === '--schema-recover' ? 'systemd-run' : 'flock';
  const args = mode === '--schema-recover'
    ? ['--user', '--wait', '--pipe', '--collect', '--setenv=CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE=yes',
      '--setenv=CODEXIA_SCHEMA_RECOVERY_FIXTURE=yes', `--unit=codexia-schema-boot-${fixture.nonce}.service`,
      '/usr/bin/flock', '--exclusive', '--nonblock', '--no-fork', lock, process.execPath, entry,
      mode, fixture.repoRoot, fixture.workDir, fixture.nonce, scenario]
    : ['--exclusive', '--nonblock', '--no-fork', lock, process.execPath, entry,
      mode, fixture.repoRoot, fixture.workDir, fixture.nonce, scenario];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CODEXIA_SCHEMA_RECOVERY_FIXTURE: 'yes' } });
  return result;
}

async function transactionRunner(fixture, scenario) {
  assert.equal(process.env.CODEXIA_SCHEMA_RECOVERY_FIXTURE, 'yes');
  const context = await adapters(fixture);
  const realApply = context.host.applyAdditiveSchema.bind(context.host);
  context.host.applyAdditiveSchema = async (...args) => {
    if (scenario === 'before-write') process.kill(process.pid, 'SIGKILL');
    await realApply(...args);
    if (scenario === 'after-write') process.kill(process.pid, 'SIGKILL');
    return args;
  };
  context.host.stopWriter = async slot => {
    await context.originalStopWriter(slot);
    if (await context.host.routeState() === 'blocked') await proxyStatus(context.host, 503);
  };
  await runSchemaMaintenance({ controller: context.controller, state: context.state, target: context.targetRelease,
    source: context.source, restore: context.restore, markerStore: context.markerStore,
    stateFile: context.stateFile, routeFile: context.routeFile });
}

async function recoveryRunner(fixture) {
  assert.equal(process.env.CODEXIA_SCHEMA_RECOVERY_FIXTURE, 'yes');
  const context = await adapters(fixture);
  const state = await loadControllerState(context.stateFile);
  const recovered = await recoverSchemaMaintenance({ controller: context.controller, state,
    markerStore: context.markerStore, stateFile: context.stateFile, routeFile: context.routeFile });
  await assert.rejects(lstat(context.markerFile), { code: 'ENOENT' }, 'Schema recovery marker remained after successful boot recovery');
  return recovered;
}

async function main(fixture) {
  const context = await adapters(fixture);
  await context.host.pullAndVerify(fixture.baseRelease);
  const blueQuadlet = path.join(fixture.quadletDirectory, 'codexia-slot-blue.container');
  const originalBlue = await readFile(path.join(fixture.root, 'original-blue.container'), 'utf8');
  assert.equal(await readFile(blueQuadlet, 'utf8'), originalBlue, 'Disposable writer source changed before schema recovery proof');
  const proxyUnit = 'codexia-api-proxy.service';
  try {
    await startProxy(fixture, context.host);
    await resetSchema(context.host, fixture.baseRelease);
    await context.host.startWriter('blue', fixture.baseRelease);
    const started = await launch(fixture, '--schema-transaction', 'before-write');
    assert.equal(started.signal, 'SIGKILL', `Pre-migration interruption missed its seam: ${started.stdout}\n${started.stderr}`);
    assert.equal(await context.host.routeState(), 'blocked');
    await proxyStatus(context.host, 503);
    const beforeFingerprint = await context.host.schemaFingerprint(fixture.baseRelease);
    assert.equal(beforeFingerprint, fixture.baseRelease.migrationFingerprint, 'Pre-write interruption changed the old schema');
    const lock = path.join(path.dirname(fixture.root), 'schema-maintenance.lock');
    const lockHolder = spawn('flock', ['--exclusive', '--nonblock', '--no-fork', lock, 'sleep', '30'], { stdio: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(lockHolder.exitCode, null, 'Schema lock holder exited before the contention probe');
    const contended = await launch(fixture, '--schema-recover', '');
    assert.notEqual(contended.status, 0, 'Boot recovery bypassed the held schema lock');
    assert.equal(await context.host.routeState(), 'blocked', 'Contended recovery changed the route');
    assert.ok((await lstat(context.markerFile)).isFile(), 'Contended recovery cleared the durable marker');
    lockHolder.kill('SIGTERM');
    await new Promise(resolve => lockHolder.once('exit', resolve));
    const beforeRecover = await launch(fixture, '--schema-recover', '');
    assert.equal(beforeRecover.status, 0, `Pre-write boot recovery failed: ${beforeRecover.stdout}\n${beforeRecover.stderr}`);
    const oldState = await loadControllerState(context.config.stateFile);
    assert.equal(oldState.installed.image, fixture.baseRelease.image, 'Pre-write recovery did not preserve the prior release');
    assert.equal((await context.host.observe()).writers[0]?.image, fixture.baseRelease.image, 'Pre-write recovery did not restore the old writer');
    assert.equal(await context.host.routeState(), 'blue');
    await context.host.probe('blue', fixture.baseRelease);

    await context.host.route('blocked');
    await proxyStatus(context.host, 503);
    await context.host.stopWriter('blue');
    await resetSchema(context.host, fixture.baseRelease);
    await context.host.startWriter('blue', fixture.baseRelease);
    await context.host.route('blue');
    const after = await launch(fixture, '--schema-transaction', 'after-write');
    assert.equal(after.signal, 'SIGKILL', `Post-migration interruption missed its seam: ${after.stdout}\n${after.stderr}`);
    assert.equal(await context.host.routeState(), 'blocked');
    await proxyStatus(context.host, 503);
    assert.equal(await context.host.schemaFingerprint(fixture.targetRelease), fixture.targetRelease.migrationFingerprint,
      'Post-write interruption did not leave the target schema committed');
    assert.deepEqual((await context.host.observe()).writers, [], 'Post-write interruption restarted a writer before boot recovery');
    const afterRecover = await launch(fixture, '--schema-recover', '');
    assert.equal(afterRecover.status, 0, `Post-write boot recovery failed: ${afterRecover.stdout}\n${afterRecover.stderr}`);
    const recovered = await loadControllerState(context.config.stateFile);
    assert.equal(recovered.installed.image, fixture.targetRelease.image, 'Post-write recovery did not commit the target release');
    assert.equal((await context.host.observe()).writers[0]?.image, fixture.targetRelease.image);
    assert.equal(await context.host.routeState(), 'blue');
    await context.host.probe('blue', fixture.targetRelease);
    const seed = run('podman', ['exec', 'codexia-db', 'sh', '-ec',
      'export PGPASSWORD="$(cat /run/secrets/admin-password)"; psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "SELECT value FROM public.codexia_schema_maintenance_seed WHERE id=\'fixture-seed\'"']);
    assert.equal(seed, 'preserve-me');
    console.log(JSON.stringify({ format: 'codexia-schema-maintenance-recovery-proof/v1',
      priorWriterRecoveredBeforeMigration: true, targetWriterRecoveredAfterMigration: true,
      startupRouteHeldBlockedUntilTargetReady: true, seedPreserved: true }));
  } finally {
    await context.host.stopWriter('blue').catch(() => undefined);
    try { execFileSync('systemctl', ['--user', 'stop', proxyUnit], { stdio: 'ignore' }); } catch {}
    for (const name of ['codexia-slot-blue', 'codexia-api-proxy']) {
      const exists = spawnSync('podman', ['container', 'exists', name], { stdio: 'ignore' });
      if (exists.status !== 0) continue;
      const [container] = JSON.parse(run('podman', ['inspect', '--type', 'container', name]));
      const id = canonicalLocalImageId(container.Image);
      if (container.Config?.Labels?.['codexia.runtime-contract-test'] === fixture.nonce &&
          [fixture.images.baseId, fixture.images.targetId].includes(id)) run('podman', ['rm', '--force', container.Id]);
    }
    await rm(blueQuadlet, { force: true });
    await writeFile(blueQuadlet, originalBlue, { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']);
  }
}

const mode = process.argv[2];
if (mode === '--schema-transaction') {
  const fixture = await fixtureFromArgs();
  await transactionRunner(fixture, process.argv[6]);
} else if (mode === '--schema-recover') {
  const fixture = await fixtureFromArgs();
  await recoveryRunner(fixture);
} else {
  const fixture = await fixtureFromArgs();
  await main(fixture);
}
