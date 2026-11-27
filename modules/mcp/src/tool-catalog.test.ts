import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ActionDescriptor } from '@codexia/contracts';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { registerMcpTools } from './tools.js';

const identity = { name: 'codexia-tool-contract-test', version: '1.0.0' };

// Public names captured before the SDK migration, independent of the registrar.
const publicToolNames = [
  'analyze_manuscript',
  'changeset.get',
  'changesets.list',
  'check_consistency',
  'check_continuity',
  'check_plot_semantics',
  'check_style_deviations',
  'check_stylometric_deviations',
  'check_voice_consistency',
  'compute_cooccurrence',
  'create_scene',
  'discover_actions',
  'evidence.anchor.get',
  'evidence.assertion.get',
  'evidence.assertion.list',
  'evidence.document.list',
  'evidence.node.list',
  'format_manuscript',
  'get_change_set',
  'get_context_manifest',
  'get_diagnostics',
  'get_dialogue',
  'get_entity',
  'get_history',
  'get_observation',
  'get_scene_context',
  'get_status',
  'get_thread_status',
  'get_volume_tree',
  'get_writing_context',
  'invoke_action',
  'knowledge.aliases.list',
  'knowledge.merge.preview',
  'knowledge.merge.propose',
  'knowledge.node.get',
  'knowledge.nodes.list',
  'knowledge.propose',
  'knowledge.relations.list',
  'lint_manuscript',
  'list_change_sets',
  'list_entities',
  'list_projects',
  'search',
  'search_lexical',
  'story.context.package',
  'story.narrative.review',
  'story.scenario.adopt',
  'story.scenario.compare',
  'story.scenario.list',
  'story.scenario.save',
  'story.world-state.temporal',
  'submit_change_set',
  'update_entity',
];

async function connectToolClient(t: TestContext, actions: ActionDescriptor[] = []) {
  const client = new Client(identity);
  const server = new McpServer(identity);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const calls: Array<{ actionId: string; input: unknown }> = [];
  const snapshot = { projectId: 'tool-contract-project', projectVersion: 1 };
  registerMcpTools(server, {
    projectId: snapshot.projectId,
    async listActions() {
      return actions;
    },
    async invoke(actionId, input) {
      calls.push({ actionId, input });
      return { ok: true, snapshot, data: { actionId } };
    },
    async propose() {
      throw new Error('Unexpected direct proposal');
    },
  });

  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls };
}

test('[TEST-MCPV-001-002] MCP tools/list publishes the compatible tool names and object input schemas', async t => {
  const { client } = await connectToolClient(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), publicToolNames);
  for (const { name, inputSchema } of tools) {
    assert.equal(inputSchema.type, 'object', name);
    const schema = JSON.parse(JSON.stringify(inputSchema)) as { properties?: Record<string, unknown>; required?: string[] };
    assert.ok(schema.properties && typeof schema.properties === 'object', `${name} exposes generated properties`);
    assert.ok(
      (schema.required ?? []).every(field => Object.hasOwn(schema.properties!, field)),
      `${name} required fields exist in generated properties`,
    );
  }

  const listProjects = tools.find(tool => tool.name === 'list_projects')!;
  const listProjectProperties = listProjects.inputSchema.properties;
  assert.ok(listProjectProperties, 'list_projects exposes generated properties');
  assert.equal((listProjectProperties.limit as { default?: number }).default, 200);
  const invokeAction = tools.find(tool => tool.name === 'invoke_action')!;
  assert.ok(invokeAction.inputSchema.required?.includes('action_id'));
  const propose = tools.find(tool => tool.name === 'knowledge.propose')!;
  for (const field of ['project_version', 'idempotency_key', 'operations']) {
    assert.ok(propose.inputSchema.required?.includes(field), field);
  }
});

test('MCP tools/call rejects invalid arguments before dispatching the action', async t => {
  const readAction: ActionDescriptor = { id: 'search.query', module: 'search', effect: 'read' };
  const { client, calls } = await connectToolClient(t, [readAction]);
  const result = await client.callTool({ name: 'invoke_action', arguments: { action_id: readAction.id, input: [] } });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('MCP generic dispatch rejects author operations even with a proposal catalog entry', async t => {
  const authorOperations = ['core.approve', 'core.apply'];
  const proposalAction = 'core.knowledge.propose';
  const actions: ActionDescriptor[] = [...authorOperations, proposalAction].map(id => ({ id, module: 'core', effect: 'propose' }));
  const { client, calls } = await connectToolClient(t, actions);

  for (const actionId of authorOperations) {
    const result = await client.callTool({ name: 'invoke_action', arguments: { action_id: actionId } });
    assert.equal(result.isError, true, actionId);
    assert.partialDeepStrictEqual(result.structuredContent, { error: { code: 'FORBIDDEN' } }, actionId);
  }
  assert.deepEqual(calls, []);

  const result = await client.callTool({ name: 'invoke_action', arguments: { action_id: proposalAction } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ actionId: proposalAction, input: {} }]);
});
