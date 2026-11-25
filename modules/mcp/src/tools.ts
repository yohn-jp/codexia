import { McpServer } from '@modelcontextprotocol/server';
import type { McpActionClient } from './api-client.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerLegacyTools } from './tools/legacy.js';
import { registerProjectTools } from './tools/project.js';
import { registerSearchTools } from './tools/search.js';
import { signalAwareClient } from './tools/shared.js';
import { registerStoryTools } from './tools/story.js';

/** Compose every feature registrar over the same project, error and cancellation boundary. */
export function registerMcpTools(server: McpServer, baseClient: McpActionClient): void {
  const client = signalAwareClient(baseClient);
  registerProjectTools(server, client);
  registerSearchTools(server, client);
  registerStoryTools(server, client);
  registerLegacyTools(server, client);
  registerKnowledgeTools(server, client);
}

/** Create the shared MCP tool server for transports that provide an authorized action client. */
export function createCodexiaMcpServer(client: McpActionClient): McpServer {
  const server = new McpServer({ name: 'codexia', version: '0.1.0' });
  registerMcpTools(server, client);
  return server;
}
