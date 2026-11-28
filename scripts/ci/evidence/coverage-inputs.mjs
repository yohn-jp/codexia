import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const generatedDirectories = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target']);
const testFilePattern = /\.(?:test|spec)\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/u;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function walkTestFiles(root, directory) {
  const output = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !generatedDirectories.has(entry.name)) await visit(absolute);
      else if (entry.isFile() && testFilePattern.test(entry.name)) {
        const bytes = await readFile(absolute);
        output.push([path.relative(root, absolute).split(path.sep).join('/'), createHash('sha256').update(bytes).digest('hex')]);
      }
    }
  }
  await visit(directory);
  return output.sort(([a], [b]) => a.localeCompare(b));
}

// Filter the Git index (also available in a sparse checkout). A force-added
// generated file must invalidate a reused coverage proof as well as a fresh run.
export function trackedHttpOutputs(root) {
  const swiftRoot = 'ios/CodexiaTransport/Sources/CodexiaAPI/';
  const outputs = [
    'packages/http-contract/openapi/codexia.openapi.yaml', 'packages/api/src/generated/http-contract.json',
    'app/src/generated/http/', 'app/src/generated/auth-methods/', swiftRoot + 'Generated/',
    ...['Client', 'Types', 'Types+Operations', 'Types+Components',
      ...['Headers', 'Parameters', 'RequestBodies', 'Responses', 'Schemas'].map(type => 'Types+Components+' + type),
    ].map(name => swiftRoot + name + '.swift'),
  ];
  return execFileSync('git', ['-c', 'safe.directory=' + path.resolve(root), 'ls-files', '-z', '--', ...outputs], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean);
}

export async function discoverWorkspacePaths(root) {
  const workspaces = ['app'];
  for (const area of ['packages', 'modules']) {
    const entries = await readdir(path.join(root, area), { withFileTypes: true });
    for (const entry of entries.filter(candidate => candidate.isDirectory())) {
      const packageEntries = await readdir(path.join(root, area, entry.name));
      if (packageEntries.includes('package.json')) workspaces.push(`${area}/${entry.name}`);
    }
  }
  return workspaces.sort();
}

/** Build a conservative report-only closure for the static full-plan coverage task. */
export async function captureCoverageInputClosure({ root, runtime, invocation, workflowJob }) {
  const sourcePaths = ['scripts/ci/execution/workspace.mjs', 'scripts/ci/impact/contract.mjs', 'scripts/ci/execution/parallel.mjs',
    'scripts/ci/impact/plan.mjs', 'scripts/ci/execution/group.mjs', 'scripts/ci/evidence/profile-artifact.mjs',
    'scripts/ci/evidence/download-artifacts.mjs', 'scripts/ci/evidence/stage-receipt.mjs', 'scripts/ci/evidence/job-name.mjs',
    'scripts/ci/evidence/producer-artifact.mjs',
    'scripts/ci/browser/fixture.mjs', 'scripts/ci/browser/image-digests.mjs', 'scripts/ci/evidence/input-proof.mjs',
    'scripts/ci/evidence/task-inputs.mjs', 'scripts/ci/evidence/coverage-inputs.mjs',
    '.github/workflows/verify.yml', '.github/workflows/verify-profile.yml'];
  const workspaceDirectories = await discoverWorkspacePaths(root);
  const manifestPaths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/ci/evidence/package.json',
    ...workspaceDirectories.map(directory => `${directory}/package.json`)];
  const testDirectories = ['scripts', ...workspaceDirectories];
  const tests = (await Promise.all(testDirectories.map(directory => walkTestFiles(root, path.join(root, directory)))))
    .flat().sort(([a], [b]) => a.localeCompare(b));
  const fileDigests = async paths => Promise.all([...new Set(paths)].sort().map(async relativePath => {
    const bytes = await readFile(path.join(root, relativePath));
    return [relativePath, createHash('sha256').update(bytes).digest('hex')];
  }));
  const closure = {
    source: digest({ files: await fileDigests(sourcePaths), trackedHttpOutputs: trackedHttpOutputs(root) }),
    tests: digest(tests),
    dependencies: digest(await fileDigests(manifestPaths)),
    environment: digest({ cwd: root, platform: runtime.platform, arch: runtime.arch }),
    toolchain: digest({ nodeVersion: runtime.nodeVersion, execPath: runtime.execPath, imageOS: runtime.imageOS ?? null, imageVersion: runtime.imageVersion ?? null }),
    recipe: digest({ invocation, workflowJob, mode: 'static-coverage' }),
    producers: digest({ prerequisites: [], workspaceDirectories }),
  };
  return closure;
}

export function coverageInputProof({ closure, sourceSha, planDigest, workflowRunId, workflowAttempt, workflowJob, runtime, reusedFrom }) {
  const proof = { format: 'codexia-ci-task-input-proof/v2', task: 'coverage', mode: 'static-coverage', status: 'passed',
    sourceSha, planDigest, workflowRunId, workflowAttempt, workflowJob, runtime, inputClosure: closure };
  return reusedFrom ? { ...proof, reusedFrom } : proof;
}

export function coverageInvocation(executable) {
  return { executable, arguments: ['scripts/ci/execution/workspace.mjs', 'coverage'], environmentKeys: [] };
}

export function coverageRuntime(env = process.env) {
  return { platform: process.platform, arch: process.arch, nodeVersion: process.version,
    execPath: process.execPath, cwd: process.cwd(), imageOS: env.ImageOS ?? null, imageVersion: env.ImageVersion ?? null };
}
