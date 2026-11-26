import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';

const target = new URL(process.env.CODEXIA_MCP_PROXY_TARGET);
const token = process.env.CODEXIA_MCP_PROXY_TOKEN;
if (!token || target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) throw new Error('Conformance proxy requires a bearer token and loopback API target');
const server = createServer(async (request, response) => {
  const disconnect = new AbortController();
  const onDisconnect = () => { if (!response.writableEnded) disconnect.abort(); };
  response.once('close', onDisconnect);
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const upstreamUrl = new URL(target);
    const incomingUrl = new URL(request.url, 'http://127.0.0.1');
    upstreamUrl.pathname = incomingUrl.pathname;
    if (incomingUrl.search) upstreamUrl.search = incomingUrl.search;
    // Translate only the legitimate loopback proxy authority. Preserve an
    // untrusted Host/Origin so the product's admission layer must reject it.
    // The socket destination remains the fixed loopback target, never a header.
    const proxyHost = `127.0.0.1:${server.address().port}`;
    const headers = { ...request.headers, authorization: `Bearer ${token}` };
    if (headers.host === proxyHost) headers.host = target.host;
    if (headers.origin === `http://${proxyHost}`) headers.origin = target.origin;
    const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(60_000)]);
    // Node fetch may normalize Host to the destination, masking the negative
    // test. The HTTP client preserves the supplied header and cannot redirect.
    const upstream = await new Promise((resolve, reject) => {
      const outgoing = httpRequest(upstreamUrl, { method: request.method, headers, signal }, resolve);
      outgoing.once('error', reject);
      outgoing.end(body);
    });
    response.writeHead(upstream.statusCode, upstream.headers);
    await pipeline(upstream, response, { signal });
  } catch {
    if (disconnect.signal.aborted || response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'CONFORMANCE_PROXY_UPSTREAM_ERROR' }));
  } finally {
    response.removeListener('close', onDisconnect);
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.stdout.write(`READY http://127.0.0.1:${server.address().port}/mcp\n`);
