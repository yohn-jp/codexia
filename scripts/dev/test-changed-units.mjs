import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createVerificationPlan } from '../ci/impact/plan.mjs';

const { values, positionals } = parseArgs({
  options: { list: { type: 'boolean' } }, allowPositionals: true,
});
if (positionals.length > 1) throw new Error('Usage: pnpm test:unit:changed [--list] [base-ref]');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const ref = positionals[0] ?? 'origin/main';
const base = git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').trim();
const sha = git('rev-parse', 'HEAD').trim();
const mergeBase = git('merge-base', base, sha).trim();
const files = [...new Set([
  ...git('diff', '--no-renames', '--name-only', '-z', mergeBase, '--').split('\0'),
  ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
].filter(Boolean))];
const plan = createVerificationPlan({ event: 'pull_request', base, sha, files });
const tasks = plan.tasks.filter(task => task.startsWith('unit-'));
console.log(`Local unit selection (${files.length} changed files, base ${mergeBase.slice(0, 12)}): ${tasks.join(', ') || 'none'}`);

if (tasks.length && !values.list) {
  const reportDir = mkdtempSync(path.join(tmpdir(), 'codexia-unit-'));
  const report = path.join(reportDir, 'preparation.json');
  const runner = 'scripts/ci/execution/workspace.mjs';
  try {
    execFileSync(process.execPath, [runner, 'prepare', 'selected-group', report], {
      stdio: 'inherit', env: { ...process.env, CODEXIA_CI_GROUP_TASKS: JSON.stringify(tasks) },
    });
    for (const { task, error } of JSON.parse(readFileSync(report, 'utf8'))) {
      if (error) throw new Error(task + ': ' + error);
      execFileSync(process.execPath, [runner, 'unit', task.slice('unit-'.length)], { stdio: 'inherit' });
    }
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}
