import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestEvidence } from '../preflight/evidence-digest.mjs';
import { assertFreshObservationTime } from '../preflight/plan.mjs';

export function admitExistingEscrow(reviewed, live, now = new Date()) {
  const { plan } = reviewed;
  const { host, hostPinSha256 } = live;
  assert.equal(host.format, 'codexia-lifecycle-host/v1');
  assert.equal(plan.format, 'codexia-deployment-plan/v1');
  assert.equal(reviewed.management, 'bootstrap');
  assert.equal(digestEvidence(plan), reviewed.planSha256);
  assert.equal(plan.intent, 'install');
  assert.ok(['R5', 'R6'].includes(plan.candidateRoute));
  const allowed = plan.candidateRoute === 'R6'
    ? ['approval-required', 'missing-preservation-evidence', 'missing-or-expired-window']
    : ['approval-required'];
  assert.ok(plan.blockers.every(value => allowed.includes(value)));
  const observed = assertFreshObservationTime(host.observedAt, { now });
  const reviewedAt = Date.parse(plan.observation.observedAt);
  assert.ok(Number.isFinite(reviewedAt) && reviewedAt <= observed);
  const expected = plan.observation.binding;
  assert.equal(hostPinSha256, expected.hostPinSha256);
  assert.equal(host.hostId, expected.hostId);
  assert.equal(host.H, 'ready');
  assert.equal(host.database.state, 'initialized');
  assert.equal(host.transaction, null);
  assert.equal(digestEvidence(host.database), expected.databaseSha256);
  assert.equal(digestEvidence({state: host.H, topology: host.topology}), expected.infrastructureSha256);
  assert.equal(digestEvidence(host.transaction), expected.transactionSha256);
  assert.ok(plan.candidateRoute === 'R6'
    ? host.database.authState === 'ready' && host.backend.state === 'absent'
    : ['pending', 'unprepared'].includes(host.database.authState) && ['absent', 'setup'].includes(host.backend.state));
  return {codexia_escrow_adopt_ids: host.topology.secretHashes};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const temp = process.env.RUNNER_TEMP;
  const read = async path => JSON.parse(await readFile(join(temp, path), 'utf8'));
  const reviewed = await read('reviewed-preflight/codexia-lifecycle-preflight.json');
  const live = await read('codexia-lifecycle-host.json');
  assert.equal(live.sourceSha, process.env.GITHUB_SHA);
  assert.equal(live.runId, Number(process.env.GITHUB_RUN_ID));
  assert.equal(live.attempt, Number(process.env.GITHUB_RUN_ATTEMPT));
  await writeFile(join(temp, 'escrow-admission.json'), JSON.stringify(admitExistingEscrow(reviewed, live)),
    {mode: 0o600, flag: 'wx'});
}
