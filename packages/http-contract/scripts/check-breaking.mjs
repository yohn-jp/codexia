import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { readApprovedOpenapi } from './approved-openapi.mjs';
import { resolveBaseCommit, selectBaseReference } from './base-reference.mjs';
import { assertBreakingComparison, assertCandidateManifestEpoch, assertComparisonManifestEpoch } from './breaking-policy.mjs';
import { resolveOasdiffBinary } from './oasdiff.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
process.chdir(repositoryRoot);
const packageContractPath = 'packages/http-contract/openapi/codexia.openapi.yaml';
const candidatePath = path.join(packageRoot, 'openapi', 'codexia.openapi.yaml');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codexia-oasdiff-base-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function git(args, options = {}) {
  return run('git', args, options);
}

function readBaseFile(baseSha, filename) {
  const result = git(['show', `${baseSha}:${filename}`]);
  if (result.status !== 0) throw new Error(`unable to read approved base ${baseSha}:${filename}: ${result.stderr}`);
  return result.stdout;
}

try {
  const candidate = parse(readFileSync(candidatePath, 'utf8'));
  const candidateUpdate = JSON.parse(readFileSync(path.join(repositoryRoot, 'deploy', 'update-compatibility.json'), 'utf8'));
  const candidateFrontend = JSON.parse(readFileSync(path.join(repositoryRoot, 'deploy', 'frontend-compatibility.json'), 'utf8'));
  assertCandidateManifestEpoch(candidate, candidateUpdate, candidateFrontend);
  const reference = selectBaseReference();
  const baseSha = resolveBaseCommit(reference, git);
  const baseFile = path.join(tempRoot, 'base.openapi.yaml');
  const baseText = readApprovedOpenapi(repositoryRoot, baseSha).toString('utf8');
  writeFileSync(baseFile, baseText);
  const base = parse(baseText);
  const baseUpdate = JSON.parse(readBaseFile(baseSha, 'deploy/update-compatibility.json'));
  const baseFrontend = JSON.parse(readBaseFile(baseSha, 'deploy/frontend-compatibility.json'));
  const epoch = assertComparisonManifestEpoch({
    baseSpec: base,
    candidateSpec: candidate,
    baseUpdate,
    baseFrontend,
    candidateUpdate,
    candidateFrontend,
  });

  const binary = await resolveOasdiffBinary();
  const comparison = run(binary, [
    'breaking',
    baseFile,
    candidatePath,
    '--format',
    'json',
    '--allow-external-refs=false',
    '--fail-on',
    'ERR',
  ]);
  process.stdout.write(comparison.stdout ?? '');
  process.stderr.write(comparison.stderr ?? '');
  assertBreakingComparison({ stdout: comparison.stdout ?? '', status: comparison.status });
  console.log(`oasdiff found no breaking changes at API epoch ${epoch}, comparing approved ${packageContractPath} from ${baseSha}.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
