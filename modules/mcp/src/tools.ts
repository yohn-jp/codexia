import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpActionClient } from "./api-client.js";
import { signalAwareClient } from "./tools/shared.js";
import { registerLegacyTools } from "./tools/legacy.js";
import { registerProjectTools } from "./tools/project.js";
import { registerSearchTools } from "./tools/search.js";
import { registerStoryTools } from "./tools/story.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";

/** Compose every feature registrar over the same project, error and cancellation boundary. */
export function registerMcpTools(server: McpServer, baseClient: McpActionClient): void {
  const client = signalAwareClient(baseClient);
  registerProjectTools(server, client);
  registerSearchTools(server, client);
  registerStoryTools(server, client);
  registerLegacyTools(server, client);
  registerKnowledgeTools(server, client);
}
