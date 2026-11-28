import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { VERIFICATION_GROUPS } from '../impact/contract.mjs';

// Only these data files are consumed by certification or certified trace readers.
// Never copy entire directories or execute material from an evidence artifact.
export async function stageCertificationReceipt(reportDirectory, report) {
  const root = path.resolve(reportDirectory);
  const destination = root + '-receipt';
  const tasks = VERIFICATION_GROUPS[report.group];
  assert.ok(Array.isArray(tasks) && Array.isArray(report.results), 'Invalid receipt group');
  const files = ['report.json'];
  for (const result of report.results) {
    assert.ok(tasks.includes(result.task), 'Foreign receipt task');
    if (result.status !== 'passed') continue;
    if (result.task === 'requirements-trace') files.push('requirements-trace/strictdoc/trace-report.json');
    if (result.task.startsWith('browser-')) files.push(result.task + '/browser-coverage.json');
  }
  assert.equal(new Set(files).size, files.length, 'Duplicate receipt path');
  await mkdir(destination, { recursive: false });
  for (const file of files) {
    const source = path.join(root, file);
    const stat = await lstat(source);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Missing or unsafe certification receipt: ' + file);
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return destination;
}
