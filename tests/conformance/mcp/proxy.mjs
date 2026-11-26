import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';

const target = new URL(process.env.CODEXIA_MCP_PROXY_TARGET);
const token = process.env.CODEXIA_MCP_PROXY_TOKEN;
if (!token || target.hostname !== '127.0.0.1') throw new Error('Conformance proxy requires a bearer token and loopback API target');
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const upstreamUrl = new URL(target);
  const incomingUrl = new URL(request.url, 'http://127.0.0.1');
  upstreamUrl.pathname = incomingUrl.pathname;
  if (incomingUrl.search) upstreamUrl.search = incomingUrl.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('authorization', `Bearer ${token}`);
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    ...(body ? { body, duplex: 'half' } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
  if (!upstream.body) { response.end(); return; }
  await new Promise((resolve, reject) => {
    Readable.fromWeb(upstream.body).on('error', reject).pipe(response).on('finish', resolve).on('error', reject);
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.stdout.write(`READY http://127.0.0.1:${server.address().port}/mcp\n`);
