import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureOrigin } from './k6-target.mjs';

export async function startFixture(readScene) {
  const token = randomBytes(24).toString('hex');
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || request.headers['x-codexia-fixture'] !== token) {
      response.writeHead(404).end();
      return;
    }
    switch (request.url) {
      case '/ready':
        response.writeHead(204, { 'x-codexia-fixture': token }).end();
        break;
      case '/scene':
        try {
          const started = performance.now();
          const body = await readScene();
          response.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'server-timing': `pg;dur=${(performance.now() - started).toFixed(3)}`,
          }).end(body);
        } catch {
          response.writeHead(500).end();
        }
        break;
      case '/stream':
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: ready\n\n');
        await delay(10);
        if (!response.destroyed) response.end('data: complete\n\n');
        break;
      default:
        response.writeHead(404).end();
    }
  });
  server.listen({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const origin = fixtureOrigin(`http://127.0.0.1:${server.address().port}`);
  return { server, origin, token };
}
