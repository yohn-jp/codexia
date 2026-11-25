import persistenceConversion from './full-persistence-1-to-2.mjs';
import mcpV2ApiEpoch from './mcp-v2-api-2-to-3.mjs';

export const migrationContracts = Object.freeze([persistenceConversion, mcpV2ApiEpoch]);
