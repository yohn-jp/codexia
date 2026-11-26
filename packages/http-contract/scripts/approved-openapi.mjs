import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const artifact = 'packages/http-contract/openapi/codexia.openapi.yaml';

export function readApprovedOpenapi(repositoryRoot, sha) {
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('Expected an immutable OpenAPI source commit');
  const git = args => execFileSync('git', args, { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 });
  // Historical releases approved the checked-in bytes. New commits own the inputs.
  if (git(['ls-tree', sha, '--', artifact]).length) return git(['show', `${sha}:${artifact}`]);

  const source = 'packages/http-contract/src/main.tsp';
  if (!git(['ls-tree', sha, '--', source]).length) throw new Error(`Missing approved OpenAPI and ${source} at ${sha}`);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'codexia-approved-openapi-'));
  const checkout = path.join(temp, 'source');
  try {
    git(['worktree', 'add', '--quiet', '--detach', checkout, sha]);
    try {
      const run = args =>
        execFileSync('corepack', ['pnpm', '--filter', '@codexia/http-contract', ...args], {
          cwd: checkout,
          stdio: ['ignore', 'inherit', 'inherit'],
        });
      run(['install', '--frozen-lockfile', '--ignore-scripts']);
      run(['run', 'generate']);
      return readFileSync(path.join(checkout, artifact));
    } finally {
      git(['worktree', 'remove', '--force', checkout]);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
