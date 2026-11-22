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

/** Build a conservative report-only closure for the static full-plan coverage task. */
export async function captureCoverageInputClosure({ root, runtime, invocation, workflowJob }) {
  const sourcePaths = ['scripts/ci-workspace.mjs', 'scripts/ci-contract.mjs', 'scripts/ci-parallel.mjs',
    'scripts/ci-impact.mjs', 'scripts/ci-group.mjs', 'scripts/ci-profile-artifact.mjs', 'scripts/ci-native-producer.mjs',
    'scripts/ci-browser-fixture.mjs', 'scripts/ci-browser-image-digests.mjs', 'scripts/ci-task-input-proof.mjs',
    'scripts/ci-task-inputs.mjs', 'scripts/ci-coverage-inputs.mjs', '.github/workflows/verify.yml'];
  const packageManifests = (await readdir(path.join(root, 'packages'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/package.json`);
  const moduleManifests = (await readdir(path.join(root, 'modules'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => `modules/${entry.name}/package.json`);
  const manifestPaths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...packageManifests, ...moduleManifests, 'app/package.json'];
  const testDirectories = ['scripts', 'app', ...manifestPaths.filter(file => file.startsWith('packages/') || file.startsWith('modules/')).map(file => path.dirname(file))];
  const tests = (await Promise.all(testDirectories.map(directory => walkTestFiles(root, path.join(root, directory)))))
    .flat().sort(([a], [b]) => a.localeCompare(b));
  const fileDigests = async paths => Promise.all([...new Set(paths)].sort().map(async relativePath => {
    const bytes = await readFile(path.join(root, relativePath));
    return [relativePath, createHash('sha256').update(bytes).digest('hex')];
  }));
  const workspaceDirectories = [];
  for (const area of ['packages', 'modules']) {
    workspaceDirectories.push(...(await readdir(path.join(root, area), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => `${area}/${entry.name}`));
  }
  workspaceDirectories.push('app');
  const closure = {
    source: digest(await fileDigests(sourcePaths)),
    tests: digest(tests),
    dependencies: digest(await fileDigests(manifestPaths)),
    environment: digest({ cwd: root, platform: runtime.platform, arch: runtime.arch }),
    toolchain: digest({ nodeVersion: runtime.nodeVersion, execPath: runtime.execPath, imageOS: runtime.imageOS ?? null, imageVersion: runtime.imageVersion ?? null }),
    recipe: digest({ invocation, workflowJob, mode: 'static-coverage' }),
    producers: digest({ prerequisites: [], workspaceDirectories: workspaceDirectories.sort() }),
  };
  return closure;
}

export function coverageInputProof({ closure, sourceSha, planDigest, workflowRunId, workflowAttempt, workflowJob, runtime, reusedFrom }) {
  const proof = { format: 'codexia-ci-task-input-proof/v2', task: 'coverage', mode: 'static-coverage', status: 'passed',
    sourceSha, planDigest, workflowRunId, workflowAttempt, workflowJob, runtime, inputClosure: closure };
  return reusedFrom ? { ...proof, reusedFrom } : proof;
}

export function coverageInvocation(executable) {
  return { executable, arguments: ['scripts/ci-workspace.mjs', 'coverage'], environmentKeys: [] };
}

export function coverageRuntime(env = process.env) {
  return { platform: process.platform, arch: process.arch, nodeVersion: process.version,
    execPath: process.execPath, cwd: process.cwd(), imageOS: env.ImageOS ?? null, imageVersion: env.ImageVersion ?? null };
}
