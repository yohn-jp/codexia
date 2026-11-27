import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionDescriptor, ActionResult, ChangeProposal, ModuleActionContext, SnapshotId } from '@codexia/contracts';
import { Client, type FetchLike, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server';
import { createMcpHttpContribution } from './http.js';
import { MCP_2025_PROTOCOL_CUTOFF } from './protocol-version.js';

const snapshot: SnapshotId = {
  projectId: 'project-one',
  projectVersion: 11,
};

function actionContext(
  calls: string[],
  extraActions: ActionDescriptor[] = [],
  onStatusSignal?: (signal: AbortSignal | undefined) => void,
  sourceOperationIds: string[] = ['op-one'],
  fixtureProposalId?: string,
) {
  const actions: ActionDescriptor[] = [
    { id: 'core.status', module: 'core', effect: 'read' },
    { id: 'story.snapshot.materialize', module: 'story', effect: 'read' },
    { id: 'story.context.package', module: 'story', effect: 'read' },
    { id: 'story.changes.propose', module: 'story', effect: 'propose' },
    ...extraActions,
  ];
  const reader = {
    snapshot,
    async read() {
      return null;
    },
    async list() {
      return [];
    },
  };
  let storedProposal: ChangeProposal | undefined;
  let storedProposalStatus: unknown;
  return {
    projectId: 'project-one',
    reader,
    async listActions() {
      return actions;
    },
    async invoke(actionId: string, input: unknown, signal?: AbortSignal): Promise<ActionResult> {
      calls.push(actionId);
      if (actionId === 'core.status') {
        if (onStatusSignal) {
          onStatusSignal(signal);
          if (signal) {
            await new Promise<void>(resolve => {
              if (signal.aborted) return resolve();
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
        }
        return { ok: true, snapshot, data: { status: 'ready' } };
      }
      if (actionId === 'story.snapshot.materialize') {
        return { ok: true, snapshot, data: { entities: 7, links: 11 } };
      }
      if (actionId === 'story.context.package') {
        return {
          ok: true,
          snapshot,
          data: { sceneId: 'scene-one', scope: 'reader', parts: [{ kind: 'reader-disclosure', value: { sceneId: 'scene-one' } }] },
        };
      }
      if (actionId === 'story.changes.propose') {
        const changeSet = input as { id: string; projectId: string; operations: Array<{ id: string }> };
        const coreProposalId = fixtureProposalId ?? changeSet.id;
        const operationMap = Object.fromEntries(sourceOperationIds.map(id => [id, id]));
        const resultIds = Object.fromEntries(sourceOperationIds.map((id, index) => [id, `char-${index ? 'two' : 'one'}`]));
        const resultPaths = Object.fromEntries(
          sourceOperationIds.map((id, index) => [id, [`characters/char-${index ? 'two' : 'one'}.yaml`]]),
        );
        const resultRevisions = Object.fromEntries(sourceOperationIds.map(id => [id, `sha256-${id}`]));
        const sourceDetails = {
          sourceChangeSet: input,
          sourceFingerprint: 'f'.repeat(64),
          submittedAt: '2026-10-17T00:00:00.000Z',
          coreProposalId,
          operationMap,
          resultIds,
          resultPaths,
          resultRevisions,
          affectedEntities: {},
        };
        const proposal: ChangeProposal = {
          id: coreProposalId,
          snapshot,
          operations: sourceOperationIds.map((id, index) => ({
            id,
            generation: 0,
            projectId: snapshot.projectId,
            baseProjectVersion: snapshot.projectVersion,
            effect: 'metadata',
            reads: [],
            writes: [
              {
                path: `characters/char-${index ? 'two' : 'one'}.yaml`,
                revision: 'a'.repeat(64),
                content: 'updated',
              },
            ],
            message: 'test source change',
          })),
          source: 'mcp',
          evidence: [
            {
              id: 'ncs-one',
              snapshot,
              module: 'story',
              kind: 'source.narrative-change-set.v1',
              paths: [],
              details: sourceDetails,
            },
          ],
        };
        storedProposal = proposal;
        storedProposalStatus = {
          proposal,
          state: 'proposed',
          approvedOperationIds: [],
          applications: [],
          stale: false,
        };
        return {
          ok: true,
          snapshot,
          data: {
            changeSetId: changeSet.id,
            proposalId: coreProposalId,
            coreProposalId,
            submittedAt: sourceDetails.submittedAt,
            sourceFingerprint: sourceDetails.sourceFingerprint,
            operationIds: sourceOperationIds,
            operationMap,
            dependencies: {},
            resultIds,
            resultPaths,
            resultRevisions,
            affectedEntities: {},
            replayed: false,
          },
          proposals: [proposal],
        };
      }
      if (actionId === 'core.proposals.get' && storedProposal && storedProposalStatus) {
        const { proposalId } = input as { proposalId?: unknown };
        if (proposalId === storedProposal.id) {
          return { ok: true, snapshot, data: { proposal: storedProposalStatus } };
        }
      }
      if (actionId === 'core.proposals.list') {
        return { ok: true, snapshot, data: { proposals: storedProposalStatus ? [storedProposalStatus] : [] } };
      }
      if (actionId === 'story.cooccurrence') {
        return { ok: true, snapshot, data: { edges: [], gaps: [] } };
      }
      if (actionId === 'diagnostics.checkConsistency') {
        return { ok: true, snapshot, data: { ok: true, scope: null, issues: [] } };
      }
      if (actionId === 'diagnostics.checkContinuity') {
        return { ok: true, snapshot, data: { scope: null, warnings: [] } };
      }
      return { ok: false, snapshot, error: { code: 'not_found', message: 'Unknown action', retryable: false } };
    },
    async linkedReader() {
      return reader;
    },
    signal: new AbortController().signal,
    async propose() {
      throw new Error('Read-only test action unexpectedly proposed');
    },
    async runJob() {
      throw new Error('MCP must not start a model job');
    },
    setProposalReview(approvedOperationIds: string[], applications: unknown[]) {
      if (!storedProposalStatus || typeof storedProposalStatus !== 'object') throw new Error('No proposal is stored');
      storedProposalStatus = {
        ...(storedProposalStatus as Record<string, unknown>),
        state: applications.length ? 'applied' : approvedOperationIds.length ? 'approved' : 'proposed',
        approvedOperationIds,
        applications,
      };
    },
    setProposalPayloadIncomplete(approvedOperationIds: string[], applications: unknown[], appliedOperationIds: string[] = []) {
      if (!storedProposalStatus || !storedProposal || typeof storedProposalStatus !== 'object') throw new Error('No proposal is stored');
      storedProposal = {
        ...storedProposal,
        operations: storedProposal.operations.filter(operation => approvedOperationIds.includes(operation.id)),
        evidence: [],
      };
      storedProposalStatus = {
        ...(storedProposalStatus as Record<string, unknown>),
        proposal: storedProposal,
        payloadComplete: false,
        originalDigest: 'e'.repeat(64),
        operationIds: sourceOperationIds,
        approvedOperationIds,
        applications,
        appliedOperationIds,
        state: applications.length ? 'partially_approved' : approvedOperationIds.length ? 'approved' : 'proposed',
      };
    },
  } satisfies ModuleActionContext & {
    setProposalReview(approvedOperationIds: string[], applications: unknown[]): void;
    setProposalPayloadIncomplete(approvedOperationIds: string[], applications: unknown[], appliedOperationIds?: string[]): void;
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/mcp/streamable', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

async function responseBodyAsJson(response: Response): Promise<unknown> {
  const text = await response.text();
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

test('[TEST-MCPV-007-001] MCP HTTP serves modern per-request envelopes through the official v2 client', async () => {
  const host = actionContext([]);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/mcp/streamable'), { fetch });
  const client = new Client({ name: 'mcp-modern-smoke', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.ok(result.tools.some(tool => tool.name === 'get_status'));
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('[TEST-MCPV-007-002] MCP HTTP accepts the temporary stateless 2025 fallback', async () => {
  const response = await createMcpHttpContribution().handle(
    request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    actionContext([]),
  );
  assert.equal(response.status, 200);
  assert.ok(((await responseBodyAsJson(response)) as { result?: { tools?: unknown[] } }).result?.tools);
});

test('[TEST-MCPV-007-003] strict MCP HTTP rejects legacy traffic and delegates invalid methods', async () => {
  const contribution = createMcpHttpContribution({ strict: true });
  const legacy = await contribution.handle(request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), actionContext([]));
  assert.equal(legacy.status, 400);
  const get = await contribution.handle(new Request('http://localhost/mcp/streamable', { method: 'GET' }), actionContext([]));
  assert.equal(get.status, 405);
  const deleteResponse = await contribution.handle(new Request('http://localhost/mcp/streamable', { method: 'DELETE' }), actionContext([]));
  assert.equal(deleteResponse.status, 405);
});

test('[TEST-MCPV-006-003] modern Mcp-Method and Mcp-Name mismatches are rejected before tool dispatch', async () => {
  const cases = [
    { header: 'mcp-method', value: 'tools/list' },
    { header: 'mcp-name', value: 'different_tool' },
  ];
  for (const mismatch of cases) {
    const contribution = createMcpHttpContribution({ strict: true });
    const dispatches: string[] = [];
    const host = actionContext([]);
    const listActions = host.listActions;
    const invoke = host.invoke;
    host.listActions = async (...args) => {
      dispatches.push('listActions');
      return listActions(...args);
    };
    host.invoke = async (...args) => {
      dispatches.push('invoke');
      return invoke(...args);
    };
    const response = await contribution.handle(
      request(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_status',
            arguments: { project_id: 'project-one' },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'mismatch-test', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        },
        {
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': mismatch.header === 'mcp-method' ? mismatch.value : 'tools/call',
          'mcp-name': mismatch.header === 'mcp-name' ? mismatch.value : 'get_status',
        },
      ),
      host,
    );
    assert.equal(response.status, 400, mismatch.header);
    const payload = (await response.json()) as { error?: { code?: number } };
    assert.equal(payload.error?.code, -32020, mismatch.header);
    assert.deepEqual(dispatches, [], mismatch.header);
  }
});

test('[TEST-MCPV-006-004] oversized MCP request body is refused before creating the SDK action context', async () => {
  const contribution = createMcpHttpContribution({ strict: true });
  let contextAccesses = 0;
  const host = new Proxy(actionContext([]), {
    get(target, property, receiver) {
      if (property === 'projectId') contextAccesses++;
      return Reflect.get(target, property, receiver);
    },
  }) as ModuleActionContext;
  const response = await contribution.handle(
    new Request('http://localhost/mcp/streamable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: 'x'.repeat(DEFAULT_MAX_REQUEST_BODY_SIZE + 1),
    }),
    host,
  );
  assert.equal(response.status, 413);
  assert.equal(contextAccesses, 0);
});

test('production HTTP mode switches from stateless fallback to strict at the cutoff', async () => {
  const before = await createMcpHttpContribution({ now: () => MCP_2025_PROTOCOL_CUTOFF - 1 }).handle(
    request({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    actionContext([]),
  );
  assert.equal(before.status, 200);
  const after = await createMcpHttpContribution({ now: () => MCP_2025_PROTOCOL_CUTOFF }).handle(
    request({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    actionContext([]),
  );
  assert.equal(after.status, 400);
});

test('SDK Streamable HTTP transport lists and invokes tools through the host action context', async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    const sourceTools = [
      'get_entity',
      'get_scene_context',
      'list_entities',
      'search',
      'get_volume_tree',
      'analyze_manuscript',
      'check_stylometric_deviations',
      'check_plot_semantics',
      'get_diagnostics',
      'get_thread_status',
      'get_dialogue',
      'format_manuscript',
      'create_scene',
      'update_entity',
      'check_consistency',
      'check_continuity',
      'compute_cooccurrence',
      'check_voice_consistency',
      'check_style_deviations',
      'get_writing_context',
      'get_context_manifest',
      'lint_manuscript',
      'submit_change_set',
      'get_change_set',
      'list_change_sets',
    ];
    assert.equal(names.has('suggest_rewrite'), false);
    assert.equal(names.has('reload'), false);
    assert.ok(sourceTools.every(name => names.has(name)));
    assert.ok(names.has('discover_actions'));
    assert.ok(names.has('get_status'));

    const result = await client.callTool({ name: 'get_status', arguments: { project_id: 'project-one' } });
    assert.deepEqual(result.structuredContent, {
      snapshot,
      data: { status: 'ready' },
    });
    const context = await client.callTool({ name: 'story.context.package', arguments: { scene_id: 'scene-one', scope: 'reader' } });
    assert.deepEqual(context.structuredContent, {
      snapshot,
      data: { sceneId: 'scene-one', scope: 'reader', parts: [{ kind: 'reader-disclosure', value: { sceneId: 'scene-one' } }] },
    });
    assert.deepEqual(calls, ['core.status', 'story.context.package']);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('writing context and its metadata-only manifest expose saved-scene provenance over SDK HTTP', async () => {
  const sceneSnapshot = { projectId: 'project-one', projectVersion: 11 };
  const title = '雪🌙';
  const savedText = '港𠮷。';
  const selection = { from: 2, to: 5, text: '選𠮷' };
  const host = actionContext([], [{ id: 'story.scene.context', module: 'story', effect: 'read' }]);
  host.reader = { ...host.reader, snapshot: sceneSnapshot };
  // Stub the admitted Story action; the SDK transport and MCP projection are real.
  host.invoke = async (actionId, input) => {
    assert.equal(actionId, 'story.scene.context');
    assert.deepEqual(input, { sceneId: 'scene-one' });
    return {
      ok: true,
      snapshot: sceneSnapshot,
      data: {
        scene: { id: 'scene-one', title },
        sceneRevision: 'scene-rev-1',
        manuscript: { id: 'manuscript-one' },
        manuscriptRevision: 'manuscript-rev-1',
        manuscriptBody: savedText,
      },
    };
  };
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client(
    { name: 'mcp-writing-context-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );

  const sceneIdentity = { project_id: 'project-one', scene_id: 'scene-one' };
  const expectedParts = [
    { kind: 'scene', source: 'arcadia', source_identity: sceneIdentity, revision: 'scene-rev-1', characters: 2, bytes: 7 },
    {
      kind: 'saved_manuscript',
      source: 'arcadia',
      source_identity: { ...sceneIdentity, manuscript_id: 'manuscript-one' },
      revision: 'manuscript-rev-1',
      characters: 3,
      bytes: 10,
    },
    {
      kind: 'selection',
      source: 'mcp_client',
      source_identity: { ...sceneIdentity, from: 2, to: 5 },
      revision: null,
      characters: 2,
      bytes: 7,
    },
  ];
  const args = { project_id: 'project-one', scene_id: 'scene-one', selection };

  try {
    await client.connect(transport);
    for (const [tool, metadataOnly] of [
      ['get_writing_context', false],
      ['get_context_manifest', true],
    ] as const) {
      const result = await client.callTool({ name: tool, arguments: args });
      assert.equal(result.isError, undefined);
      const response = result.structuredContent as {
        snapshot: SnapshotId;
        data: Record<string, unknown> & { parts?: Array<{ kind: string }>; manifest?: { parts: Array<{ kind: string }> } };
      };
      assert.deepEqual(response.snapshot, sceneSnapshot);
      const manifest = metadataOnly ? response.data : response.data.manifest;
      assert.ok(manifest);
      assert.partialDeepStrictEqual(manifest, {
        scope: 'arcadia_provided_context',
        external_host_final_prompt_observed: false,
        draft: { status: 'not_shared' },
      });
      assert.deepEqual(
        manifest.parts?.map(part => part.kind),
        expectedParts.map(part => part.kind),
        tool,
      );
      for (const [index, { characters, bytes, ...provenance }] of expectedParts.entries()) {
        assert.partialDeepStrictEqual(manifest.parts?.[index], {
          ...provenance,
          metadata_included: true,
          dropped: metadataOnly,
          trimmed: false,
          size: {
            source_character_count: characters,
            included_character_count: metadataOnly ? 0 : characters,
            included_byte_count: metadataOnly ? 0 : bytes,
            token_count: null,
            token_count_status: 'not_measured',
          },
        });
      }

      assert.ok(Array.isArray(result.content));
      assert.equal(result.content.length, 1);
      const [content] = result.content;
      assert.ok(content?.type === 'text' && typeof content.text === 'string');
      assert.deepEqual(JSON.parse(content.text), response, tool);
      if (metadataOnly) {
        assert.equal('manifest' in response.data, false);
        for (const text of [title, savedText, selection.text]) assert.equal(content.text.includes(text), false, tool);
      } else {
        assert.partialDeepStrictEqual(response.data, {
          scene: { id: 'scene-one', title, revision: 'scene-rev-1' },
          saved_manuscript: { id: 'manuscript-one', revision: 'manuscript-rev-1', text: savedText },
          selection: { ...selection, status: 'client_provided' },
          draft: { status: 'not_shared' },
        });
      }
    }
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('the canonical Story materializer is discoverable and reads the selected snapshot', async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

  try {
    await client.connect(transport);
    const catalog = await client.callTool({ name: 'discover_actions', arguments: { project_id: 'project-one' } });
    const discovered = catalog.structuredContent as { data: { actions: ActionDescriptor[] } };
    assert.ok(discovered.data.actions.some(action => action.id === 'story.snapshot.materialize' && action.effect === 'read'));

    const result = await client.callTool({
      name: 'invoke_action',
      arguments: {
        project_id: 'project-one',
        action_id: 'story.snapshot.materialize',
        input: {},
      },
    });
    assert.deepEqual(result.structuredContent, {
      snapshot,
      data: { entities: 7, links: 11 },
    });
    assert.deepEqual(calls, ['story.snapshot.materialize']);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('MCP refuses action names that could approve or publish author changes', async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'invoke_action',
      arguments: { project_id: 'project-one', action_id: 'core.checkpoint', input: {} },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(calls, []);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('compute_cooccurrence maps to the Story co-occurrence action without extra source arguments', async () => {
  const calls: string[] = [];
  const host = actionContext(calls, [{ id: 'story.cooccurrence', module: 'story', effect: 'read' }]);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const cooccurrence = tools.find(tool => tool.name === 'compute_cooccurrence');
    assert.ok(cooccurrence);
    assert.equal('scope' in (cooccurrence.inputSchema.properties ?? {}), false);
    const result = await client.callTool({ name: 'compute_cooccurrence', arguments: { project_id: 'project-one' } });
    assert.deepEqual(result.structuredContent, { snapshot, data: { edges: [], gaps: [] } });
    assert.deepEqual(calls, ['story.cooccurrence']);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('consistency and continuity use their exact project-level diagnostics actions', async () => {
  const calls: string[] = [];
  const host = actionContext(calls, [
    { id: 'diagnostics.checkConsistency', module: 'diagnostics', effect: 'read' },
    { id: 'diagnostics.checkContinuity', module: 'diagnostics', effect: 'read' },
  ]);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ['check_consistency', 'check_continuity']) {
      const tool = tools.find(candidate => candidate.name === name);
      assert.ok(tool);
      assert.equal('scope' in (tool.inputSchema.properties ?? {}), false);
    }
    const consistency = await client.callTool({ name: 'check_consistency', arguments: { project_id: 'project-one' } });
    assert.deepEqual(consistency.structuredContent, {
      snapshot,
      data: { ok: true, issue_count: 0, issues: [] },
    });
    const continuity = await client.callTool({ name: 'check_continuity', arguments: { project_id: 'project-one' } });
    assert.deepEqual(continuity.structuredContent, { snapshot, data: [] });
    assert.deepEqual(calls, ['diagnostics.checkConsistency', 'diagnostics.checkContinuity']);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('submit_change_set returns a source ChangeSetRecord with its source ID', async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const changeSet = {
    schemaVersion: 1,
    id: 'cs-one',
    projectId: 'project-one',
    goal: 'Update the character profile',
    status: 'proposed',
    assessment: { confidence: 0.9, risk: 'low' },
    operations: [
      {
        id: 'op-one',
        kind: 'entity.update',
        precondition: { kind: 'revision', value: 'r1' },
        target: { entityId: 'char-one' },
        changes: { name: 'New name' },
        evidenceIds: ['evidence-one'],
        assessment: { confidence: 0.9, risk: 'low' },
      },
    ],
    evidence: [{ id: 'evidence-one', sourceKind: 'entity', sourceId: 'char-one', revision: 'r1' }],
    diagnostics: { before: null, after: null },
  };

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'submit_change_set',
      arguments: { project_id: 'project-one', change_set: changeSet },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls, ['story.changes.propose', 'core.proposals.get']);
    const record = result.structuredContent as { changeSet: { id: string }; status: string; fingerprint: string };
    assert.equal(record.changeSet.id, 'cs-one');
    assert.equal(record.status, 'proposed');
    assert.equal(record.fingerprint, 'f'.repeat(64));
    const listed = await client.callTool({ name: 'list_change_sets', arguments: { project_id: 'project-one' } });
    assert.deepEqual((listed.structuredContent as { change_sets: Array<{ change_set_id: string; status: string }> }).change_sets, [
      {
        change_set_id: 'cs-one',
        project_id: 'project-one',
        status: 'proposed',
        submitted_at: '2026-10-17T00:00:00.000Z',
        operation_ids: ['op-one'],
      },
    ]);
    const fetched = await client.callTool({ name: 'get_change_set', arguments: { project_id: 'project-one', change_set_id: 'cs-one' } });
    assert.deepEqual(fetched.structuredContent, record);
    host.setProposalReview(
      ['op-one'],
      [
        {
          operationId: 'op-one',
          generation: 0,
          projectVersion: 4,
          remoteBase: 'a'.repeat(40),
          revisions: [{ path: 'characters/char-one.yaml', revision: 'b'.repeat(64) }],
        },
      ],
    );
    const applied = await client.callTool({ name: 'get_change_set', arguments: { project_id: 'project-one', change_set_id: 'cs-one' } });
    const appliedRecord = applied.structuredContent as {
      status: string;
      approvedOperationIds: string[];
      result: { status: string; operations: Array<{ operationId: string; resultId: string; resultingRevision: string }> };
    };
    assert.equal(appliedRecord.status, 'applied');
    assert.deepEqual(appliedRecord.approvedOperationIds, ['op-one']);
    assert.deepEqual(appliedRecord.result.operations, [
      {
        operationId: 'op-one',
        kind: 'entity.update',
        precondition: { kind: 'revision', value: 'r1' },
        resultingRevision: 'sha256-op-one',
        resultId: 'char-one',
      },
    ]);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('ChangeSet readback preserves approved IDs while selected applications are pending', async () => {
  const calls: string[] = [];
  const host = actionContext(calls, [], undefined, ['op-one', 'op-two']);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const changeSet = {
    schemaVersion: 1,
    id: 'cs-two-operations',
    projectId: 'project-one',
    goal: 'Update two character profiles',
    status: 'proposed',
    assessment: { confidence: 0.9, risk: 'low' },
    operations: ['op-one', 'op-two'].map((id, index) => ({
      id,
      kind: 'entity.update',
      precondition: { kind: 'revision', value: `r${index + 1}` },
      target: { entityId: `char-${index ? 'two' : 'one'}` },
      changes: { name: `New name ${index + 1}` },
      evidenceIds: [`evidence-${index + 1}`],
      assessment: { confidence: 0.9, risk: 'low' },
    })),
    evidence: [1, 2].map(index => ({
      id: `evidence-${index}`,
      sourceKind: 'entity',
      sourceId: `char-${index === 1 ? 'one' : 'two'}`,
      revision: `r${index}`,
    })),
    diagnostics: { before: null, after: null },
  };

  try {
    await client.connect(transport);
    const submitted = await client.callTool({
      name: 'submit_change_set',
      arguments: { project_id: 'project-one', change_set: changeSet },
    });
    assert.notEqual(submitted.isError, true);
    host.setProposalReview(
      ['op-one', 'op-two'],
      [
        {
          operationId: 'op-one',
          generation: 0,
          projectVersion: 4,
          remoteBase: 'a'.repeat(40),
          revisions: [{ path: 'characters/char-one.yaml', revision: 'b'.repeat(64) }],
        },
      ],
    );
    const mixed = await client.callTool({
      name: 'get_change_set',
      arguments: { project_id: 'project-one', change_set_id: 'cs-two-operations' },
    });
    const mixedRecord = mixed.structuredContent as { status: string; approvedOperationIds: string[]; result?: unknown };
    assert.equal(mixedRecord.status, 'approved');
    assert.deepEqual(mixedRecord.approvedOperationIds, ['op-one', 'op-two']);
    assert.equal('result' in mixedRecord, false);

    host.setProposalReview(
      ['op-one'],
      [
        {
          operationId: 'op-one',
          generation: 0,
          projectVersion: 4,
          remoteBase: 'a'.repeat(40),
          revisions: [{ path: 'characters/char-one.yaml', revision: 'b'.repeat(64) }],
        },
      ],
    );
    const partial = await client.callTool({
      name: 'get_change_set',
      arguments: { project_id: 'project-one', change_set_id: 'cs-two-operations' },
    });
    const partialRecord = partial.structuredContent as {
      status: string;
      approvedOperationIds: string[];
      result: { status: string; operations: Array<{ operationId: string }> };
    };
    assert.equal(partialRecord.status, 'partially-applied');
    assert.deepEqual(partialRecord.approvedOperationIds, ['op-one']);
    assert.deepEqual(partialRecord.result.operations, [
      {
        operationId: 'op-one',
        kind: 'entity.update',
        precondition: { kind: 'revision', value: 'r1' },
        resultingRevision: 'sha256-op-one',
        resultId: 'char-one',
      },
    ]);

    host.setProposalPayloadIncomplete(
      ['op-one'],
      [
        {
          operationId: 'op-one',
          generation: 0,
          projectVersion: 4,
          remoteBase: 'a'.repeat(40),
          revisions: [{ path: 'characters/char-one.yaml', revision: 'b'.repeat(64) }],
        },
      ],
      ['op-one'],
    );
    const unavailable = await client.callTool({
      name: 'get_change_set',
      arguments: { project_id: 'project-one', change_set_id: 'cs-two-operations' },
    });
    assert.equal(unavailable.isError, true);
    const error = unavailable.structuredContent as {
      error: { code: string; details: Record<string, unknown> };
    };
    assert.equal(error.error.code, 'PROPOSAL_PAYLOAD_UNAVAILABLE');
    assert.deepEqual(error.error.details, {
      coreProposalId: 'cs-two-operations',
      sourceChangeSetId: 'cs-two-operations',
      payloadComplete: false,
      originalDigest: 'e'.repeat(64),
      operationIds: ['op-one', 'op-two'],
      approvedOperationIds: ['op-one'],
      appliedOperationIds: ['op-one'],
      state: 'partially_approved',
      recovery:
        'Restore the original browser/private proposal to recover its complete NarrativeChangeSet. This MCP result contains Core review status only.',
    });
    assert.equal(JSON.stringify(unavailable.structuredContent).includes('New name 2'), false);

    const listed = await client.callTool({ name: 'list_change_sets', arguments: { project_id: 'project-one' } });
    assert.deepEqual(listed.structuredContent, {
      change_sets: [],
      incomplete_payloads: [
        {
          coreProposalId: 'cs-two-operations',
          payloadComplete: false,
          originalDigest: 'e'.repeat(64),
          operationIds: ['op-one', 'op-two'],
          approvedOperationIds: ['op-one'],
          appliedOperationIds: ['op-one'],
          state: 'partially_approved',
          recovery:
            'Restore the original browser/private proposal to recover its complete NarrativeChangeSet. This MCP result contains Core review status only.',
        },
      ],
    });
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("submit_change_set maps source IDs outside Core's proposal ID alphabet and length", async () => {
  const calls: string[] = [];
  const coreProposalId = 'story-cs-6cb108930bbfab3d8e96bda05b1363002700113f5997120cfd51cbca02d6e829';
  const host = actionContext(calls, [], undefined, ['op-one'], coreProposalId);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const changeSet = {
    schemaVersion: 1,
    id: `legacy:${'a'.repeat(140)}`,
    projectId: 'project-one',
    goal: 'Update the character profile',
    status: 'proposed',
    assessment: { confidence: 0.9, risk: 'low' },
    operations: [
      {
        id: 'op-one',
        kind: 'entity.update',
        precondition: { kind: 'revision', value: 'r1' },
        target: { entityId: 'char-one' },
        changes: { name: 'New name' },
        evidenceIds: ['evidence-one'],
        assessment: { confidence: 0.9, risk: 'low' },
      },
    ],
    evidence: [{ id: 'evidence-one', sourceKind: 'entity', sourceId: 'char-one', revision: 'r1' }],
    diagnostics: { before: null, after: null },
  };

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'submit_change_set',
      arguments: { project_id: 'project-one', change_set: changeSet },
    });
    assert.notEqual(result.isError, true);
    assert.equal((result.structuredContent as { changeSet: { id: string } }).changeSet.id, changeSet.id);
    assert.deepEqual(calls, ['story.changes.propose', 'core.proposals.get']);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('per-request project scope rejects cross-project tool calls with a machine scope error', async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'get_status',
      arguments: { project_id: 'project-two' },
    });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'PROJECT_SCOPE_MISMATCH');
    assert.deepEqual(calls, []);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('[TEST-MCPV-006-002] aborting the host Web Request closes the modern SDK exchange', async () => {
  const contribution = createMcpHttpContribution();
  let capturedBody: Record<string, unknown> | undefined;
  let capturedHeaders: Headers | undefined;
  const seedHost = actionContext([]);
  const seedFetch: FetchLike = async (url, init) => {
    const incoming = new Request(url, init);
    const body = (await incoming.clone().json()) as Record<string, unknown>;
    if (body.method === 'tools/call') {
      capturedBody = body;
      capturedHeaders = new Headers(incoming.headers);
    }
    return contribution.handle(incoming, seedHost);
  };
  const seedTransport = new StreamableHTTPClientTransport(new URL('http://codexia.test/mcp/streamable'), { fetch: seedFetch });
  const seedClient = new Client({ name: 'mcp-abort-seed', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await seedClient.connect(seedTransport);
  await seedClient.callTool({ name: 'get_status', arguments: { project_id: 'project-one' } });
  await seedClient.close();
  assert.ok(capturedBody && capturedHeaders);

  let releaseAction!: () => void;
  const actionStarted = new Promise<void>(resolve => {
    releaseAction = resolve;
  });
  let signalObserved!: (signal: AbortSignal | undefined) => void;
  const started = new Promise<AbortSignal | undefined>(resolve => {
    signalObserved = resolve;
  });
  const host = actionContext([]);
  host.invoke = async (_actionId: string, _input: unknown, signal?: AbortSignal) => {
    signalObserved(signal);
    await actionStarted;
    return { ok: true, snapshot, data: { status: 'ready' } };
  };
  const controller = new AbortController();
  const requestWithAbort = new Request('http://codexia.test/mcp/streamable', {
    method: 'POST',
    headers: capturedHeaders,
    body: JSON.stringify({ ...capturedBody, id: 987 }),
    signal: controller.signal,
  });
  const pending = contribution.handle(requestWithAbort, host);
  const hostSignal = await Promise.race([
    started,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SDK action did not start')), 2_000)),
  ]);
  assert.ok(hostSignal);
  assert.equal(hostSignal.aborted, false);
  controller.abort(new Error('HTTP client disconnected'));
  const response = await Promise.race([
    pending,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SDK exchange did not close after Request.signal abort')), 2_000)),
  ]);
  assert.equal(response.status, 499);
  releaseAction();
});

test('submit_change_set rejects source records that are not proposed before host invocation', async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const changeSet = {
    schemaVersion: 1,
    id: 'cs-one',
    projectId: 'project-one',
    goal: 'Update the character profile',
    status: 'approved',
    assessment: { confidence: 0.9, risk: 'low' },
    operations: [
      {
        id: 'op-one',
        kind: 'entity.update',
        precondition: { kind: 'revision', value: 'r1' },
        target: { entityId: 'char-one' },
        changes: { name: 'New name' },
        evidenceIds: ['evidence-one'],
        assessment: { confidence: 0.9, risk: 'low' },
      },
    ],
    evidence: [{ id: 'evidence-one', sourceKind: 'entity', sourceId: 'char-one', revision: 'r1' }],
    diagnostics: { before: null, after: null },
  };

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'submit_change_set',
      arguments: { project_id: 'project-one', change_set: changeSet },
    });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'INVALID_INPUT');
    assert.deepEqual(calls, []);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('source tools fail with a module availability error when their producer is not enabled', async () => {
  const calls: string[] = [];
  const host = actionContext(calls);
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'get_dialogue', arguments: { character_id: 'char-one' } });
    assert.equal(result.isError, true);
    assert.deepEqual((result.structuredContent as { error: { code: string } }).error.code, 'MODULE_UNAVAILABLE');
    assert.deepEqual(calls, []);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('hybrid search stays unavailable while full diagnostics invoke the canonical scene aggregate', async () => {
  const calls: string[] = [];
  const host = actionContext(calls, [
    { id: 'core.search', module: 'core', effect: 'read' },
    { id: 'diagnostics.analyze', module: 'diagnostics', effect: 'compute' },
    { id: 'diagnostics.scene', module: 'diagnostics', effect: 'compute' },
  ]);
  const originalInvoke = host.invoke;
  host.invoke = async (actionId: string, input: unknown, signal?: AbortSignal): Promise<ActionResult> => {
    if (actionId === 'diagnostics.scene') {
      calls.push(actionId);
      assert.deepEqual(input, { sceneId: 'scene-one', text: 'draft' });
      return {
        ok: true,
        snapshot,
        data: {
          tier: 'full',
          textHash: '12345678',
          analysis: {},
          speakerAttributions: [],
          estimatedN: 0,
          clusterTrails: [],
          voiceWarnings: [],
          styleDeviations: [],
          stylometricDeviations: [],
          plotSemanticWarnings: [],
          proseBalance: {},
          synonymSuggestions: [],
          issues: [{ id: 'lint-1', kind: 'lint', severity: 'medium', message: 'source issue' }],
        },
      };
    }
    return originalInvoke(actionId, input, signal);
  };
  const contribution = createMcpHttpContribution();
  const fetch: FetchLike = async (url, init) => contribution.handle(new Request(url, init), host);
  const transport = new StreamableHTTPClientTransport(new URL('http://codexia.test/api/projects/project-one/modules/mcp/streamable'), {
    fetch,
  });
  const client = new Client({ name: 'mcp-module-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

  try {
    await client.connect(transport);
    const search = await client.callTool({
      name: 'search',
      arguments: { project_id: 'project-one', query: 'memory', limit: 20 },
    });
    assert.equal(search.isError, true);
    assert.equal((search.structuredContent as { error: { code: string } }).error.code, 'MODULE_UNAVAILABLE');

    const diagnostics = await client.callTool({
      name: 'get_diagnostics',
      arguments: { project_id: 'project-one', scene_id: 'scene-one', text: 'draft' },
    });
    assert.equal(diagnostics.isError, undefined);
    assert.equal((diagnostics.structuredContent as { data: { tier: string } }).data.tier, 'full');
    assert.deepEqual((diagnostics.structuredContent as { data: { issues: unknown[] } }).data.issues, [
      { id: 'lint-1', kind: 'lint', severity: 'medium', message: 'source issue' },
    ]);
    assert.deepEqual(calls, ['diagnostics.scene']);
  } finally {
    await client.close().catch(() => undefined);
  }
});
