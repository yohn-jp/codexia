import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpActionClient } from '../api-client.js';
import { errorResult, guarded, invoke, scopedClient, toolOutputSchema, unavailableModuleAction } from './shared.js';

const projectIdSchema = z.string().min(1).max(256).optional().describe('Registered project ID');

/** Register the lexical and legacy semantic search adapters. */
export function registerSearchTools(server: McpServer, baseClient: McpActionClient): void {
  server.registerTool(
    'search_lexical',
    {
      description: 'Search project content using ordinary lexical retrieval. Semantic enrichment is optional and disabled by default.',
      inputSchema: z.object({
        project_id: projectIdSchema,
        query: z
          .string()
          .min(1)
          .max(512)
          .refine(value => value.trim().length > 0)
          .describe('Search query'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum result count (default 20)'),
        mode: z.enum(['fulltext', 'exact', 'prefix']).optional().describe('Lexical matching mode'),
        scope: z.string().max(1024).optional().describe('Optional repository path scope'),
        include_semantic: z
          .boolean()
          .optional()
          .default(false)
          .describe('Enrich lexical results with semantic results when explicitly enabled'),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, query, limit, mode, scope, include_semantic }) => {
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some(action => action.id === 'search.query')) {
        return unavailableModuleAction(client, 'search', 'search_lexical');
      }
      return invoke(client, 'search.query', {
        query,
        ...(limit === undefined ? {} : { limit }),
        ...(mode === undefined ? {} : { mode }),
        ...(scope === undefined ? {} : { scope }),
        includeSemantic: include_semantic === true,
      });
    }),
  );

  server.registerTool(
    'search',
    {
      description: 'Legacy semantic search over project story content; use search_lexical for ordinary full-text search.',
      inputSchema: z.object({
        project_id: projectIdSchema,
        query: z.string().max(8192).describe('Search query (at most 8192 characters)'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum result count (default 20, max 100)'),
      }),
      outputSchema: toolOutputSchema,
    },
    guarded(async ({ project_id, query, limit }) => {
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some(action => action.id === 'semantic.search')) {
        return unavailableModuleAction(client, 'semantic', 'search');
      }
      return invoke(client, 'semantic.search', { query, ...(limit === undefined ? {} : { limit }) });
    }),
  );
}
