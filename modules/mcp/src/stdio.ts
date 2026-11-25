#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ApiClient } from './api-client.js';
import { isMcpStrict } from './protocol-version.js';
import { createCodexiaMcpServer } from './tools.js';

const accessToken = process.env.CODEXIA_MCP_ACCESS_TOKEN;
if (!accessToken) {
  process.stderr.write('Set CODEXIA_MCP_ACCESS_TOKEN to a current OAuth access token issued to an MCP client.\n');
  process.exitCode = 1;
} else {
  const client = new ApiClient({
    baseUrl: process.env.CODEXIA_API_URL ?? 'http://127.0.0.1:3000',
    token: accessToken,
    projectId: process.env.CODEXIA_PROJECT_ID || undefined,
  });
  serveStdio(() => createCodexiaMcpServer(client), {
    legacy: isMcpStrict() ? 'reject' : 'serve',
  });
}
