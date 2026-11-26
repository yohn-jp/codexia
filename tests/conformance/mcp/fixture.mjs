import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpHttpContribution } from '../../../modules/mcp/dist/http.js';
import { createCodexiaMcpServer } from '../../../modules/mcp/dist/tools.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const snapshot = { projectId, projectVersion: 1 };
const actions = [
  { id: 'core.status', module: 'core', effect: 'read' },
  { id: 'story.context.package', module: 'story', effect: 'read' },
  { id: 'story.snapshot.materialize', module: 'story', effect: 'read' },
];

function actionContext() {
  return {
    projectId,
    async listActions() { return actions; },
    async invoke(actionId, input) {
      if (actionId === 'core.status') return { ok: true, snapshot, data: { status: 'ready' } };
      return { ok: false, snapshot, error: { code: 'not_found', message: `Unknown fixture action ${actionId}`, retryable: false } };
    },
    async propose() { throw new Error('Fixture does not permit proposals'); },
  };
}

if (process.argv.includes('--stdio')) {
  serveStdio(() => createCodexiaMcpServer({
    projectId,
    listActions: async () => actions,
    invoke: async (actionId, input) => actionContext().invoke(actionId, input),
    propose: async () => { throw new Error('Fixture does not permit proposals'); },
  }), { legacy: 'reject' });
} else {
  const contribution = createMcpHttpContribution({ strict: true });
  const server = createHttpServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    const abortRequest = () => abort.abort(new Error('Conformance client disconnected'));
    const abortResponse = () => { if (!outgoing.writableEnded) abortRequest(); };
    const cleanup = () => {
      incoming.removeListener('aborted', abortRequest);
      outgoing.removeListener('close', abortResponse);
    };
    incoming.once('aborted', abortRequest);
    outgoing.once('close', abortResponse);
    try {
      // This is a loopback-only synthetic host, not the product's Fastify admission layer.
      const host = `127.0.0.1:${server.address().port}`;
      const origin = `http://${host}`;
      if (incoming.headers.host !== host ||
          (incoming.headers.origin !== undefined && incoming.headers.origin !== origin)) {
        outgoing.writeHead(403, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ code: 'FIXTURE_ORIGIN_DENIED' }));
        incoming.resume();
        return;
      }
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const requestBody = chunks.length ? Buffer.concat(chunks) : undefined;
      let parsedBody = null;
      if (process.env.CODEXIA_MCP_FIXTURE_MUTATION && requestBody) {
        try { parsedBody = JSON.parse(requestBody.toString('utf8')); } catch { /* The stock suite also sends malformed JSON. */ }
      }
      const request = new Request(`${origin}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        signal: abort.signal,
        ...(requestBody ? { body: requestBody, duplex: 'half' } : {}),
      });
      const mutation = process.env.CODEXIA_MCP_FIXTURE_MUTATION;
      const response = await contribution.handle(request, actionContext());
      if (mutation === 'missing-jsonrpc-id' && parsedBody?.method === 'tools/list' && response.ok) {
        const json = await response.json();
        delete json.id;
        const headers = Object.fromEntries(response.headers.entries());
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        outgoing.writeHead(response.status, headers);
        outgoing.end(JSON.stringify(json));
        return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (!response.body) {
        outgoing.end();
        return;
      }
      await pipeline(Readable.fromWeb(response.body), outgoing, { signal: abort.signal });
    } catch (error) {
      if (!abort.signal.aborted) {
        process.stderr.write(`Synthetic MCP conformance fixture failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        if (!outgoing.headersSent) {
          outgoing.writeHead(500, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ code: 'FIXTURE_INTERNAL_ERROR' }));
        } else if (!outgoing.destroyed) {
          outgoing.destroy();
        }
      }
    } finally {
      cleanup();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.stdout.write(`READY http://127.0.0.1:${server.address().port}/mcp\n`);
}
