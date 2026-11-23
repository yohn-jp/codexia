import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInventory } from './artifacts.mjs';
import { buildIdentity, hashTree, sourceIdentity, writeNewJsonResult } from './common.mjs';
import { generate } from './dataset.mjs';
import { startFixture } from './k6-fixture.mjs';

const exec = promisify(execFile);
const postgresImage = 'docker.io/library/postgres@sha256:223efeb196329b55b3b9a13db144956411dbc18e727e59f681c3e0aede6475cf';
const docker = (args, env) => exec('docker', ['--host', 'unix:///var/run/docker.sock', ...args],
  { timeout: 60_000, env });
const k6Version = '2.4.0';
const sha256 = content => createHash('sha256').update(content).digest('hex');
const scripts = ['k6-run.mjs', 'k6-fixture.mjs', 'k6-target.mjs', 'k6-scenarios.js'];
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

async function run() {
  const [profile, outputPath, binaryPath, ...extra] = process.argv.slice(2);
  if (!['smoke', 'measurement'].includes(profile) || !outputPath || !binaryPath || extra.length) {
    throw new Error('Usage: node scripts/performance/k6-run.mjs (smoke|measurement) NEW_OUTPUT K6_BINARY');
  }
  const repository = await realpath(join(scriptDirectory, '../..'));
  if (await realpath(process.cwd()) !== repository) throw new Error('Run from the repository root');
  const output = join(await realpath(dirname(resolve(outputPath))), basename(resolve(outputPath)));
  const outputRelative = relative(repository, output);
  if (!(outputRelative === '..' || outputRelative.startsWith('..' + sep) || isAbsolute(outputRelative))) {
    throw new Error('Write k6 evidence outside the repository checkout');
  }
  const binary = await realpath(resolve(binaryPath));
  const k6Environment = { PATH: process.env.PATH, XDG_CONFIG_HOME: output };
  const { stdout: version } = await exec(binary, ['version'], { env: k6Environment, timeout: 5_000 });
  if (version.split(/\s+/u)[1] !== `v${k6Version}`) throw new Error(`This fixture requires k6 v${k6Version}`);
  const { postgresFixture } = await import('./postgres-fixture.mjs');

  await mkdir(output, { mode: 0o700 });
  const startedAt = new Date().toISOString();
  const source = sourceIdentity();
  const [build, contracts, persistenceContracts] = await Promise.all([
    buildIdentity(),
    hashTree('packages/contracts/dist'),
    hashTree('packages/persistence-contracts/dist'),
  ]);
  build[contracts.root] = contracts;
  build[persistenceContracts.root] = persistenceContracts;
  const scriptHashes = Object.fromEntries(await Promise.all(scripts.map(async file =>
    [file, sha256(await readFile(join(scriptDirectory, file)))])));
  const datasetPath = join(output, 'dataset');
  const dataset = await generate(datasetPath, 'small');
  await writeNewJsonResult(join(output, 'dataset.json'), dataset);
  const databaseName = 'codexia_perf_k6';
  const container = `codexia-perf-k6-${randomBytes(12).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error('Synthetic run interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let containerStarted = false;
  let seeded, fixture;
  try {
    await docker(['create', '--name', container, '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_USER=codexia', '--env', 'POSTGRES_PASSWORD',
      '--env', `POSTGRES_DB=${databaseName}`, postgresImage], { ...process.env, POSTGRES_PASSWORD: password });
    containerStarted = true;
    await docker(['start', container]);
    const { stdout: portMapping } = await docker(['port', container, '5432/tcp']);
    const port = /^127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(portMapping.trim())?.[1];
    if (!port || Number(port) > 65535) throw new Error('Expected one Docker PostgreSQL loopback port');
    for (let attempt = 1; ; attempt++) {
      stop.signal.throwIfAborted();
      try {
        await docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'codexia', '-d', databaseName]);
        break;
      } catch {
        if (attempt === 40) throw new Error('Disposable PostgreSQL did not become ready');
        await delay(500, undefined, { signal: stop.signal });
      }
    }

    process.env.CODEXIA_TEST_DATABASE_URL = `postgres://codexia:${password}@127.0.0.1:${port}/${databaseName}`;
    process.env.CODEXIA_PERF_POOL_MAX = '4';
    seeded = await postgresFixture(datasetPath);
    const { document, revision } = seeded.historyTarget;
    fixture = await startFixture(async () => {
      const row = await seeded.persistence.read(reader => reader.getRevision(seeded.project.id, document.id, revision.id));
      if (!row) throw new Error('Missing synthetic revision');
      return row.markdown;
    });
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    stop.signal.throwIfAborted();
    const child = spawn(binary, ['run', '--quiet', '--include-system-env-vars',
      '--out', `json=${join(output, 'k6-samples.jsonl')}`, '--summary-export', join(output, 'k6-summary.json'),
      join(scriptDirectory, 'k6-scenarios.js')], {
      stdio: 'inherit',
      env: { ...k6Environment, CODEXIA_K6_ORIGIN: fixture.origin, CODEXIA_K6_TOKEN: fixture.token,
        CODEXIA_K6_SCENE_SHA256: sha256(revision.markdown), CODEXIA_K6_PROFILE: profile, K6_NO_USAGE_REPORT: 'true' },
      signal: stop.signal,
    });
    const [exitCode, signal] = await once(child, 'close');
    const application = {
      rssBeforeBytes: rssBefore,
      rssAfterBytes: process.memoryUsage().rss,
      processLifetimeMaxRssKiB: process.resourceUsage().maxRSS,
      cpuDuringK6Us: process.cpuUsage(cpuBefore),
    };
    await writeNewJsonResult(join(output, 'run.json'), {
      profile, startedAt, finishedAt: new Date().toISOString(), source, build, scriptHashes,
      toolchain: { k6: version.trim(), k6BinarySha256: sha256(await readFile(binary)), node: process.version },
      host: { platform: platform(), arch: arch(), release: release(), logicalCpus: cpus().length },
      fixtureId: dataset.fixtureId, setupMs: seeded.setupMs, inventory: seeded.inventory,
      database: { image: postgresImage, ...seeded.database },
      application,
      k6: { exitCode, signal },
    });
    if (exitCode !== 0 || signal !== null) throw new Error(`k6 exited with ${exitCode ?? signal}; evidence is in ${output}`);
    await createInventory(output, ['dataset.json', 'k6-samples.jsonl', 'k6-summary.json', 'run.json'], join(output, 'inventory.json'));
    console.log(`Synthetic k6 ${profile} evidence: ${output}`);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    try {
      if (fixture) {
        const closed = once(fixture.server, 'close');
        fixture.server.close();
        await closed;
      }
      await seeded?.persistence.close();
    } finally {
      if (containerStarted) await docker(['rm', '--force', '--volumes', container]);
    }
  }
}

await run();
