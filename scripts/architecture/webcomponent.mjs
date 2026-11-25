import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoPublicSecrets, LIKEC4_SOURCE_PATH, LIKEC4_VERSION } from './contract.mjs';

const cli = fileURLToPath(new URL('./node_modules/likec4/bin/likec4.mjs', import.meta.url));
const license = fileURLToPath(new URL('./node_modules/likec4/LICENSE', import.meta.url));

export const LIKEC4_PUBLIC_BUNDLE = 'likec4/codexia-architecture.mjs';
export const LIKEC4_PUBLIC_LICENSE = 'likec4/LICENSE';

export function generateLikeC4Webcomponent(modelDir, outputFile) {
  const run = (args) => execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
  });
  const modelName = basename(LIKEC4_SOURCE_PATH);
  const model = readFileSync(join(modelDir, modelName), 'utf8');
  assertNoPublicSecrets([model]);
  assert.equal(run(['--version']).trim(), LIKEC4_VERSION, 'LikeC4 binary does not match the isolated lock');

  // Only the canonical, digest-bound model is a publication input.
  const stage = mkdtempSync(join(tmpdir(), 'codexia-likec4-'));
  try {
    writeFileSync(join(stage, modelName), model);
    run(['validate', '--max-warnings', '0', stage]);
    run(['gen', 'webcomponent', '--no-app-config', '-o', resolve(outputFile), stage]);
    copyFileSync(license, join(dirname(outputFile), basename(LIKEC4_PUBLIC_LICENSE)));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
