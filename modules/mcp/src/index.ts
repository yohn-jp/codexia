import type { ModuleDefinition, ModuleManifest } from '@codexia/contracts';
import { createMcpHttpContribution } from './http.js';

export const mcpManifest: ModuleManifest = {
  id: 'mcp',
  version: '0.1.0',
  contractVersion: 1,
  dependencies: [],
  provides: [],
  requires: [],
  serverEntry: './dist/index.js',
  statePaths: [],
  locality: 'local',
  http: [{ id: 'streamable', path: 'streamable', methods: ['GET', 'POST', 'DELETE'], access: 'owner', effect: 'propose' }],
};

/** Register the external MCP transports without allocating models or persistent storage. */
export async function createModule(): Promise<ModuleDefinition> {
  return {
    manifest: mcpManifest,
    actions: [],
    ui: [],
    http: [createMcpHttpContribution()],
    async dispose() {},
  };
}

export {
  buildMcpProtectedResourceMetadata,
  createMcpProtectedResourceMetadataResponse,
  MCP_OAUTH_SCOPES,
  type McpProtectedResourceMetadata,
  type McpProtectedResourceOptions,
  protectedResourceMetadataUrl,
} from '@codexia/contracts';
export { ApiClient, actionClientFromContext, McpApiError } from './api-client.js';
export {
  createMcpWritingContext,
  MCP_WRITING_CONTEXT_MAX_CHARACTERS,
  MCP_WRITING_CONTEXT_MAX_SELECTION_CHARACTERS,
  mcpWritingContextSelectionSchema,
} from './context-manifest.js';
export { createMcpHttpContribution } from './http.js';
export { registerMcpTools } from './tools.js';
