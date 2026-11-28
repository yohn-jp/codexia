import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { collectTraceNodes, findTraceHtmlDocuments } from './verify.mjs';

async function serveStaticOutput(root) {
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const filePath = path.resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const content = await readFile(filePath);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': content.length,
        'Content-Type': contentTypes[path.extname(filePath)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind StrictDoc preview server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('[TEST-TRC-07-001] renders every trace UID from the staged StrictDoc HTML documents', async () => {
  const outputDir = process.env.CODEXIA_STRICTDOC_OUTPUT_DIR;
  assert.ok(outputDir, 'CODEXIA_STRICTDOC_OUTPUT_DIR must point to generated StrictDoc artifacts');
  const jsonPath = path.join(outputDir, 'json', 'index.json');
  const source = JSON.parse(await readFile(jsonPath, 'utf8'));
  const ids = collectTraceNodes(source).map(node => node.UID);
  assert.ok(ids.some(id => id.startsWith('REQ-')), 'the staged JSON must contain requirement nodes');
  const htmlDocuments = await findTraceHtmlDocuments(outputDir, ids);

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CODEXIA_STRICTDOC_CHROMIUM ? { executablePath: process.env.CODEXIA_STRICTDOC_CHROMIUM } : {}),
  });
  const staticServer = await serveStaticOutput(path.resolve(outputDir));
  try {
    const page = await browser.newPage();
    for (const [file, fileIds] of htmlDocuments) {
      const htmlPath = file.split('/').map(encodeURIComponent).join('/');
      const response = await page.goto(`${staticServer.baseUrl}/${htmlPath}`, { waitUntil: 'domcontentloaded' });
      assert.equal(response?.ok(), true, `the staged HTML page must load: ${file}`);
      const pageText = await page.locator('body').innerText();
      for (const id of fileIds) assert.ok(pageText.includes(id), `visible StrictDoc HTML is missing ${id} in ${file}`);
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => staticServer.server.close((error) => error ? reject(error) : resolve()));
  }
});
