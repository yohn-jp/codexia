import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateProductProfile } from './product-profile.mjs';

const discovery = {
  scenario: 'server-stateless', status: 'SUCCESS', exitCode: 0,
  discoveredCapabilities: { tools: { listChanged: true } },
  discoveredToolNames: ['invoke_action'],
  checks: ['sep-2575-server-implements-discover', 'sep-2575-discover-capabilities-match-handlers'].map(id => ({ id, status: 'SUCCESS' })),
};
const missingPrompt = {
  scenario: 'prompts-list', status: 'FAILURE', exitCode: 1,
  checks: [
    { id: 'prompts-list', status: 'FAILURE', error: 'Failed: Method not found' },
    { id: 'wire-schema-valid', status: 'SUCCESS' },
  ],
};
test('preserves native failure while recording explicitly absent feature as not applicable', () => {
  const input = [discovery, missingPrompt];
  const result = evaluateProductProfile(input);
  assert.equal(result.passed, true);
  assert.equal(result.results[1].outcome, 'NOT_APPLICABLE');
  assert.equal(input[1].status, 'FAILURE');
});
test('fails on changed capabilities, diagnostic catalog, missing report, or actual protocol defect', () => {
  for (const input of [
    [{ ...discovery, discoveredCapabilities: { tools: {}, prompts: {} } }, missingPrompt],
    [{ ...discovery, discoveredToolNames: ['invoke_action', 'test_simple_text'] }, missingPrompt],
    [discovery, { ...missingPrompt, checks: null, status: 'NO_REPORT' }],
    [discovery, { ...missingPrompt, checks: [{ ...missingPrompt.checks[0], error: 'Failed: Internal error' }, missingPrompt.checks[1]] }],
    [discovery, { ...missingPrompt, checks: [...missingPrompt.checks, { id: 'wire-schema-valid', status: 'FAILURE' }] }],
    [discovery, { ...missingPrompt, scenario: 'dns-rebinding-protection' }],
  ]) assert.equal(evaluateProductProfile(input).passed, false);
});
