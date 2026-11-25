import type { HttpContribution, ModuleActionContext } from '@codexia/contracts';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { actionClientFromContext } from './api-client.js';
import { isMcpStrict } from './protocol-version.js';
import { createCodexiaMcpServer } from './tools.js';

export interface McpHttpOptions {
  /** Override the protocol cutoff in focused tests. Production follows the fixed migration date. */
  strict?: boolean;
  /** Clock seam for boundary tests. */
  now?: () => number;
}

function handlerFor(context: ModuleActionContext, strict: boolean) {
  return createMcpHandler(() => createCodexiaMcpServer(actionClientFromContext(context)), {
    legacy: strict ? 'reject' : 'stateless',
  });
}

/** The host performs project selection and authorization before this SDK-owned HTTP boundary. */
export function createMcpHttpContribution(options: McpHttpOptions = {}): HttpContribution {
  return {
    id: 'streamable',
    path: 'streamable',
    methods: ['GET', 'POST', 'DELETE'],
    access: 'owner',
    effect: 'propose',
    async handle(request, context) {
      const handler = handlerFor(context, options.strict ?? isMcpStrict((options.now ?? Date.now)()));
      return handler.fetch(request);
    },
  };
}
