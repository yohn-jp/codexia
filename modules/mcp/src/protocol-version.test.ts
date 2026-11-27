import assert from 'node:assert/strict';
import test from 'node:test';
import { isMcpStrict, MCP_2025_PROTOCOL_CUTOFF } from './protocol-version.js';

test('[TEST-MCPV-007-004] 2025 protocol compatibility ends at the six-month cutoff', () => {
  assert.equal(isMcpStrict(MCP_2025_PROTOCOL_CUTOFF - 1), false);
  assert.equal(isMcpStrict(MCP_2025_PROTOCOL_CUTOFF), true);
  assert.equal(isMcpStrict(MCP_2025_PROTOCOL_CUTOFF + 1), true);
});
