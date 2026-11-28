import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stageCertificationReceipt } from './stage-receipt.mjs';

test('certification receipt excludes large diagnostics and retains required trace evidence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codexia-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'trace');
  const trace = path.join(source, 'requirements-trace', 'strictdoc');
  await mkdir(path.join(trace, 'html'), { recursive: true });
  await writeFile(path.join(trace, 'html', 'large.html'), Buffer.alloc(17 * 1024 * 1024, 65));
  await writeFile(path.join(trace, 'trace-report.json'), '{"caseExecutions":[]}');
  const report = { group: 'types-trace', results: [{ task: 'requirements-trace', status: 'passed' }] };
  await writeFile(path.join(source, 'report.json'), JSON.stringify(report));
  const receipt = await stageCertificationReceipt(source, report);
  assert.deepEqual((await readdir(receipt, { recursive: true })).map(String).sort(), [
    'report.json', 'requirements-trace', 'requirements-trace/strictdoc', 'requirements-trace/strictdoc/trace-report.json',
  ].sort());
  assert.equal(await readFile(path.join(receipt, 'requirements-trace/strictdoc/trace-report.json'), 'utf8'), '{"caseExecutions":[]}');
});

test('browser coverage must be present for every passed browser task', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codexia-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'browser');
  await mkdir(source);
  const report = { group: 'browser-core-writing', results: [{ task: 'browser-core-core', status: 'passed' }] };
  await writeFile(path.join(source, 'report.json'), JSON.stringify(report));
  await assert.rejects(stageCertificationReceipt(source, report), /ENOENT/);
});
