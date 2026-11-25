// MCP's API epoch changes while the persisted format and SQL ledger stay put.
// This descriptor admits the deployment transition but performs no conversion.
export default {
  id: 'mcp-v2-api-2-to-3',
  source: { apiEpoch: 2, persistenceFormat: 2 },
  target: { apiEpoch: 3, persistenceFormat: 2 },
  requiredAxes: ['api-epoch'],
  optionalAxes: [],
  handler: null,
  fixture: 'scripts/deployment/cutover/migrations/mcp-v2-api-2-to-3.test.mjs',
  inputs: [
    'scripts/deployment/cutover/migrations/mcp-v2-api-2-to-3.mjs',
    'scripts/deployment/cutover/migrations/catalog.mjs',
    'scripts/deployment/cutover/transitions.mjs',
    'scripts/deployment/cutover/transitions.test.mjs',
    'scripts/deployment/cutover/execute.mjs',
  ],
};
