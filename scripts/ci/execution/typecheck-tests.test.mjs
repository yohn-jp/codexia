import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./typecheck-tests.mjs', import.meta.url));
const root = path.resolve(path.dirname(runner), '../../..');

test('test typecheck inherits workspace settings and reports a type error in Desktop E2E', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'codexia-test-typecheck-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all(['app/src', 'tests/e2e', 'node_modules', 'scripts/ci/execution', 'scripts/ci/impact'].map(directory =>
    mkdir(path.join(fixture, directory), { recursive: true })));
  const fixtureRunner = path.join(fixture, 'scripts/ci/execution/typecheck-tests.mjs');
  const { packageManager } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await Promise.all([
    writeFile(path.join(fixture, 'package.json'), JSON.stringify({ private: true, packageManager })),
    writeFile(path.join(fixture, 'pnpm-workspace.yaml'), 'packages:\n  - app\n'),
    writeFile(path.join(fixture, 'app/package.json'), JSON.stringify({
      name: '@codexia/app', private: true, scripts: { 'generate:http': 'node generate.mjs' },
    })),
    writeFile(path.join(fixture, 'app/generate.mjs'), `import { writeFileSync } from 'node:fs';
writeFileSync('src/generated-client.ts', 'export type Operation = "example";\\n');
`),
    copyFile(runner, fixtureRunner),
    copyFile(path.join(root, 'scripts/ci/impact/contract.mjs'), path.join(fixture, 'scripts/ci/impact/contract.mjs')),
    symlink(await realpath(path.join(root, 'node_modules/typescript')), path.join(fixture, 'node_modules/typescript'), 'junction'),
    writeFile(path.join(fixture, 'app/tsconfig.json'), '{\n  // The E2E sources are outside the application root.\n  "compilerOptions": { "rootDir": "src", "strict": true, "types": [] },\n  "exclude": ["src/**/*.test.ts"]\n}\n'),
    writeFile(path.join(fixture, 'app/src/example.test.ts'), 'import type { Operation } from "./generated-client";\nexport const registered: Operation = "example";\n'),
    writeFile(path.join(fixture, 'tests/e2e/example.spec.ts'), 'export const registered: string = 42;\n'),
  ]);

  const failed = spawnSync(process.execPath, [fixtureRunner, 'app-e2e'], { cwd: fixture, encoding: 'utf8' });
  const failureOutput = `${failed.stdout}\n${failed.stderr}`;
  assert.equal(failed.status, 1, failureOutput);
  assert.match(failureOutput, /tests\/e2e\/example\.spec\.ts.*error TS2322/u);
  assert.match(failureOutput, /Test typecheck app-e2e: 3 TypeScript files, 2 test\/spec files, FAIL/u);

  await writeFile(path.join(fixture, 'tests/e2e/example.spec.ts'), 'export const registered: string = "e2e test";\n');
  const passed = spawnSync(process.execPath, [fixtureRunner, 'app-e2e'], { cwd: fixture, encoding: 'utf8' });
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
  assert.match(passed.stdout, /Test typecheck app-e2e: 3 TypeScript files, 2 test\/spec files, PASS/u);
});
