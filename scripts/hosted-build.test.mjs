import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODULE_PERSISTENCE_FORMATS, resolveBuildCatalogSelection } from '../packages/module-runtime/dist/index.js';
import { assertCleanRevisionSnapshot, browserArtifactRecords, browserManifestEntryFiles, calculateBuildDigests, canonicalJson, catalogFor, installedPnpmLockIdentity, persistenceForModules, validateHostedArtifactDirectory, resourceDeclarationFor } from './hosted-build.mjs';
import { assertSigstoreBundleMatches, assertSupportedCosignVersion, createSlsaStatement, pinnedCosignBinary, publishBundle } from './hosted-attestation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('hosted UI verification requires its own disposable database setting', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-hosted-ui-target-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, CODEXIA_DATABASE_URL: 'postgres://127.0.0.1/ordinary_runtime' };
  delete env.CODEXIA_TEST_DATABASE_URL;
  const result = spawnSync(process.execPath, ['scripts/verify-ui-hosted.mjs', '--package', directory, '--profile', 'no-addon'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set CODEXIA_TEST_DATABASE_URL to an isolated PostgreSQL database/u);
});

test('hosted artifact staging accepts only isolated build-specific paths under /tmp', () => {
  assert.equal(validateHostedArtifactDirectory(`/tmp/codexia-hosted-artifact-${'a'.repeat(32)}`), `/tmp/codexia-hosted-artifact-${'a'.repeat(32)}`);
  assert.equal(validateHostedArtifactDirectory(`/tmp/codexia-hosted-artifact-${'b'.repeat(64)}`), `/tmp/codexia-hosted-artifact-${'b'.repeat(64)}`);
  assert.throws(() => validateHostedArtifactDirectory('/tmp/codexia-hosted-artifact-fixed'), /Invalid hosted artifact/u);
  assert.throws(() => validateHostedArtifactDirectory('/tmp/escape'), /Invalid hosted artifact/u);
});

test('pinned cosign executes a private byte snapshot after digest and version validation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-pinned-cosign-'));
  let staged;
  try {
    const original = path.join(directory, 'cosign');
    const bytes = Buffer.from('#!/bin/sh\nprintf "GitVersion: v2.6.5\\n"\n');
    await writeFile(original, bytes, { mode: 0o700 });
    const pinned = await pinnedCosignBinary(original, 'v2.6.5', `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    staged = pinned;
    assert.notEqual(pinned.binary, original);
    await writeFile(original, '#!/bin/sh\nexit 93\n', { mode: 0o700 });
    assert.equal(execFileSync(pinned.binary, ['version'], { encoding: 'utf8' }).trim(), 'GitVersion: v2.6.5');
  } finally {
    if (staged) await staged.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test('provenance upload sends and reads back only the exact verified bundle bytes', async () => {
  const originalFetch = globalThis.fetch;
  const signedBundleBytes = Buffer.from('{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}');
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return options.method === 'PUT' ? new Response(null, { status: 201 }) : new Response(signedBundleBytes, { status: 200 });
  };
  try {
    assert.equal(await publishBundle('https://registry.example.test/bundles/sha256:abc', signedBundleBytes), 'https://registry.example.test/bundles/sha256:abc');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.method, 'PUT');
    assert.deepEqual(Buffer.from(requests[0].options.body), signedBundleBytes);
    assert.equal(requests[0].options.headers['if-none-match'], '*');
    assert.equal(requests[0].options.redirect, 'error');
    assert.equal(requests[1].options.redirect, 'error');
    await assert.rejects(publishBundle('http://registry.example.test/bundle', signedBundleBytes), /HTTPS URL/u);
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('hosted source inventory excludes developer performance symlinks without disabling source validation', async () => {
  // scripts/performance/podman is a tracked development-only symlink.
  // The hosted source digest must not traverse that unrelated directory.
  const digests = await calculateBuildDigests();
  assert.match(digests.sourceDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(digests.recipeDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(digests.lockDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('hosted browser artifact binding follows hashed Vite entry and stylesheet files', () => {
  assert.deepEqual(browserManifestEntryFiles({
    'index.html': { file: 'assets/index-AbCd1234.js', isEntry: true },
    'style.css': { file: 'assets/styles-EfGh5678.css' },
  }), {
    entryFile: 'assets/index-AbCd1234.js',
    stylesheetFiles: ['assets/styles-EfGh5678.css'],
  });
  assert.deepEqual(browserManifestEntryFiles({
    'index.html': { file: 'assets/index-AbCd1234.js', isEntry: true, css: ['assets/styles-EfGh5678.css'] },
  }), {
    entryFile: 'assets/index-AbCd1234.js',
    stylesheetFiles: ['assets/styles-EfGh5678.css'],
  });
  assert.throws(() => browserManifestEntryFiles({
    'index.html': { file: 'main.js', isEntry: true },
    'style.css': { file: 'styles.css' },
  }), /content-hashed application entry/u);
  assert.throws(() => browserManifestEntryFiles({
    'index.html': { file: 'assets/index-AbCd1234.js', isEntry: true },
    'style.css': { file: '../styles.css' },
  }), /content-hashed application stylesheet/u);
});

async function pnpmIdentityFixture(identities, { escapingTarget } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-pnpm-identity-'));
  const nodeModulesDirectory = path.join(directory, 'node_modules');
  const pnpmStore = path.join(nodeModulesDirectory, '.pnpm');
  const packageDirectory = escapingTarget ?? path.join(pnpmStore,
    '@scope+pkg@1.0.0_peer-one@1.0.0_peer-two@1.0.0_0123456789abcdef0123456789abcdef',
    'node_modules', '@scope', 'pkg');
  await mkdir(packageDirectory, { recursive: true });
  const linkPath = path.join(pnpmStore, 'node_modules', '@scope', 'pkg');
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(packageDirectory, linkPath, 'dir');
  await mkdir(nodeModulesDirectory, { recursive: true });
  const modulesYaml = [
    'hoistedDependencies:',
    ...identities.flatMap((identity) => [`  ${JSON.stringify(identity)}:`, '    "@scope/pkg": private']),
  ].join('\n');
  await writeFile(path.join(nodeModulesDirectory, '.modules.yaml'), `${modulesYaml}\n`);
  return {
    directory,
    nodeModulesDirectory,
    packageDirectory,
    lock: { snapshots: Object.fromEntries(identities.map((identity) => [identity, {}])) },
  };
}

test('pnpm shortened virtual-store names resolve only through the unique full installer lock identity', async () => {
  const identity = '@scope/pkg@1.0.0(peer-one@1.0.0)(peer-two@1.0.0)';
  const fixture = await pnpmIdentityFixture([identity]);
  try {
    assert.equal(await installedPnpmLockIdentity({
      nodeModulesDirectory: fixture.nodeModulesDirectory,
      packageName: '@scope/pkg',
      packageVersion: '1.0.0',
      packageDirectory: fixture.packageDirectory,
      lock: fixture.lock,
    }), identity);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('pnpm installer metadata refuses missing, ambiguous, and escaping lock identities', async () => {
  const valid = '@scope/pkg@1.0.0(peer-one@1.0.0)';
  const other = '@scope/pkg@1.0.0(peer-two@1.0.0)';
  const missing = await pnpmIdentityFixture([valid]);
  try {
    assert.equal(await installedPnpmLockIdentity({
      nodeModulesDirectory: missing.nodeModulesDirectory,
      packageName: '@scope/pkg',
      packageVersion: '1.0.0',
      packageDirectory: missing.packageDirectory,
      lock: { snapshots: {} },
    }), null, 'an installer key absent from the source lock cannot be trusted');
  } finally {
    await rm(missing.directory, { recursive: true, force: true });
  }

  const ambiguous = await pnpmIdentityFixture([valid, other]);
  try {
    await assert.rejects(installedPnpmLockIdentity({
      nodeModulesDirectory: ambiguous.nodeModulesDirectory,
      packageName: '@scope/pkg',
      packageVersion: '1.0.0',
      packageDirectory: ambiguous.packageDirectory,
      lock: ambiguous.lock,
    }), /ambiguous lock snapshot metadata/u);
  } finally {
    await rm(ambiguous.directory, { recursive: true, force: true });
  }

  const escapedRoot = await mkdtemp(path.join(tmpdir(), 'codexia-pnpm-identity-escape-'));
  const escaped = await pnpmIdentityFixture([valid], { escapingTarget: path.join(escapedRoot, 'outside') });
  try {
    await assert.rejects(installedPnpmLockIdentity({
      nodeModulesDirectory: escaped.nodeModulesDirectory,
      packageName: '@scope/pkg',
      packageVersion: '1.0.0',
      packageDirectory: escaped.packageDirectory,
      lock: escaped.lock,
    }), /escapes the pnpm virtual store/u);
  } finally {
    await rm(escaped.directory, { recursive: true, force: true });
    await rm(escapedRoot, { recursive: true, force: true });
  }
});

async function shippedModuleData() {
  const entries = await readdir(path.join(root, 'modules'), { withFileTypes: true });
  const moduleIds = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const trustedModules = await Promise.all(moduleIds.map(async (id) => {
    const bytes = await readFile(path.join(root, 'modules', id, 'package.json'));
    const packageManifest = JSON.parse(bytes.toString('utf8'));
    const manifest = packageManifest.codexiaModule;
    const display = packageManifest.codexiaDisplay;
    return {
      manifest,
      display,
      artifactDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      contractRange: '^1',
      conflicts: [],
      ...resourceDeclarationFor(manifest),
    };
  }));
  const catalog = catalogFor({
    producerRevision: 'a'.repeat(40),
    runtimeBaseDigest: `sha256:${'1'.repeat(64)}`,
    buildKitDigest: `sha256:${'2'.repeat(64)}`,
    recipeDigest: `sha256:${'3'.repeat(64)}`,
    lockDigest: `sha256:${'4'.repeat(64)}`,
    sourceDigest: `sha256:${'5'.repeat(64)}`,
  }, trustedModules);
  for (const module of catalog.modules) {
    const display = trustedModules.find(({ manifest }) => manifest.id === module.id).display;
    assert.equal(module.name, display.name);
    assert.equal(module.description, display.description);
  }
  const alteredDisplayCatalog = {
    ...catalog,
    modules: catalog.modules.map((module) => module.id === 'mcp' ? { ...module, name: 'Untrusted label' } : module),
  };
  assert.throws(() => resolveBuildCatalogSelection(alteredDisplayCatalog, [], trustedModules), /differs from the shipped module manifest/u);
  const historicalCatalog = {
    ...catalog,
    modules: catalog.modules.map(({ name: _name, description: _description, ...module }) => module),
  };
  assert.deepEqual(resolveBuildCatalogSelection(historicalCatalog, [], trustedModules).resolvedModules, []);
  return { catalog, trustedModules, moduleIds };
}

test('composition persistence declares base and selected module readers/writers only', () => {
  const persistence = persistenceForModules(['publishing', 'story'], MODULE_PERSISTENCE_FORMATS);
  const readable = new Map(persistence.readable.map(({ formatId, versions }) => [formatId, versions]));
  const writable = new Set(persistence.writable.map(({ formatId, version }) => `${formatId}@${version}`));

  assert.deepEqual(readable.get('scriptorium.git-operations'), [1]);
  assert.deepEqual(readable.get('scriptorium.git-proposal-legacy'), [1]);
  assert.deepEqual(readable.get('scriptorium.browser-recovery-indexeddb'), [3]);
  assert.deepEqual(readable.get('scriptorium.module-story.series'), [1]);
  assert.deepEqual(readable.get('scriptorium.module-publishing.cover'), [1]);
  assert.equal(readable.has('scriptorium.module-story.change-sets'), false);
  assert.equal(readable.has('scriptorium.module-assistant.model-settings'), false);
  assert.equal(writable.has('scriptorium.module-publishing.cover@1'), false);
  assert.equal(writable.has('scriptorium.module-story.series@1'), true);
  assert.equal(persistence.contractVersion, 'codexia-persistence/v1');
});

test('composition persistence rejects duplicate module selections', () => {
  assert.throws(() => persistenceForModules(['story', 'story'], MODULE_PERSISTENCE_FORMATS), /unique/u);
});

test('hosted resource catalog covers Core, worker closures, and the full shipped selection', async () => {
  const { catalog, trustedModules, moduleIds } = await shippedModuleData();
  const resourceKeys = ['cpuMilli', 'memoryMiB', 'ephemeralStorageMiB'];
  const [small, balanced, large] = catalog.resourceProfiles;
  assert.deepEqual(catalog.resourceProfiles.map(({ id }) => id), ['small', 'balanced', 'large']);
  for (const key of resourceKeys) {
    assert.ok(catalog.baseResources[key] > 0, `Core declares ${key}`);
    assert.ok(small[key] < balanced[key] && balanced[key] < large[key], `Tiers increase ${key}`);
  }
  assert.deepEqual(catalog.modules.find(({ id }) => id === 'story').sharedResourceGroupIds, []);
  assert.deepEqual(catalog.modules.find(({ id }) => id === 'mcp').sharedResourceGroupIds, []);
  assert.deepEqual(catalog.modules.find(({ id }) => id === 'nlp').sharedResourceGroupIds, ['worker-runtime']);
  assert.deepEqual(catalog.modules.find(({ id }) => id === 'semantic').sharedResourceGroupIds, ['semantic-models', 'worker-runtime']);
  const limits = catalog.modules.find(({ id }) => id === 'nlp').workerLimits;
  for (const key of ['maxConcurrentJobs', 'maxQueuedJobs', 'maxWorkerServices', 'maxConcurrentServiceJobs', 'maxQueuedServiceJobs']) {
    assert.ok(Number.isSafeInteger(limits[key]) && limits[key] > 0, `${key} is bounded`);
  }
  for (const module of catalog.modules) {
    assert.deepEqual(module.workerLimits, trustedModules.find(({ manifest }) => manifest.id === module.id).manifest.workerEntry ? limits : {});
  }

  const core = resolveBuildCatalogSelection(catalog, [], trustedModules);
  assert.deepEqual(core.resourceRequirements, catalog.baseResources);
  const storyAndMcp = resolveBuildCatalogSelection(catalog, ['story', 'mcp'], trustedModules);
  assert.deepEqual(storyAndMcp.resourceRequirements, catalog.baseResources);
  for (const requirements of [core.resourceRequirements, storyAndMcp.resourceRequirements]) {
    for (const key of resourceKeys) {
      assert.ok(requirements[key] <= small[key], `Core/add-on selection fits small ${key} allocation`);
    }
  }

  const tokenizer = resolveBuildCatalogSelection(catalog, ['nlp'], trustedModules);
  const tokenizerAndSpeaker = resolveBuildCatalogSelection(catalog, ['nlp', 'speaker'], trustedModules);
  assert.ok(tokenizer.resourceRequirements.memoryMiB > core.resourceRequirements.memoryMiB);
  assert.deepEqual(tokenizerAndSpeaker.resourceRequirements, tokenizer.resourceRequirements, 'worker modules share one runtime allocation');
  const semantic = resolveBuildCatalogSelection(catalog, ['semantic'], trustedModules);
  assert.ok(semantic.resourceRequirements.memoryMiB > tokenizer.resourceRequirements.memoryMiB);
  assert.ok(semantic.resourceRequirements.ephemeralStorageMiB > tokenizer.resourceRequirements.ephemeralStorageMiB);
  const full = resolveBuildCatalogSelection(catalog, moduleIds, trustedModules);
  assert.deepEqual(full.resolvedModules.map(({ id }) => id).sort(), moduleIds);
  assert.deepEqual(full.resourceRequirements, semantic.resourceRequirements);
  for (const key of resourceKeys) {
    assert.ok(full.resourceRequirements[key] <= large[key], `full closure fits large ${key} allocation`);
  }
  assert.ok(full.resourceRequirements.memoryMiB > balanced.memoryMiB);
});

const hostedRevision = '1'.repeat(40);
const runtimeBaseDigest = `sha256:${'a'.repeat(64)}`;
const buildKitDigest = `sha256:${'b'.repeat(64)}`;
const sourceDigest = `sha256:${'c'.repeat(64)}`;
const recipeDigest = `sha256:${'d'.repeat(64)}`;
const lockDigest = `sha256:${'e'.repeat(64)}`;

function hostedAttestationFixture() {
  const catalog = {
    contractVersion: 'codexia-build/v1',
    producerRevision: hostedRevision,
    runtimeBaseDigest,
    buildKitDigest,
    sourceDigest,
    recipeDigest,
    lockDigest,
  };
  const runtimeMetadata = { contractVersion: 'scriptorium-platform/v1', producerRevision: hostedRevision };
  const catalogBytes = Buffer.from(canonicalJson(catalog), 'utf8');
  const runtimeMetadataBytes = Buffer.from(canonicalJson(runtimeMetadata), 'utf8');
  const statement = createSlsaStatement({
    producerRevision: hostedRevision,
    runtimeBaseImage: `ghcr.io/yohn-jp/codexia/runtime-base@${runtimeBaseDigest}`,
    buildKitImage: `ghcr.io/yohn-jp/codexia/build-kit@${buildKitDigest}`,
    catalog,
    runtimeMetadata,
    catalogBytes,
    runtimeMetadataBytes,
    sourceDigests: { sourceDigest, recipeDigest, lockDigest },
    startedOn: '2026-10-17T00:00:00.000Z',
    finishedOn: '2026-10-17T00:00:01.000Z',
    invocationId: 'urn:uuid:acb3c4d5-abcdef01-2345-6789-abcdef012345',
  });
  return { catalog, runtimeMetadata, catalogBytes, runtimeMetadataBytes, statement };
}

test('SLSA statement has exactly the signed Runtime Base and canonical metadata subjects', () => {
  const { catalogBytes, runtimeMetadataBytes, statement } = hostedAttestationFixture();
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(statement.subject, [
    { name: 'ghcr.io/yohn-jp/codexia/runtime-base', digest: { sha256: 'a'.repeat(64) } },
    { name: 'codexia-build/v1/catalog.json', digest: { sha256: digest(catalogBytes) } },
    { name: 'scriptorium-platform/v1/runtime-metadata.json', digest: { sha256: digest(runtimeMetadataBytes) } },
  ]);
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
  assert.equal(statement.predicateType, 'https://slsa.dev/provenance/v1');
  assert.equal(statement.predicate.buildDefinition.buildType, `https://github.com/yohn-jp/codexia/blob/${hostedRevision}/Dockerfile`);
  assert.ok(statement.predicate.buildDefinition.resolvedDependencies.some((item) =>
    item.uri === 'git+https://github.com/yohn-jp/codexia' && item.digest.gitCommit === hostedRevision));
  assert.ok(statement.predicate.buildDefinition.resolvedDependencies.some((item) =>
    item.uri === 'https://github.com/yohn-jp/codexia/source-inventory/v1' && item.digest.sha256 === 'c'.repeat(64)));
  assert.ok(statement.predicate.buildDefinition.resolvedDependencies.some((item) =>
    item.uri === 'oci://ghcr.io/yohn-jp/codexia/build-kit' && item.digest.sha256 === 'b'.repeat(64)));
});

test('SLSA construction rejects image, metadata, source digest, or revision mismatches', () => {
  const input = hostedAttestationFixture();
  const make = (changes = {}) => createSlsaStatement({
    producerRevision: hostedRevision,
    runtimeBaseImage: `ghcr.io/yohn-jp/codexia/runtime-base@${runtimeBaseDigest}`,
    buildKitImage: `ghcr.io/yohn-jp/codexia/build-kit@${buildKitDigest}`,
    catalog: input.catalog,
    runtimeMetadata: input.runtimeMetadata,
    catalogBytes: input.catalogBytes,
    runtimeMetadataBytes: input.runtimeMetadataBytes,
    sourceDigests: { sourceDigest, recipeDigest, lockDigest },
    ...changes,
  });
  assert.throws(() => make({ producerRevision: '2'.repeat(40) }), /producer revision|catalog does not bind/u);
  assert.throws(() => make({ runtimeBaseImage: `ghcr.io/yohn-jp/codexia/runtime-base@sha256:${'f'.repeat(64)}` }), /catalog does not bind/u);
  assert.throws(() => make({ buildKitImage: `ghcr.io/yohn-jp/codexia/build-kit@sha256:${'f'.repeat(64)}` }), /catalog does not bind/u);
  assert.throws(() => make({ sourceDigests: { sourceDigest: `sha256:${'f'.repeat(64)}`, recipeDigest, lockDigest } }), /sourceDigest/u);
  assert.throws(() => make({ runtimeMetadata: { ...input.runtimeMetadata, producerRevision: '2'.repeat(40) } }), /runtime metadata/u);
});

test('source must be the clean checked-out commit named by the catalog', () => {
  assert.doesNotThrow(() => assertCleanRevisionSnapshot({ head: hostedRevision, status: '', producerRevision: hostedRevision }));
  assert.throws(() => assertCleanRevisionSnapshot({ head: hostedRevision, status: ' M scripts/hosted-build.mjs\n', producerRevision: hostedRevision }), /clean producer checkout/u);
  assert.throws(() => assertCleanRevisionSnapshot({ head: hostedRevision, status: '', producerRevision: '2'.repeat(40) }), /checked out Git HEAD/u);
});

test('unsigned or altered fake Sigstore bundle is rejected before it can be published', () => {
  const { statement } = hostedAttestationFixture();
  const statementBytes = Buffer.from(canonicalJson(statement), 'utf8');
  const unsigned = {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      certificate: { rawBytes: 'ZmFrZQ==' },
      tlogEntries: [{ logId: { keyId: 'ZmFrZQ==' }, kindVersion: { kind: 'dsse', version: '0.0.1' }, inclusionProof: { checkpoint: { envelope: 'ZmFrZQ==' } } }],
    },
    dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: statementBytes.toString('base64'), signatures: [] },
  };
  assert.throws(() => assertSigstoreBundleMatches(unsigned, statementBytes), /unsigned/u);
  assert.throws(() => assertSigstoreBundleMatches({
    ...unsigned,
    dsseEnvelope: { ...unsigned.dsseEnvelope, signatures: [{ sig: 'ZmFrZQ==' }] },
  }, Buffer.from('{}')), /exact canonical SLSA statement/u);
});

test('Cosign identity verification rejects versions affected by GHSA-fx35-mq7g-6g98', () => {
  assert.throws(() => assertSupportedCosignVersion('v2.6.4'), /GHSA-fx35-mq7g-6g98/u);
  assert.doesNotThrow(() => assertSupportedCosignVersion('v2.6.5'));
  assert.doesNotThrow(() => assertSupportedCosignVersion('2.7.0'));
  assert.throws(() => assertSupportedCosignVersion('v3.1.2'), /GHSA-fx35-mq7g-6g98/u);
  assert.doesNotThrow(() => assertSupportedCosignVersion('v3.1.3'));
  assert.doesNotThrow(() => assertSupportedCosignVersion('v3.2.0'));
  assert.throws(() => assertSupportedCosignVersion('v2.6.5-rc.1'), /GHSA-fx35-mq7g-6g98/u);
  assert.throws(() => assertSupportedCosignVersion('v4.0.0'), /GHSA-fx35-mq7g-6g98/u);
});


test('browser artifacts bind the selected module closure to every reachable UI entry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-browser-closure-'));
  const source = '../modules/story/dist/browser.js';
  const manifests = new Map();
  async function assertRecordedAssets(records) {
    const expected = (await Promise.all(['', 'desktop', 'mobile', 'oauth'].map(async ui => {
      const assets = path.posix.join('app/dist', ui, 'assets');
      return Promise.all((await readdir(path.join(directory, assets))).map(async file => ({
        path: path.posix.join('/app', assets, file),
        sha256: `sha256:${createHash('sha256').update(await readFile(path.join(directory, assets, file))).digest('hex')}`,
      })));
    }))).flat();
    const byPath = (left, right) => left.path.localeCompare(right.path);
    assert.deepEqual(records.files.toSorted(byPath), expected.sort(byPath));
  }
  async function emit(ui, withModule, modern = false) {
    const output = path.join(directory, 'app/dist', ui);
    await mkdir(path.join(output, '.vite'), { recursive: true });
    await mkdir(path.join(output, 'assets'), { recursive: true });
    const manifest = {
      'index.html': { file: 'assets/index-AbCd1234.js', isEntry: true, css: ['assets/styles-EfGh5678.css'],
        dynamicImports: [...(modern && ui ? ['index.html'] : []), ...(withModule ? [source] : [])],
        ...(modern && ui ? { imports: ['_shared.js'] } : {}),
      },
      ...(modern && ui ? { '_shared.js': { file: 'assets/shared-AbCd1234.js' } } : {}),
      ...(withModule ? { [source]: { file: 'assets/story-AbCd1234.js', isDynamicEntry: true, src: source } } : {}),
    };
    for (const file of ['assets/index-AbCd1234.js', 'assets/styles-EfGh5678.css', ...(withModule ? ['assets/story-AbCd1234.js'] : []), ...(modern && ui ? ['assets/shared-AbCd1234.js'] : [])]) {
      await writeFile(path.join(output, file), `/* fixture ${ui}/${file} */`);
    }
    await writeFile(path.join(output, '.vite/manifest.json'), JSON.stringify(manifest));
    manifests.set(ui, manifest);
  }
  async function emitOAuth() {
    const output = path.join(directory, 'app/dist/oauth');
    await mkdir(path.join(output, '.vite'), { recursive: true });
    await mkdir(path.join(output, 'assets'), { recursive: true });
    const manifest = {
      'oauth-login.html': { file: 'assets/login-AbCd1234.js', isEntry: true, imports: ['_oauth.js'],
        css: ['assets/styles-EfGh5678.css'] },
      'oauth-consent.html': { file: 'assets/consent-AbCd1234.js', isEntry: true, imports: ['_oauth.js'],
        css: ['assets/styles-EfGh5678.css'] },
      '_oauth.js': { file: 'assets/oauth-AbCd1234.js' },
    };
    const files = new Set(Object.values(manifest).flatMap(({ file, css = [] }) => [file, ...css]));
    for (const file of files) await writeFile(path.join(output, file), '/* OAuth fixture */');
    await writeFile(path.join(output, '.vite/manifest.json'), JSON.stringify(manifest));
  }
  try {
    await emit('', true);
    await emit('desktop', true);
    await emit('mobile', true);
    await emitOAuth();
    const records = await browserArtifactRecords(directory, ['story']);
    await assertRecordedAssets(records);
    assert.ok(records.files.some(({ path: name }) => name === '/app/app/dist/oauth/assets/login-AbCd1234.js'));
    assert.ok(records.files.some(({ path: name }) => name === '/app/app/dist/oauth/assets/consent-AbCd1234.js'));
    const desktopAssets = path.join(directory, 'app/dist/desktop/assets');
    const unexpectedScript = path.join(desktopAssets, 'unexpected-AbCd1234.js');
    await writeFile(unexpectedScript, '/* unexpected fixture */');
    await assert.rejects(browserArtifactRecords(directory, ['story']), /outside its manifest/);
    await rm(unexpectedScript);
    const unexpectedOAuthScript = path.join(directory, 'app/dist/oauth/assets/extra-AbCd1234.js');
    await writeFile(unexpectedOAuthScript, '/* untracked OAuth script */');
    await assert.rejects(browserArtifactRecords(directory, ['story']), /outside its manifest/u);
    await rm(unexpectedOAuthScript);
    await emit('desktop', false);
    await assert.rejects(browserArtifactRecords(directory, ['story']), /different browser module closure/);
    await emit('desktop', true);
    await emit('mobile', false);
    await assert.rejects(browserArtifactRecords(directory, ['story']), /different browser module closure/);
    await emit('mobile', true);
    const launcher = manifests.get('');
    launcher['index.html'].dynamicImports = [];
    await writeFile(path.join(directory, 'app/dist/.vite/manifest.json'), JSON.stringify(launcher));
    await assert.rejects(browserArtifactRecords(directory, ['story']), /different browser module closure/);
    // Vite 8/Rolldown may refer back to its own index.html entry and list a
    // shared chunk as an asset. It remains closed over the expected app entry
    // and selected browser modules.
    await emit('', true, true);
    await emit('desktop', true, true);
    await emit('mobile', true, true);
    const modernRecords = await browserArtifactRecords(directory, ['story']);
    await assertRecordedAssets(modernRecords);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
