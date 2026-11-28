#!/usr/bin/env node
// CI fixture only. Compare wall time with existing lock checkpoints.
// The residual is NOT strictly pre-lock; post-lock and module overhead remain.
import { readFileSync, writeFileSync } from 'node:fs';

const [reportPath, phasesPath, boundedPath] = process.argv.slice(2);
if (!reportPath || !phasesPath || !boundedPath) {
  throw new Error('Exact-run outcome, phase log, and bounded output are required');
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const entries = report.timings?.ansible;
if (!Array.isArray(entries)) throw new Error('Missing measured Ansible invocations');
const phaseLines = readFileSync(phasesPath, 'utf8').trim().split('\n').filter(Boolean);
const byStage = new Map();
for (const line of phaseLines) {
  const match = /^LIFECYCLE_DEPLOY_TIMING stage=([A-Za-z0-9_-]+) phase=([a-z_]+) duration_ms=(\d+)$/u.exec(line);
  if (!match) throw new Error('Noncanonical deployment timing evidence');
  const [, stage, phase, msText] = match;
  const ms = Number(msText);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Invalid elapsed duration');
  const observed = byStage.get(stage) ?? { total: 0, phases: new Set() };
  if (observed.phases.has(phase)) throw new Error('Duplicate phase for one deployment stage');
  observed.phases.add(phase);
  observed.total += ms;
  byStage.set(stage, observed);
}
const output = [];
const seen = new Set();
for (const { label, durationMs, exitCode } of entries) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || !Number.isInteger(exitCode)) {
    throw new Error('Invalid deployment wall-time evidence');
  }
  if (!byStage.has(label)) continue;
  if (seen.has(label)) throw new Error('Duplicate measured Ansible invocation');
  seen.add(label);
  if (exitCode !== 0) continue;
  const { total, phases } = byStage.get(label);
  if (!phases.has('lock_acquire')) throw new Error('Missing host-lock measurement');
  const unaccounted = durationMs - total;
  if (unaccounted < 0) throw new Error('Phase totals exceed full invocation time');
  output.push(
    'LIFECYCLE_TRANSACTION_BUDGET stage=' + label +
    ' ansible_ms=' + durationMs +
    ' checkpoint_ms=' + total +
    ' unattributed_ms=' + unaccounted +
    ' checkpoint_share_pct=' + ((100 * total) / Math.max(1, durationMs)).toFixed(1),
  );
}
if (output.length === 0) throw new Error('No successful measured deployment transaction');
writeFileSync(boundedPath, output.join('\n') + '\n', { mode: 0o600 });
process.stdout.write(output.join('\n') + '\n');
