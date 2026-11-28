#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoPublicSecrets,
  LIKEC4_GENERATOR,
  LIKEC4_SOURCE_PATH,
  LIKEC4_VERSION,
  REQUIRED_RISK_CHECK_IDS,
  REQUIRED_RISK_IDS,
  validateLikeC4Export,
  validateThreatModelCheckIds,
  validateThreatRisks,
  validateArchitectureView,
} from './contract.mjs';
import { THREAGILE_IMAGE } from './constants.mjs';
export const THREAT_MODEL_PATH = 'docs/architecture/threagile/model.yaml';
export const THREAT_MODEL_DOC_PATH = 'docs/architecture/THREAT-MODEL.sdoc';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIKEC4_BIN = join(ROOT, 'scripts/architecture/node_modules/.bin/likec4');
const DOCKER_TIMEOUT = 120_000;
const LIKEC4_TIMEOUT = 90_000;

/** @param {string} file */
function sha256File(file) {
  return createHash('sha256').update(file).digest('hex');
}

/** @param {string} file */
async function sha256Path(file) {
  return sha256File(await readFile(file));
}

/** @param {string} executable @param {string[]} args @param {{cwd?: string, timeout?: number}} [options] */
function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? LIKEC4_TIMEOUT,
    maxBuffer: 12 * 1024 * 1024,
  });
}

/** @param {string} dockerBin @param {string} modelFile @param {string} outputDirectory */
function runThreagile(dockerBin, modelFile, outputDirectory) {
  // The parent scratch directory is private (0700); use its owner's UID/GID
  // rather than the non-root UID baked into the pinned Threagile image.
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  assert.ok(Number.isSafeInteger(uid) && Number.isSafeInteger(gid),
    'Threagile requires a Unix host UID/GID for private evidence mounts');
  return run(dockerBin, [
    'run', '--rm', '--network', 'none', '--read-only',
    '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--mount', `type=bind,src=${resolve(modelFile)},dst=/model.yaml,readonly`,
    '--mount', `type=bind,src=${resolve(outputDirectory)},dst=/output`,
    THREAGILE_IMAGE,
    '-model', '/model.yaml', '-output', '/output',
    '-generate-report-pdf=false',
    '-generate-risks-excel=false',
    '-generate-tags-excel=false',
    '-generate-data-flow-diagram=false',
    '-generate-data-asset-diagram=false',
    '-generate-risks-json=true',
    '-generate-stats-json=true',
    '-generate-technical-assets-json=true',
  ], { timeout: DOCKER_TIMEOUT });
}

/** @param {string} label @param {() => unknown} action @param {RegExp} expected */
function expectRejection(label, action, expected) {
  let message = '';
  try {
    action();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, expected, `${label} failure injection was not rejected as expected`);
  return { id: label, status: 'REJECTED', reason: message };
}

/** @param {string} evidenceDirectory @param {{root?: string, likec4Bin?: string, dockerBin?: string}} [options] */
export async function verifyArchitecture(evidenceDirectory, options = {}) {
  const root = resolve(options.root ?? ROOT);
  const likec4Bin = resolve(options.likec4Bin ?? LIKEC4_BIN);
  const dockerBin = options.dockerBin ?? process.env.DOCKER_BIN ?? 'docker';
  const evidence = resolve(evidenceDirectory);
  const evidenceRelativeToRoot = relative(root, evidence);
  assert.ok(evidenceRelativeToRoot && (evidenceRelativeToRoot.startsWith('..') || isAbsolute(evidenceRelativeToRoot)),
    'Architecture evidence output must be outside the repository');

  const sourceSha = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
  assert.match(sourceSha, /^[a-f0-9]{40}$/u, 'Expected an exact checked-out source SHA');
  const dirty = run('git', ['status', '--porcelain=v1'], { cwd: root }).trim();
  assert.equal(dirty, '', 'G5 exact-source verification requires a clean checkout');

  const modelFile = join(root, LIKEC4_SOURCE_PATH);
  const threatModelFile = join(root, THREAT_MODEL_PATH);
  const designFile = join(root, 'docs/architecture/SYSTEM-DESIGN.sdoc');
  const threatDocFile = join(root, THREAT_MODEL_DOC_PATH);
  const toolLockFile = join(root, 'scripts/architecture/package-lock.json');
  const modelSource = await readFile(modelFile, 'utf8');
  const threatModel = await readFile(threatModelFile, 'utf8');
  const publicDesign = await readFile(designFile, 'utf8');
  const threatDoc = await readFile(threatDocFile, 'utf8');
  assertNoPublicSecrets([modelSource, threatModel, publicDesign, threatDoc]);
  validateThreatModelCheckIds(threatModel);

  const likec4Version = run(likec4Bin, ['--version']).trim();
  assert.equal(likec4Version, LIKEC4_VERSION, 'LikeC4 binary does not match the isolated lock');
  run(likec4Bin, ['validate', '--max-warnings', '0', join(root, 'docs/architecture/likec4')]);

  const temp = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'codexia-architecture-g5-'));
  try {
    const exportFile = join(temp, 'likec4-export.json');
    run(likec4Bin, [
      'export', 'json', '--pretty', '--skip-layout', '-o', exportFile,
      join(root, 'docs/architecture/likec4'),
    ]);

    const modelExport = JSON.parse(await readFile(exportFile, 'utf8'));
    validateLikeC4Export(modelExport);
    const architectureView = validateArchitectureView(modelExport.views);

    const invalidModelDir = join(temp, 'invalid-boundary');
    await mkdir(invalidModelDir);
    const boundaryAnchor = "fastify = container 'Fastify API admission' {\n      #application\n      metadata { trustBoundary 'application' }";
    const injectedModel = modelSource.replace(boundaryAnchor,
      "fastify = container 'Fastify API admission' {\n      #application\n      metadata { trustBoundary 'edge' }");
    assert.notEqual(injectedModel, modelSource, 'Trust boundary failure injection target was not found');
    await writeFile(join(invalidModelDir, 'model.likec4'), injectedModel);
    run(likec4Bin, ['validate', '--max-warnings', '0', invalidModelDir]);
    const injectedExport = join(temp, 'invalid-boundary.json');
    run(likec4Bin, ['export', 'json', '--pretty', '--skip-layout', '-o', injectedExport, invalidModelDir]);
    const invalidBoundaryExport = JSON.parse(await readFile(injectedExport, 'utf8'));
    const boundaryControl = expectRejection('invalid-trust-boundary', () =>
      validateLikeC4Export(invalidBoundaryExport),
    /trust boundary application/u);

    const invalidOperationsDir = join(temp, 'invalid-operations-route');
    await mkdir(invalidOperationsDir);
    const operationsRouteAnchor = "  author -> web 'Writes through the authoring UI'";
    const injectedOperationsRoute = modelSource.replace(operationsRouteAnchor,
      `${operationsRouteAnchor}\n  web -> codexia.ssh 'Unapproved direct host shell'`);
    assert.notEqual(injectedOperationsRoute, modelSource,
      'Protected operations route failure injection target was not found');
    await writeFile(join(invalidOperationsDir, 'model.likec4'), injectedOperationsRoute);
    run(likec4Bin, ['validate', '--max-warnings', '0', invalidOperationsDir]);
    const injectedOperationsExportFile = join(temp, 'invalid-operations-route.json');
    run(likec4Bin, [
      'export', 'json', '--pretty', '--skip-layout', '-o', injectedOperationsExportFile,
      invalidOperationsDir,
    ]);
    const invalidOperationsExport = JSON.parse(await readFile(injectedOperationsExportFile, 'utf8'));
    const operationsRouteControl = expectRejection('public-to-protected-operations-route', () =>
      validateLikeC4Export(invalidOperationsExport),
    /web -> codexia\.ssh/u);

    const imageDigest = execFileSync(dockerBin, [
      'image', 'inspect', '--format', '{{index .RepoDigests 0}}', THREAGILE_IMAGE,
    ], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    assert.equal(imageDigest, THREAGILE_IMAGE.replace(/^docker\.io\//u, ''),
      'Docker must use the exact pinned Threagile image digest');
    const riskOutputDirectory = join(temp, 'threagile');
    await mkdir(riskOutputDirectory);
    runThreagile(dockerBin, threatModelFile, riskOutputDirectory);
    const risks = JSON.parse(await readFile(join(riskOutputDirectory, 'risks.json'), 'utf8'));
    validateThreatRisks(risks);

    const suppressedModel = threatModel.replace(
      'codexia-bola-project-isolation@*:\n    status: unchecked',
      'codexia-bola-project-isolation@*:\n    status: mitigated',
    );
    assert.notEqual(suppressedModel, threatModel, 'Risk suppression failure injection target was not found');
    const suppressedModelFile = join(temp, 'suppressed-risk.yaml');
    const suppressedOutputDirectory = join(temp, 'suppressed-risk-output');
    await writeFile(suppressedModelFile, suppressedModel);
    await mkdir(suppressedOutputDirectory);
    runThreagile(dockerBin, suppressedModelFile, suppressedOutputDirectory);
    const suppressedRisks = JSON.parse(await readFile(join(suppressedOutputDirectory, 'risks.json'), 'utf8'));
    const riskControl = expectRejection('required-risk-suppression', () =>
      validateThreatRisks(suppressedRisks), /codexia-bola-project-isolation.*suppressed as mitigated/u);

    const secretControl = expectRejection('public-secret-exposure', () =>
      assertNoPublicSecrets(['Authorization: Bearer ' + 'fixture-token-which-must-never-be-published']),
    /secret-like material/u);

    await mkdir(evidence, { recursive: true });
    const evidenceFiles = new Map([
      ['likec4-export.json', exportFile],
      ['threagile-risks.json', join(riskOutputDirectory, 'risks.json')],
      ['threagile-stats.json', join(riskOutputDirectory, 'stats.json')],
      ['threagile-technical-assets.json', join(riskOutputDirectory, 'technical-assets.json')],
    ]);
    const outputDigests = {};
    for (const [name, source] of evidenceFiles) {
      const outputPath = join(evidence, name);
      await copyFile(source, outputPath);
      outputDigests[name] = await sha256Path(outputPath);
    }
    const sourceInputs = [
      LIKEC4_SOURCE_PATH,
      THREAT_MODEL_PATH,
      THREAT_MODEL_DOC_PATH,
      'docs/architecture/SYSTEM-DESIGN.sdoc',
      'scripts/architecture/package-lock.json',
    ];
    const report = {
      format: 'codexia-architecture-g5/v1',
      sourceSha,
      status: 'PASSED',
      scope: 'static architecture model validation only',
      runtimeAcceptance: 'NOT_CLAIMED',
      generatedAt: new Date().toISOString(),
      tools: {
        likec4: LIKEC4_GENERATOR,
        likec4LockSha256: await sha256Path(toolLockFile),
        threagileImage: THREAGILE_IMAGE,
      },
      inputs: Object.fromEntries(await Promise.all(sourceInputs.map(async path =>
        [path, await sha256Path(join(root, path))]))),
      likec4: {
        view: architectureView.title,
        elementCount: Object.keys(modelExport.elements).length,
        relationshipCount: Object.keys(modelExport.relations).length,
      },
      threagile: {
        riskInstanceCount: risks.length,
        requiredRiskIds: REQUIRED_RISK_IDS,
        requiredVerificationReferences: REQUIRED_RISK_CHECK_IDS,
        suppressedRequiredRisks: 0,
      },
      failureInjection: [boundaryControl, operationsRouteControl, riskControl, secretControl],
      outputs: outputDigests,
      note: 'This report is model/tooling evidence for the exact source SHA; it does not certify live API, OAuth, deployment, backup or restore behavior.',
    };
    await writeFile(join(evidence, 'architecture-g5-evidence.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidenceDirectory = process.argv[2] ?? process.env.CODEXIA_ARCHITECTURE_EVIDENCE_DIR;
  if (process.argv.length > 3 || !evidenceDirectory) {
    console.error('Usage: node scripts/architecture/verify.mjs <evidence-directory-outside-repository> (or CODEXIA_ARCHITECTURE_EVIDENCE_DIR)');
    process.exitCode = 2;
  } else {
    verifyArchitecture(evidenceDirectory)
      .then(report => console.log(JSON.stringify(report)))
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
