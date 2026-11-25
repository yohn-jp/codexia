import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { registerProjectTools } from './tools/project.js';

test('MCP project discovery accepts an opaque continuation and identifies the last page', async t => {
  const server = new McpServer({ name: 'project-fixture', version: '1.0.0' });
  const client = new Client({ name: 'project-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const firstProject = { id: 'project-one', title: 'One' };
  const lastProject = { id: 'project-two', title: 'Two' };
  const cursor = 'opaque-cursor';
  registerProjectTools(server, {
    async listProjectPage(limit, after) {
      if (limit !== 1) throw new Error('the project fixture supplies one row per page');
      if (after === undefined) return { projects: [firstProject], nextCursor: cursor };
      if (after === cursor) return { projects: [lastProject], nextCursor: null };
      throw new Error('the caller changed the cursor');
    },
    async listActions() {
      return [];
    },
    async invoke() {
      throw new Error('unexpected action invocation');
    },
    async propose() {
      throw new Error('unexpected proposal');
    },
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const first = await client.callTool({ name: 'list_projects', arguments: { limit: 1 } });
  assert.deepEqual(first.structuredContent, { data: { projects: [firstProject], next_cursor: cursor } });
  const page = first.structuredContent?.data as { next_cursor: string };
  const last = await client.callTool({
    name: 'list_projects',
    arguments: { limit: 1, cursor: page.next_cursor },
  });
  assert.deepEqual(last.structuredContent, { data: { projects: [lastProject], next_cursor: null } });
});
