import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpActionClient } from "../api-client.js";
import { errorResult, guarded, invoke, scopedClient, unavailableModuleAction } from "./shared.js";

const projectIdSchema = z.string().min(1).max(256).optional().describe("Registered project ID");

/** Register the lexical and legacy semantic search adapters. */
export function registerSearchTools(server: McpServer, baseClient: McpActionClient): void {
  server.tool(
    "search_lexical",
    "Search project content using ordinary lexical retrieval. Semantic enrichment is optional and disabled by default.",
    {
      project_id: projectIdSchema,
      query: z.string().min(1).max(512).describe("Search query"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum result count (default 20)"),
      mode: z.enum(["fulltext", "exact", "prefix"]).optional().describe("Lexical matching mode"),
      scope: z.string().max(1024).optional().describe("Optional repository path scope"),
      include_semantic: z.boolean().optional().default(false).describe("Enrich lexical results with semantic results when explicitly enabled"),
    },
    guarded(async ({ project_id, query, limit, mode, scope, include_semantic }) => {
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "search.query")) {
        return unavailableModuleAction(client, "search", "search_lexical");
      }
      return invoke(client, "search.query", {
        query,
        ...(limit === undefined ? {} : { limit }),
        ...(mode === undefined ? {} : { mode }),
        ...(scope === undefined ? {} : { scope }),
        includeSemantic: include_semantic === true,
      });
    }),
  );

  server.tool(
    "search",
    "Legacy semantic search over project story content; use search_lexical for ordinary full-text search.",
    {
      project_id: projectIdSchema,
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Maximum result count (default 20)"),
    },
    guarded(async ({ project_id, query, limit }) => {
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "semantic.search")) {
        return unavailableModuleAction(client, "semantic", "search");
      }
      return invoke(client, "semantic.search", { query, ...(limit === undefined ? {} : { limit }) });
    }),
  );
}
