import assert from 'node:assert/strict';
import { BROWSER_SHARDS, VERIFICATION_GROUPS } from '../impact/contract.mjs';

// Runtime image identities shared by task input proofs and live browser preflight.
// The immutable workflow container pins are independently checked for parity.
export const PLAYWRIGHT_IMAGE_DIGESTS = Object.freeze({
  chromium: 'sha256:d11b4fa1128d937fcda9dd0106d138b65c3e72cbad07d4801547aa66fc1c4725',
});

const projectByShard = new Map(BROWSER_SHARDS.map(shard => [shard.id, shard.project]));

export function browserRuntimeRequirements(group) {
  const groupTasks = VERIFICATION_GROUPS[group];
  assert.ok(group.startsWith('browser-') && Array.isArray(groupTasks) && groupTasks.length > 0, 'Unknown CI browser group');
  const taskPrefix = `browser-${group.split('-')[1]}-`;
  const projects = new Set(groupTasks.map(task => {
    assert.ok(task.startsWith(taskPrefix), 'Browser group contains a foreign profile task');
    const project = projectByShard.get(task.slice(taskPrefix.length));
    assert.ok(project === 'chromium', `Unknown browser project: ${task}`);
    return project;
  }));
  assert.ok(projects.has('chromium'), 'Every browser group must validate Chromium');
  return { projects, imageDigest: PLAYWRIGHT_IMAGE_DIGESTS.chromium };
}
