import assert from 'node:assert/strict';
import test from 'node:test';
import { isMcpStrict, MCP_2025_PROTOCOL_CUTOFF } from './protocol-version.js';

test('2025 protocol compatibility ends at the six-month cutoff', () => {
  assert.equal(isMcpStrict(MCP_2025_PROTOCOL_CUTOFF - 1), false);
  assert.equal(isMcpStrict(MCP_2025_PROTOCOL_CUTOFF), true);
  assert.equal(isMcpStrict(MCP_2025_PROTOCOL_CUTOFF + 1), true);
});
